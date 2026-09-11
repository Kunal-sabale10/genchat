// Integration Test Suite: Message Revocation & Deletion ("Delete for Everyone" & "Delete for Me")
// Verifies:
// 1. Client-side local storage tombstoning and sensitive content zeroization
// 2. Zero-Knowledge search index pruning (deleted messages never returned in search)
// 3. Gateway WebSocket deletion relay (delete_message action -> message_deleted push frame)
// 4. Distinction between "everyone" (broadcast + tombstone) and "me" (local purge, no peer broadcast)
// 5. Live Gateway WebSocket roundtrip between provisioned users (Alice & Bob)

import assert from 'assert';
import crypto from 'crypto';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

console.log('=== Starting Message Revocation & Deletion Test Suite ===\n');

// -------------------------------------------------------------
// Part 1: Local Storage Tombstoning & Content Zeroization Logic
// -------------------------------------------------------------
console.log('--- Testing Client-Side Tombstoning & Zeroization ---');

function markMessageDeleted(messages, targetId, deletedBy, scope = 'everyone') {
  if (scope === 'me') {
    return messages.filter((m) => m.id !== targetId && m.clientMsgId !== targetId);
  }

  return messages.map((m) => {
    if (m.id === targetId || m.clientMsgId === targetId) {
      const tombstone = {
        ...m,
        isDeleted: true,
        deletedAt: Date.now(),
        deletedBy,
        deleteScope: 'everyone',
      };
      delete tombstone.text;
      delete tombstone.attachment;
      delete tombstone.replyTo;
      delete tombstone.reactions;
      return tombstone;
    }
    return m;
  });
}

function searchMessages(messages, term) {
  const clean = term.trim().toLowerCase();
  return messages
    .filter((m) => !m.isDeleted)
    .filter((m) => m.text && m.text.toLowerCase().includes(clean));
}

let mockMessages = [
  {
    id: 'msg_1',
    clientMsgId: 'cli_1',
    senderId: 'alice',
    text: 'Confidential secret password: 12345',
    attachment: { fileName: 'secret.pdf', blobId: 'blob_999' },
    reactions: { '👍': ['bob'] },
    status: 'delivered',
  },
  {
    id: 'msg_2',
    clientMsgId: 'cli_2',
    senderId: 'bob',
    text: 'Understood, keeping it safe.',
    status: 'delivered',
  },
];

// Search before deletion finds msg_1
let searchResults = searchMessages(mockMessages, 'secret');
assert.strictEqual(searchResults.length, 1, 'Search should locate confidential message before deletion');
assert.strictEqual(searchResults[0].id, 'msg_1');

// Execute "Delete for Everyone" on msg_1
mockMessages = markMessageDeleted(mockMessages, 'cli_1', 'alice', 'everyone');
const deletedMsg = mockMessages.find((m) => m.clientMsgId === 'cli_1');

assert(deletedMsg.isDeleted === true, 'Message must be marked isDeleted = true');
assert.strictEqual(deletedMsg.deleteScope, 'everyone', 'Delete scope must be everyone');
assert.strictEqual(deletedMsg.deletedBy, 'alice', 'deletedBy must match sender');
assert.strictEqual(deletedMsg.text, undefined, 'Sensitive plaintext text must be zeroized/deleted');
assert.strictEqual(deletedMsg.attachment, undefined, 'Sensitive attachment metadata must be zeroized/deleted');
assert.strictEqual(deletedMsg.reactions, undefined, 'Reactions must be cleared upon deletion');

// Search after deletion returns 0 results
searchResults = searchMessages(mockMessages, 'secret');
assert.strictEqual(searchResults.length, 0, 'Zero-Knowledge search must exclude tombstoned messages');

// Execute "Delete for Me" on msg_2
mockMessages = markMessageDeleted(mockMessages, 'msg_2', 'alice', 'me');
assert.strictEqual(mockMessages.find((m) => m.id === 'msg_2'), undefined, 'Delete for Me must permanently eradicate the message');
assert.strictEqual(mockMessages.length, 1, 'Only tombstone message remains');

console.log('✓ Client-side tombstoning, zeroization, and search pruning verified.\n');

// -------------------------------------------------------------
// Part 2: Live Gateway WebSocket Revocation Frame Relay
// -------------------------------------------------------------
console.log('--- Testing Live Gateway WebSocket Deletion Relay ---');

async function getDevToken(userId, displayName) {
  const res = await fetch(
    `${AUTH_HTTP_URL}/dev-token?user_id=${encodeURIComponent(userId)}&device_id=dev_${userId}&display_name=${encodeURIComponent(displayName)}`
  );
  if (!res.ok) {
    throw new Error(`Failed to get dev token for ${displayName}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${GATEWAY_WS_URL}/ws?token=${encodeURIComponent(token)}`);
    const queue = [];
    const listeners = [];

    ws.onmessage = async (event) => {
      try {
        const text = typeof event.data === 'string' ? event.data : await event.data.text();
        const parsed = JSON.parse(text);
        if (listeners.length > 0) {
          const fn = listeners.shift();
          fn(parsed);
        } else {
          queue.push(parsed);
        }
      } catch (err) {
        console.error('WS Parse Error:', err);
      }
    };

    ws.onopen = () => {
      resolve({
        ws,
        send(obj) {
          ws.send(JSON.stringify(obj));
        },
        close() {
          ws.close();
        },
        nextFrame(predicate, timeoutMs = 4000) {
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              rej(new Error(`Timeout waiting for frame matching predicate (received ${queue.length} in queue)`));
            }, timeoutMs);

            const checkQueue = () => {
              for (let i = 0; i < queue.length; i++) {
                if (!predicate || predicate(queue[i])) {
                  clearTimeout(timer);
                  const item = queue.splice(i, 1)[0];
                  return res(item);
                }
              }
              listeners.push((frame) => {
                if (!predicate || predicate(frame)) {
                  clearTimeout(timer);
                  res(frame);
                } else {
                  queue.push(frame);
                  checkQueue();
                }
              });
            };
            checkQueue();
          });
        },
      });
    };

    ws.onerror = (err) => reject(err);
  });
}

async function runLiveTests() {
  const aliceId = crypto.randomUUID();
  const bobId = crypto.randomUUID();

  console.log(`[Setup] Provisioning Alice (${aliceId}) and Bob (${bobId})...`);
  const aliceToken = await getDevToken(aliceId, 'Alice');
  const bobToken = await getDevToken(bobId, 'Bob');

  console.log('[Setup] Connecting Alice and Bob to Gateway WebSocket...');
  const aliceConn = await connectWs(aliceToken);
  const bobConn = await connectWs(bobToken);
  console.log('✓ Both WebSockets connected.');

  // Flow 1: Alice sends encrypted message to Bob
  const testMsgId = `test_msg_${Date.now()}`;
  console.log(`[Flow 1] Alice sending message (${testMsgId}) to Bob...`);
  aliceConn.send({
    action: 'send_message',
    channel_id: bobId,
    client_msg_id: testMsgId,
    ciphertext_base64: Buffer.from('ciphertext_payload_bytes').toString('base64'),
    message_type: 1,
  });

  const bobPush = await bobConn.nextFrame((f) => f.type === 'message' || f.type === 'push');
  assert(bobPush, 'Bob must receive message push frame');
  console.log(`✓ Bob received Alice's push frame`);

  // Flow 2: Alice sends "Delete for Everyone" for the message
  console.log(`[Flow 2] Alice revoking message (Delete for Everyone)...`);
  aliceConn.send({
    action: 'delete_message',
    channel_id: bobId,
    message_id: testMsgId,
    delete_scope: 'everyone',
  });

  // Alice receives ack_delete and echo message_deleted
  const [aliceAck, aliceEcho] = await Promise.all([
    aliceConn.nextFrame((f) => f.type === 'ack_delete'),
    aliceConn.nextFrame((f) => f.type === 'message_deleted'),
  ]);
  assert.strictEqual(aliceAck.message_id, testMsgId, 'ACK must contain target message ID');
  assert.strictEqual(aliceAck.delete_scope, 'everyone');
  assert.strictEqual(aliceEcho.message_id, testMsgId, 'Alice echo must contain target message ID');
  console.log('✓ Alice received ack_delete confirmation and instant echo');

  // Bob receives message_deleted push frame
  const bobDeletePush = await bobConn.nextFrame((f) => f.type === 'message_deleted');
  assert.strictEqual(bobDeletePush.message_id, testMsgId, 'Bob must receive message_deleted with matching message ID');
  assert.strictEqual(bobDeletePush.delete_scope, 'everyone');
  assert.strictEqual(bobDeletePush.sender_id, aliceId, 'Bob must identify deleter as Alice');
  console.log(`✓ Bob received message_deleted push frame from Alice`);

  // Flow 3: Bob sends "Delete for Me" on his end
  console.log(`[Flow 3] Bob sending Delete for Me...`);
  bobConn.send({
    action: 'delete_message',
    channel_id: aliceId,
    message_id: testMsgId,
    delete_scope: 'me',
  });

  const bobMeAck = await bobConn.nextFrame((f) => f.type === 'ack_delete');
  assert.strictEqual(bobMeAck.delete_scope, 'me');
  console.log('✓ Bob received ack_delete for Delete for Me');

  // Verify Alice does NOT receive any push frame for Bob's "Delete for Me"
  let aliceUnexpectedFrame = null;
  try {
    aliceUnexpectedFrame = await aliceConn.nextFrame((f) => f.type === 'message_deleted', 500);
  } catch {
    // Expected timeout!
  }
  assert.strictEqual(aliceUnexpectedFrame, null, 'Delete for Me must not dispatch push frames to peers');
  console.log('✓ Verified peer was not notified for Delete for Me');

  // Flow 4: Group Channel Revocation (chan_public)
  const channelMsgId = `chan_msg_${Date.now()}`;
  console.log(`[Flow 4] Alice sending and revoking message in chan_public...`);
  aliceConn.send({
    action: 'send_message',
    channel_id: 'chan_public',
    client_msg_id: channelMsgId,
    ciphertext_base64: Buffer.from('group_secret').toString('base64'),
    message_type: 1,
  });
  await bobConn.nextFrame((f) => f.channel_id === 'chan_public' && (f.type === 'message' || f.type === 'push'));

  aliceConn.send({
    action: 'delete_message',
    channel_id: 'chan_public',
    message_id: channelMsgId,
    delete_scope: 'everyone',
  });

  const [aliceChanAck, bobChanDelete] = await Promise.all([
    aliceConn.nextFrame((f) => f.type === 'ack_delete'),
    bobConn.nextFrame((f) => f.type === 'message_deleted' && f.channel_id === 'chan_public'),
  ]);

  assert.strictEqual(aliceChanAck.message_id, channelMsgId);
  assert.strictEqual(bobChanDelete.message_id, channelMsgId);
  console.log('✓ Group channel message_deleted broadcast verified across participants');

  aliceConn.close();
  bobConn.close();

  console.log('\n=== All Message Revocation & Deletion Tests Passed Successfully! ===');
}

runLiveTests().catch((err) => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
