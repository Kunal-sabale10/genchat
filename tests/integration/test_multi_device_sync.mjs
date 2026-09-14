// Integration Test Suite: Multi-Device Persistence & Event Synchronization
// Verifies:
// 1. Two distinct devices on the same user account (Alice-Phone and Alice-Laptop).
// 2. Alice-Phone sends messages to Bob, then performs Delete-for-Everyone, Edit, and Pin.
// 3. Events are durably persisted in msgledger via RecordMessageEvent.
// 4. Alice-Laptop connects subsequently, calls fetch_history, and verifies:
//    - Deleted message is tombstoned and ciphertext is zeroized.
//    - Edited message reflects the updated ciphertext.
//    - Pinned message reflects is_pinned = true.

import assert from 'assert';
import crypto from 'crypto';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

console.log('=== Starting Multi-Device Persistence & Event Sync Test Suite ===\n');

async function getDevToken(userId, deviceId, displayName) {
  const res = await fetch(
    `${AUTH_HTTP_URL}/dev-token?user_id=${encodeURIComponent(userId)}&device_id=${encodeURIComponent(deviceId)}&display_name=${encodeURIComponent(displayName)}`
  );
  if (!res.ok) {
    throw new Error(`Failed to get dev token for ${displayName}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return { token: data.access_token, actualUserId: data.user_id || userId };
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
        nextFrame(predicate, timeoutMs = 5000) {
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
              rej(new Error(`Timeout waiting for frame (queued: ${JSON.stringify(queue.map(f => f.type || f.action))})`));
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

async function run() {
  const aliceUserId = crypto.randomUUID();
  const bobUserId = crypto.randomUUID();
  const alicePhoneDeviceId = crypto.randomUUID();
  const aliceLaptopDeviceId = crypto.randomUUID();
  const bobPhoneDeviceId = crypto.randomUUID();

  console.log(`[Setup] Provisioning Alice-Phone, Alice-Laptop, and Bob-Phone...`);
  const alicePhoneAuth = await getDevToken(aliceUserId, alicePhoneDeviceId, 'Alice Phone');
  const aliceLaptopAuth = await getDevToken(aliceUserId, aliceLaptopDeviceId, 'Alice Laptop');
  const bobPhoneAuth = await getDevToken(bobUserId, bobPhoneDeviceId, 'Bob Phone');

  assert.strictEqual(alicePhoneAuth.actualUserId, aliceLaptopAuth.actualUserId, 'Both Alice devices must share the same user_id');
  console.log(`✓ Verified accounts: Alice (${aliceUserId}), Bob (${bobUserId})\n`);

  console.log('[Step 1] Connecting Alice-Phone and Bob-Phone to Gateway WebSocket...');
  const alicePhoneWs = await connectWs(alicePhoneAuth.token);
  const bobPhoneWs = await connectWs(bobPhoneAuth.token);
  console.log('✓ Alice-Phone and Bob-Phone connected\n');

  // Send Message 1 (to be deleted)
  console.log('[Step 2] Alice-Phone sending Message 1 (Delete candidate)...');
  const msg1ClientId = `cmsg_del_${Date.now()}`;
  const msg1Ciphertext = Buffer.from('Secret message to be deleted').toString('base64');
  alicePhoneWs.send({
    action: 'send_message',
    channel_id: bobUserId,
    client_msg_id: msg1ClientId,
    ciphertext_base64: msg1Ciphertext,
  });

  const ack1 = await alicePhoneWs.nextFrame(f => f.type === 'ack' && f.client_msg_id === msg1ClientId);
  const msg1ServerId = ack1.message_id || ack1.server_id;
  assert.ok(msg1ServerId, 'Message 1 must receive server_id');
  console.log(`✓ Message 1 sent and ACKed: server_id=${msg1ServerId}`);

  // Send Message 2 (to be edited)
  console.log('\n[Step 3] Alice-Phone sending Message 2 (Edit candidate)...');
  const msg2ClientId = `cmsg_edit_${Date.now()}`;
  const msg2InitialText = Buffer.from('Original content before edit').toString('base64');
  alicePhoneWs.send({
    action: 'send_message',
    channel_id: bobUserId,
    client_msg_id: msg2ClientId,
    ciphertext_base64: msg2InitialText,
  });

  const ack2 = await alicePhoneWs.nextFrame(f => f.type === 'ack' && f.client_msg_id === msg2ClientId);
  const msg2ServerId = ack2.message_id || ack2.server_id;
  assert.ok(msg2ServerId, 'Message 2 must receive server_id');
  console.log(`✓ Message 2 sent and ACKed: server_id=${msg2ServerId}`);

  // Send Message 3 (to be pinned)
  console.log('\n[Step 4] Alice-Phone sending Message 3 (Pin candidate)...');
  const msg3ClientId = `cmsg_pin_${Date.now()}`;
  const msg3Text = Buffer.from('Important announcement to be pinned').toString('base64');
  alicePhoneWs.send({
    action: 'send_message',
    channel_id: bobUserId,
    client_msg_id: msg3ClientId,
    ciphertext_base64: msg3Text,
  });

  const ack3 = await alicePhoneWs.nextFrame(f => f.type === 'ack' && f.client_msg_id === msg3ClientId);
  const msg3ServerId = ack3.message_id || ack3.server_id;
  assert.ok(msg3ServerId, 'Message 3 must receive server_id');
  console.log(`✓ Message 3 sent and ACKed: server_id=${msg3ServerId}`);

  // Flow 2: Alice-Phone deletes Message 1 for everyone
  console.log('\n[Step 5] Alice-Phone deleting Message 1 for everyone...');
  alicePhoneWs.send({
    action: 'delete_message',
    channel_id: bobUserId,
    message_id: msg1ServerId,
    delete_scope: 'everyone',
  });

  const ackDel = await alicePhoneWs.nextFrame(f => f.type === 'ack_delete' && f.message_id === msg1ServerId);
  assert.strictEqual(ackDel.message_id, msg1ServerId);
  console.log(`✓ Delete-for-everyone processed and ACKed`);

  // Flow 3: Alice-Phone edits Message 2
  console.log('\n[Step 6] Alice-Phone editing Message 2 with updated ciphertext...');
  const msg2EditedCiphertext = Buffer.from('REVISED and edited content').toString('base64');
  alicePhoneWs.send({
    action: 'edit_message',
    channel_id: bobUserId,
    message_id: msg2ServerId,
    ciphertext_base64: msg2EditedCiphertext,
  });

  const ackEdit = await alicePhoneWs.nextFrame(f => f.type === 'ack_edit' && f.message_id === msg2ServerId);
  assert.strictEqual(ackEdit.message_id, msg2ServerId);
  console.log(`✓ Message edit processed and ACKed`);

  // Flow 4: Alice-Phone pins Message 3
  console.log('\n[Step 7] Alice-Phone pinning Message 3...');
  alicePhoneWs.send({
    action: 'pin_message',
    channel_id: bobUserId,
    message_id: msg3ServerId,
    op: 'pin',
  });

  const ackPin = await alicePhoneWs.nextFrame(f => f.type === 'ack_pin' && f.message_id === msg3ServerId);
  assert.strictEqual(ackPin.message_id, msg3ServerId);
  assert.strictEqual(ackPin.op, 'pin');
  console.log(`✓ Message pin processed and ACKed`);

  // Disconnect Alice-Phone to prove Alice-Laptop connects independently
  alicePhoneWs.close();
  bobPhoneWs.close();
  console.log('\n[Step 8] Closed primary devices. Connecting second device (Alice-Laptop)...');

  // Small pause to allow Scylla durable flush
  await new Promise(r => setTimeout(r, 600));

  const aliceLaptopWs = await connectWs(aliceLaptopAuth.token);
  console.log('✓ Alice-Laptop connected to Gateway WebSocket');

  console.log('\n[Step 9] Alice-Laptop fetching history for conversation with Bob...');
  aliceLaptopWs.send({
    action: 'fetch_history',
    channel_id: bobUserId,
    limit: 50,
  });

  const historyFrame = await aliceLaptopWs.nextFrame(f => f.type === 'history');
  assert.ok(historyFrame.messages && historyFrame.messages.length >= 3, 'History must contain all sent messages');
  console.log(`✓ Received history with ${historyFrame.messages.length} messages`);

  const fetchedMsg1 = historyFrame.messages.find(m => m.server_id === msg1ServerId || m.client_msg_id === msg1ClientId);
  const fetchedMsg2 = historyFrame.messages.find(m => m.server_id === msg2ServerId || m.client_msg_id === msg2ClientId);
  const fetchedMsg3 = historyFrame.messages.find(m => m.server_id === msg3ServerId || m.client_msg_id === msg3ClientId);

  assert.ok(fetchedMsg1, 'Message 1 must be present in history');
  assert.ok(fetchedMsg2, 'Message 2 must be present in history');
  assert.ok(fetchedMsg3, 'Message 3 must be present in history');

  console.log('\n[Step 10] Verifying Multi-Device Persisted States:');

  // Verify Deletion Tombstone & Ciphertext Zeroization
  console.log('  1. Verifying Message 1 Deletion Tombstone & Zeroization...');
  assert.strictEqual(fetchedMsg1.is_deleted, true, 'Message 1 must have is_deleted: true');
  assert.strictEqual(fetchedMsg1.ciphertext_base64, '', 'Message 1 ciphertext must be zeroized/empty');
  console.log('     ✓ Message 1 is tombstoned and ciphertext zeroized on Alice-Laptop');

  // Verify Edit Ciphertext Sync
  console.log('  2. Verifying Message 2 Edit Ciphertext Sync...');
  assert.strictEqual(fetchedMsg2.is_edited, true, 'Message 2 must have is_edited: true');
  assert.strictEqual(fetchedMsg2.ciphertext_base64, msg2EditedCiphertext, 'Message 2 must reflect edited ciphertext');
  console.log('     ✓ Message 2 reflects edited ciphertext on Alice-Laptop');

  // Verify Pin State Sync
  console.log('  3. Verifying Message 3 Pin State Sync...');
  assert.strictEqual(fetchedMsg3.is_pinned, true, 'Message 3 must have is_pinned: true');
  console.log('     ✓ Message 3 reflects is_pinned: true on Alice-Laptop');

  aliceLaptopWs.close();
  console.log('\n=== ALL MULTI-DEVICE PERSISTENCE & EVENT SYNC TESTS PASSED ===');
}

run().catch((err) => {
  console.error('\n❌ Multi-Device Sync Test Failed:', err);
  process.exit(1);
});
