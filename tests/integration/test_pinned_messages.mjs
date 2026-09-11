// Integration Test Suite: Pinned Messages with Quick-Jump Navigation
// Verifies:
// 1. Client-side local storage pinning, unpinning, sorting by pinnedAt, and deletion safety
// 2. Live Gateway WebSocket roundtrip in 1:1 Direct Message (Alice pins -> Bob receives message_pinned push -> Alice receives ack_pin and echo)
// 3. Live Gateway WebSocket roundtrip unpinning (op: "unpin")
// 4. Group Channel Broadcast Pinning (chan_public)

import assert from 'assert';
import crypto from 'crypto';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

console.log('=== Starting Pinned Messages & Quick-Jump Navigation Test Suite ===\n');

// -------------------------------------------------------------
// Part 1: Client-Side Storage Mutation & Retrieval
// -------------------------------------------------------------
console.log('--- Part 1: Testing Client-Side Local Storage Mutation & Retrieval ---');

function updateMessagePinned(messages, targetId, isPinned, pinnedBy, pinnedAt = Date.now()) {
  return messages.map((m) => {
    if (m.id === targetId || m.clientMsgId === targetId) {
      return {
        ...m,
        isPinned,
        pinnedAt: isPinned ? pinnedAt : undefined,
        pinnedBy: isPinned ? pinnedBy : undefined,
      };
    }
    return m;
  });
}

function getPinnedMessages(messages) {
  return messages
    .filter((m) => m.isPinned && !m.isDeleted)
    .sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
}

function markMessageDeleted(messages, targetId) {
  return messages.map((m) => {
    if (m.id === targetId || m.clientMsgId === targetId) {
      const tombstone = {
        ...m,
        isDeleted: true,
        deletedAt: Date.now(),
        isPinned: false,
      };
      delete tombstone.text;
      delete tombstone.pinnedAt;
      delete tombstone.pinnedBy;
      return tombstone;
    }
    return m;
  });
}

let mockMessages = [
  {
    id: 'msg_201',
    clientMsgId: 'cli_201',
    senderId: 'alice',
    text: 'Important project deadline: Friday 5 PM',
    status: 'delivered',
  },
  {
    id: 'msg_202',
    clientMsgId: 'cli_202',
    senderId: 'bob',
    text: 'Zoom link for the standup',
    status: 'delivered',
  },
  {
    id: 'msg_203',
    clientMsgId: 'cli_203',
    senderId: 'alice',
    text: 'Lunch order options',
    status: 'delivered',
  },
];

// Initially no pinned messages
assert.strictEqual(getPinnedMessages(mockMessages).length, 0, 'Initially 0 pinned messages');

// Pin msg_201
const t1 = 1000;
mockMessages = updateMessagePinned(mockMessages, 'cli_201', true, 'alice', t1);
let pinned = getPinnedMessages(mockMessages);
assert.strictEqual(pinned.length, 1, 'Should have 1 pinned message');
assert.strictEqual(pinned[0].id, 'msg_201');
assert.strictEqual(pinned[0].pinnedBy, 'alice');
assert.strictEqual(pinned[0].pinnedAt, t1);

// Pin msg_202 with later timestamp
const t2 = 2000;
mockMessages = updateMessagePinned(mockMessages, 'msg_202', true, 'bob', t2);
pinned = getPinnedMessages(mockMessages);
assert.strictEqual(pinned.length, 2, 'Should have 2 pinned messages');
// Must be sorted descending by pinnedAt (msg_202 first, then msg_201)
assert.strictEqual(pinned[0].id, 'msg_202');
assert.strictEqual(pinned[1].id, 'msg_201');

// Unpin msg_201
mockMessages = updateMessagePinned(mockMessages, 'cli_201', false);
pinned = getPinnedMessages(mockMessages);
assert.strictEqual(pinned.length, 1, 'Should have 1 pinned message after unpinning');
assert.strictEqual(pinned[0].id, 'msg_202');

// Pin msg_203, then delete it to test deletion safety
mockMessages = updateMessagePinned(mockMessages, 'msg_203', true, 'alice', 3000);
assert.strictEqual(getPinnedMessages(mockMessages).length, 2);
mockMessages = markMessageDeleted(mockMessages, 'msg_203');
pinned = getPinnedMessages(mockMessages);
assert.strictEqual(pinned.length, 1, 'Deleted messages must never appear as pinned');
assert.strictEqual(pinned[0].id, 'msg_202');

console.log('✓ Client-side pinning, sorting, and deletion safety verified.\n');

// -------------------------------------------------------------
// Part 2: Live Gateway WebSocket Roundtrip (Alice & Bob DM)
// -------------------------------------------------------------
console.log('--- Part 2: Testing Live Gateway WebSocket 1:1 DM Pinning ---');

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
    // Flow 1: Alice sends initial message to Bob
    const testMsgId = `pin_test_${Date.now()}`;
    console.log(`[Flow 1] Alice sends initial message (${testMsgId}) to Bob...`);
    aliceConn.send({
      action: 'send_message',
      channel_id: bobId,
      client_msg_id: testMsgId,
      ciphertext_base64: Buffer.from('important_pinned_ciphertext').toString('base64'),
      message_type: 1,
    });

    const bobInitialPush = await bobConn.nextFrame((f) => f.type === 'message' || f.type === 'push');
    assert(bobInitialPush, 'Bob must receive Alice initial message');
    console.log(`✓ Bob received initial push frame`);

    // Flow 2: Alice pins the message
    console.log(`[Flow 2] Alice pins the message...`);
    aliceConn.send({
      action: 'pin_message',
      channel_id: bobId,
      message_id: testMsgId,
      op: 'pin',
    });

    // Alice receives ack_pin AND message_pinned echo
    const [aliceAck, aliceEcho] = await Promise.all([
      aliceConn.nextFrame((f) => f.type === 'ack_pin'),
      aliceConn.nextFrame((f) => f.type === 'message_pinned'),
    ]);

    assert(aliceAck, 'Alice must receive ack_pin frame');
    assert.strictEqual(aliceAck.message_id, testMsgId, 'ack_pin message_id must match');
    assert.strictEqual(aliceAck.channel_id, bobId, 'ack_pin channel_id must match');
    assert.strictEqual(aliceAck.op, 'pin', 'ack_pin op must be pin');
    console.log(`✓ Alice received ack_pin:`, aliceAck);

    assert(aliceEcho, 'Alice must receive message_pinned echo');
    assert.strictEqual(aliceEcho.message_id, testMsgId);
    assert.strictEqual(aliceEcho.op, 'pin');
    console.log(`✓ Alice received message_pinned echo:`, aliceEcho);

    // Bob receives message_pinned push frame
    const bobPinnedPush = await bobConn.nextFrame((f) => f.type === 'message_pinned');
    assert(bobPinnedPush, 'Bob must receive message_pinned frame');
    assert.strictEqual(bobPinnedPush.message_id, testMsgId);
    assert.strictEqual(bobPinnedPush.channel_id, bobId);
    assert.strictEqual(bobPinnedPush.sender_id, aliceId);
    assert.strictEqual(bobPinnedPush.op, 'pin');
    console.log(`✓ Bob received message_pinned push frame:`, bobPinnedPush);

    // -------------------------------------------------------------
    // Part 3: Live Gateway WebSocket 1:1 DM Unpinning (op: "unpin")
    // -------------------------------------------------------------
    console.log('\n--- Part 3: Testing Live Gateway WebSocket 1:1 DM Unpinning ---');
    console.log(`Alice unpins the message...`);
    aliceConn.send({
      action: 'pin_message',
      channel_id: bobId,
      message_id: testMsgId,
      op: 'unpin',
    });

    const [aliceUnpinAck, bobUnpinPush] = await Promise.all([
      aliceConn.nextFrame((f) => f.type === 'ack_pin'),
      bobConn.nextFrame((f) => f.type === 'message_pinned'),
    ]);

    assert.strictEqual(aliceUnpinAck.op, 'unpin', 'Alice ack_pin op must be unpin');
    assert.strictEqual(bobUnpinPush.op, 'unpin', 'Bob push op must be unpin');
    console.log(`✓ Alice received ack_pin with op: unpin`);
    console.log(`✓ Bob received message_pinned with op: unpin`);

    // -------------------------------------------------------------
    // Part 4: Group Channel Broadcast Pinning (chan_public)
    // -------------------------------------------------------------
    console.log('\n--- Part 4: Testing Group Channel Broadcast Pinning (chan_public) ---');
    const groupMsgId = `chan_pin_${Date.now()}`;
    console.log(`Alice broadcasting to chan_public (${groupMsgId})...`);
    aliceConn.send({
      action: 'send_message',
      channel_id: 'chan_public',
      client_msg_id: groupMsgId,
      ciphertext_base64: Buffer.from('public_pin_target').toString('base64'),
      message_type: 1,
    });

    const bobChanMsg = await bobConn.nextFrame((f) => f.type === 'message' || f.type === 'push');
    assert(bobChanMsg, 'Bob must receive message from chan_public');
    console.log(`✓ Bob received chan_public message`);

    console.log(`Alice pinning message on chan_public...`);
    aliceConn.send({
      action: 'pin_message',
      channel_id: 'chan_public',
      message_id: groupMsgId,
      op: 'pin',
    });

    const [aliceChanAck, bobChanPin] = await Promise.all([
      aliceConn.nextFrame((f) => f.type === 'ack_pin'),
      bobConn.nextFrame((f) => f.type === 'message_pinned'),
    ]);

    assert(aliceChanAck, 'Alice must receive ack_pin on chan_public');
    assert.strictEqual(aliceChanAck.message_id, groupMsgId);
    assert.strictEqual(aliceChanAck.op, 'pin');
    console.log(`✓ Alice received ack_pin for chan_public`);

    assert(bobChanPin, 'Bob must receive message_pinned on chan_public');
    assert.strictEqual(bobChanPin.message_id, groupMsgId);
    assert.strictEqual(bobChanPin.channel_id, 'chan_public');
    assert.strictEqual(bobChanPin.op, 'pin');
    console.log(`✓ Bob received message_pinned on chan_public`);

    console.log('\n=== ALL PINNED MESSAGES & QUICK-JUMP TESTS PASSED! ===');
  } finally {
    aliceConn.close();
    bobConn.close();
  }
}

runLiveTests().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
