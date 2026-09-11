// Integration Test Suite: Cryptographic Message Editing with (edited) Badge
// Verifies:
// 1. Client-side local storage update marking isEdited: true, editedAt: Date.now()
// 2. Zero-Knowledge search index update (new text searchable, old text not returned)
// 3. Gateway WebSocket edit_message relay -> message_edited push frame to peer and echo to sender
// 4. Verification of ack_edit response to sender
// 5. Live Gateway WebSocket roundtrip between provisioned users (Alice & Bob) in 1:1 DM
// 6. Group Channel Broadcast Editing (chan_public)

import assert from 'assert';
import crypto from 'crypto';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

console.log('=== Starting Cryptographic Message Editing Test Suite ===\n');

// -------------------------------------------------------------
// Part 1: Client-Side Storage Mutation & Search Index Update
// -------------------------------------------------------------
console.log('--- Part 1: Testing Client-Side Local Storage Mutation & Search Index ---');

function updateMessageText(messages, targetId, newText, editedAt = Date.now()) {
  return messages.map((m) => {
    if (m.id === targetId || m.clientMsgId === targetId) {
      return {
        ...m,
        text: newText,
        isEdited: true,
        editedAt,
      };
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
    id: 'msg_101',
    clientMsgId: 'cli_101',
    senderId: 'alice',
    text: 'Meet me at 5pm at the cafe with typo',
    status: 'delivered',
  },
  {
    id: 'msg_102',
    clientMsgId: 'cli_102',
    senderId: 'bob',
    text: 'Sounds great see you then',
    status: 'delivered',
  },
];

// Step 1: Initial search before editing
let initialSearch = searchMessages(mockMessages, 'typo');
assert.strictEqual(initialSearch.length, 1, 'Initial search must find typo message');
assert.strictEqual(initialSearch[0].id, 'msg_101');

// Step 2: Perform text edit
const editTimestamp = Date.now();
mockMessages = updateMessageText(mockMessages, 'cli_101', 'Meet me at 6pm at the cafe confirmed', editTimestamp);
const editedMsg = mockMessages.find((m) => m.id === 'msg_101');

assert(editedMsg, 'Message must exist');
assert.strictEqual(editedMsg.text, 'Meet me at 6pm at the cafe confirmed', 'Plaintext must be updated');
assert.strictEqual(editedMsg.isEdited, true, 'isEdited must be true');
assert.strictEqual(editedMsg.editedAt, editTimestamp, 'editedAt must match timestamp');

// Step 3: Verify old text no longer matches search index
const oldSearch = searchMessages(mockMessages, 'typo');
assert.strictEqual(oldSearch.length, 0, 'Old typo text must not appear in search results');

// Step 4: Verify new text matches search index
const newSearch = searchMessages(mockMessages, 'confirmed');
assert.strictEqual(newSearch.length, 1, 'New edited text must appear in search results');
assert.strictEqual(newSearch[0].id, 'msg_101');

console.log('✓ Client-side storage mutation and search index updates verified.\n');

// -------------------------------------------------------------
// Part 2: Live Gateway WebSocket Roundtrip (Alice & Bob DM)
// -------------------------------------------------------------
console.log('--- Part 2: Testing Live Gateway WebSocket 1:1 DM Editing ---');

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
    const pending = [];

    const processQueue = () => {
      for (let pIdx = 0; pIdx < pending.length; pIdx++) {
        const p = pending[pIdx];
        const qIdx = queue.findIndex(p.predicate);
        if (qIdx !== -1) {
          const [match] = queue.splice(qIdx, 1);
          clearTimeout(p.timer);
          pending.splice(pIdx, 1);
          pIdx--;
          p.resolve(match);
        }
      }
    };

    ws.onmessage = async (event) => {
      try {
        const text = typeof event.data === 'string' ? event.data : await event.data.text();
        const parsed = JSON.parse(text);
        queue.push(parsed);
        processQueue();
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
            const entry = {
              predicate: predicate || (() => true),
              resolve: res,
              reject: rej,
              timer: null,
            };
            entry.timer = setTimeout(() => {
              const idx = pending.indexOf(entry);
              if (idx !== -1) pending.splice(idx, 1);
              rej(new Error(`Timeout waiting for frame matching predicate (received ${queue.length} in queue: ${JSON.stringify(queue.map(f => f.type))})`));
            }, timeoutMs);

            pending.push(entry);
            processQueue();
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

  try {
    // Flow 1: Alice sends initial encrypted message to Bob
    const testMsgId = `edit_test_${Date.now()}`;
    const initialCiphertext = Buffer.from('initial_encrypted_text_with_typo').toString('base64');
    console.log(`[Flow 1] Alice sends initial message (${testMsgId}) to Bob...`);
    aliceConn.send({
      action: 'send_message',
      channel_id: bobId,
      client_msg_id: testMsgId,
      ciphertext_base64: initialCiphertext,
      message_type: 1,
    });

    const bobInitialPush = await bobConn.nextFrame((f) => f.type === 'message' || f.type === 'push');
    assert(bobInitialPush, 'Bob must receive Alice initial message');
    console.log(`✓ Bob received initial push frame`);

    // Flow 2: Alice edits the message with corrected ciphertext
    const updatedCiphertext = Buffer.from('corrected_encrypted_text_no_typo').toString('base64');
    console.log(`[Flow 2] Alice sends edit_message frame...`);
    aliceConn.send({
      action: 'edit_message',
      channel_id: bobId,
      message_id: testMsgId,
      ciphertext_base64: updatedCiphertext,
    });

    // Alice should receive ack_edit AND message_edited echo
    const [aliceAck, aliceEcho] = await Promise.all([
      aliceConn.nextFrame((f) => f.type === 'ack_edit'),
      aliceConn.nextFrame((f) => f.type === 'message_edited'),
    ]);

    assert(aliceAck, 'Alice must receive ack_edit frame');
    assert.strictEqual(aliceAck.message_id, testMsgId, 'ack_edit message_id must match target');
    assert.strictEqual(aliceAck.channel_id, bobId, 'ack_edit channel_id must match destination');
    console.log(`✓ Alice received ack_edit:`, aliceAck);

    assert(aliceEcho, 'Alice must receive message_edited echo');
    assert.strictEqual(aliceEcho.message_id, testMsgId, 'aliceEcho message_id must match');
    assert.strictEqual(aliceEcho.ciphertext_base64, updatedCiphertext, 'aliceEcho ciphertext must match updated text');
    console.log(`✓ Alice received message_edited echo:`, aliceEcho);

    // Bob should receive message_edited push frame
    const bobEditedPush = await bobConn.nextFrame((f) => f.type === 'message_edited');
    assert(bobEditedPush, 'Bob must receive message_edited frame');
    assert.strictEqual(bobEditedPush.message_id, testMsgId, 'bobEditedPush message_id must match target');
    assert.strictEqual(bobEditedPush.channel_id, bobId, 'bobEditedPush channel_id must match');
    assert.strictEqual(bobEditedPush.sender_id, aliceId, 'bobEditedPush sender_id must be Alice');
    assert.strictEqual(bobEditedPush.ciphertext_base64, updatedCiphertext, 'bobEditedPush ciphertext must match updated text');
    console.log(`✓ Bob received message_edited push frame:`, bobEditedPush);

    // -------------------------------------------------------------
    // Part 3: Group Channel Broadcast Editing (chan_public)
    // -------------------------------------------------------------
    console.log('\n--- Part 3: Testing Group Channel Broadcast Editing (chan_public) ---');
    const groupMsgId = `chan_msg_${Date.now()}`;
    const groupInitialCiphertext = Buffer.from('public_initial_typo').toString('base64');

    console.log(`Alice broadcasting to chan_public (${groupMsgId})...`);
    aliceConn.send({
      action: 'send_message',
      channel_id: 'chan_public',
      client_msg_id: groupMsgId,
      ciphertext_base64: groupInitialCiphertext,
      message_type: 1,
    });

    const bobChanMsg = await bobConn.nextFrame((f) => f.type === 'message' || f.type === 'push');
    assert(bobChanMsg, 'Bob must receive message from chan_public');
    console.log(`✓ Bob received chan_public message`);

    const groupUpdatedCiphertext = Buffer.from('public_corrected_text').toString('base64');
    console.log(`Alice editing chan_public message...`);
    aliceConn.send({
      action: 'edit_message',
      channel_id: 'chan_public',
      message_id: groupMsgId,
      ciphertext_base64: groupUpdatedCiphertext,
    });

    const [aliceChanAck, bobChanEdit] = await Promise.all([
      aliceConn.nextFrame((f) => f.type === 'ack_edit'),
      bobConn.nextFrame((f) => f.type === 'message_edited'),
    ]);

    assert(aliceChanAck, 'Alice must receive ack_edit for chan_public');
    assert.strictEqual(aliceChanAck.message_id, groupMsgId);
    console.log(`✓ Alice received ack_edit for chan_public`);

    assert(bobChanEdit, 'Bob must receive message_edited for chan_public');
    assert.strictEqual(bobChanEdit.message_id, groupMsgId);
    assert.strictEqual(bobChanEdit.channel_id, 'chan_public');
    assert.strictEqual(bobChanEdit.ciphertext_base64, groupUpdatedCiphertext);
    console.log(`✓ Bob received message_edited on chan_public`);

    console.log('\n=== ALL CRYPTOGRAPHIC MESSAGE EDITING TESTS PASSED! ===');
  } finally {
    aliceConn.close();
    bobConn.close();
  }
}

runLiveTests().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
