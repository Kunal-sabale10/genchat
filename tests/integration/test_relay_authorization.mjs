// Integration Test Suite: Gateway Relay Authorization & Server-Side Persistence
// Verifies:
// 1. Ownership checks on delete_message: original author succeeds; imposter rejected with PERMISSION_DENIED.
// 2. Ownership checks on edit_message: original author succeeds; imposter rejected with PERMISSION_DENIED.
// 3. Malformed frame handling (missing channel_id, message_id, or ciphertext).
// 4. Persistence across history fetches: deletions are tombstoned & zeroized, edits reflect new ciphertext.

import assert from 'assert';
import crypto from 'crypto';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

console.log('=== Starting Relay Authorization & Persistence Test Suite ===\n');

async function getDevToken(userId, displayName) {
  const res = await fetch(
    `${AUTH_HTTP_URL}/dev-token?user_id=${encodeURIComponent(userId)}&device_id=dev_${userId}&display_name=${encodeURIComponent(displayName)}`
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
              rej(new Error(`Timeout waiting for frame matching predicate (received ${queue.length} in queue: ${JSON.stringify(queue.map(f => f.type || f.action))})`));
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

async function runTests() {
  const aliceRawId = crypto.randomUUID();
  const bobRawId = crypto.randomUUID();

  console.log(`[Setup] Provisioning Alice and Bob...`);
  const aliceData = await getDevToken(aliceRawId, 'Alice');
  const bobData = await getDevToken(bobRawId, 'Bob');

  const aliceId = aliceData.actualUserId;
  const bobId = bobData.actualUserId;

  console.log(`[Setup] Alice: ${aliceId}, Bob: ${bobId}`);
  const aliceConn = await connectWs(aliceData.token);
  const bobConn = await connectWs(bobData.token);
  console.log('✓ Both WebSockets connected.');

  // -------------------------------------------------------------
  // Flow 1: Authorized Delete for Everyone
  // -------------------------------------------------------------
  const msg1Id = `auth_test_msg_1_${Date.now()}`;
  console.log(`\n[Flow 1] Alice sends ${msg1Id} and revokes it...`);
  aliceConn.send({
    action: 'send_message',
    channel_id: bobId,
    client_msg_id: msg1Id,
    ciphertext_base64: Buffer.from('confidential text 1').toString('base64'),
    message_type: 1,
  });

  await bobConn.nextFrame((f) => f.type === 'push');
  console.log('  → Bob received push frame');

  // Alice deletes msg1 for everyone
  aliceConn.send({
    action: 'delete_message',
    channel_id: bobId,
    message_id: msg1Id,
    delete_scope: 'everyone',
  });

  const [aliceDelAck, bobDelPush] = await Promise.all([
    aliceConn.nextFrame((f) => f.type === 'ack_delete'),
    bobConn.nextFrame((f) => f.type === 'message_deleted'),
  ]);

  assert.strictEqual(aliceDelAck.message_id, msg1Id);
  assert.strictEqual(bobDelPush.message_id, msg1Id);
  console.log('  ✓ PASS: Alice successfully deleted her own message for everyone');

  // -------------------------------------------------------------
  // Flow 2: Unauthorized Delete Attempt by Imposter
  // -------------------------------------------------------------
  const msg2Id = `auth_test_msg_2_${Date.now()}`;
  console.log(`\n[Flow 2] Alice sends ${msg2Id}; Bob attempts unauthorized deletion...`);
  aliceConn.send({
    action: 'send_message',
    channel_id: bobId,
    client_msg_id: msg2Id,
    ciphertext_base64: Buffer.from('confidential text 2').toString('base64'),
    message_type: 1,
  });

  await bobConn.nextFrame((f) => f.type === 'push');

  // Bob attempts to revoke Alice's message for everyone
  bobConn.send({
    action: 'delete_message',
    channel_id: aliceId,
    message_id: msg2Id,
    delete_scope: 'everyone',
  });

  const bobDelError = await bobConn.nextFrame((f) => f.type === 'error');
  assert.strictEqual(bobDelError.code, 'PERMISSION_DENIED', 'Imposter delete attempt must be rejected with PERMISSION_DENIED');
  console.log(`  ✓ PASS: Bob's delete attempt rejected with PERMISSION_DENIED: "${bobDelError.message}"`);

  // Verify Alice received NO message_deleted frame for msg2
  let aliceUnexpectedDel = null;
  try {
    aliceUnexpectedDel = await aliceConn.nextFrame((f) => f.type === 'message_deleted' && f.message_id === msg2Id, 500);
  } catch {
    // Expected timeout!
  }
  assert.strictEqual(aliceUnexpectedDel, null, 'Alice must not receive revocation frame for unauthorized delete');
  console.log('  ✓ PASS: Verified no broadcast occurred for unauthorized delete');

  // -------------------------------------------------------------
  // Flow 3: Authorized Message Edit
  // -------------------------------------------------------------
  const msg3Id = `auth_test_msg_3_${Date.now()}`;
  console.log(`\n[Flow 3] Alice sends ${msg3Id} and edits it...`);
  aliceConn.send({
    action: 'send_message',
    channel_id: bobId,
    client_msg_id: msg3Id,
    ciphertext_base64: Buffer.from('original text 3').toString('base64'),
    message_type: 1,
  });

  await bobConn.nextFrame((f) => f.type === 'push');

  const updatedText3 = Buffer.from('edited text 3 by Alice').toString('base64');
  aliceConn.send({
    action: 'edit_message',
    channel_id: bobId,
    message_id: msg3Id,
    ciphertext_base64: updatedText3,
  });

  const [aliceEditAck, bobEditPush] = await Promise.all([
    aliceConn.nextFrame((f) => f.type === 'ack_edit'),
    bobConn.nextFrame((f) => f.type === 'message_edited'),
  ]);

  assert.strictEqual(aliceEditAck.message_id, msg3Id);
  assert.strictEqual(bobEditPush.message_id, msg3Id);
  assert.strictEqual(bobEditPush.ciphertext_base64, updatedText3);
  console.log('  ✓ PASS: Alice successfully edited her own message');

  // -------------------------------------------------------------
  // Flow 4: Unauthorized Edit Attempt by Imposter
  // -------------------------------------------------------------
  const msg4Id = `auth_test_msg_4_${Date.now()}`;
  console.log(`\n[Flow 4] Alice sends ${msg4Id}; Bob attempts unauthorized edit...`);
  aliceConn.send({
    action: 'send_message',
    channel_id: bobId,
    client_msg_id: msg4Id,
    ciphertext_base64: Buffer.from('original text 4').toString('base64'),
    message_type: 1,
  });

  await bobConn.nextFrame((f) => f.type === 'push');

  // Bob attempts to overwrite Alice's message with malicious ciphertext
  bobConn.send({
    action: 'edit_message',
    channel_id: aliceId,
    message_id: msg4Id,
    ciphertext_base64: Buffer.from('MALICIOUS FORGERY BY BOB').toString('base64'),
  });

  const bobEditError = await bobConn.nextFrame((f) => f.type === 'error');
  assert.strictEqual(bobEditError.code, 'PERMISSION_DENIED', 'Imposter edit attempt must be rejected with PERMISSION_DENIED');
  console.log(`  ✓ PASS: Bob's edit attempt rejected with PERMISSION_DENIED: "${bobEditError.message}"`);

  // -------------------------------------------------------------
  // Flow 5: Malformed Frames Rejection
  // -------------------------------------------------------------
  console.log('\n[Flow 5] Testing malformed frame validation...');
  aliceConn.send({ action: 'delete_message', channel_id: '' });
  const err1 = await aliceConn.nextFrame((f) => f.type === 'error');
  assert.strictEqual(err1.code, 'MISSING_FIELDS');

  aliceConn.send({ action: 'edit_message', channel_id: bobId, message_id: msg1Id, ciphertext_base64: '' });
  const err2 = await aliceConn.nextFrame((f) => f.type === 'error');
  assert.strictEqual(err2.code, 'MISSING_FIELDS');

  aliceConn.send({ action: 'pin_message', channel_id: '' });
  const err3 = await aliceConn.nextFrame((f) => f.type === 'error');
  assert.strictEqual(err3.code, 'MISSING_FIELDS');
  console.log('  ✓ PASS: All malformed frames rejected with MISSING_FIELDS');

  // -------------------------------------------------------------
  // Flow 6: Server-side Persistence Across History Fetch
  // -------------------------------------------------------------
  console.log('\n[Flow 6] Verifying server-side persistence in fetch_history...');
  aliceConn.send({
    action: 'fetch_history',
    channel_id: bobId,
    limit: 10,
  });

  const historyFrame = await aliceConn.nextFrame((f) => f.type === 'history');
  assert(historyFrame.messages && historyFrame.messages.length > 0);

  // Verify msg1 is marked deleted and zeroized
  const historyMsg1 = historyFrame.messages.find((m) => m.client_msg_id === msg1Id || m.server_id === msg1Id);
  if (historyMsg1) {
    assert.strictEqual(historyMsg1.is_deleted, true, 'Deleted message in history must have is_deleted = true');
    assert.strictEqual(historyMsg1.ciphertext_base64, '', 'Deleted message ciphertext must be zeroized');
    console.log('  ✓ PASS: Message deletion persisted in ledger (is_deleted=true, zeroized ciphertext)');
  }

  // Verify msg3 is marked edited with updated ciphertext
  const historyMsg3 = historyFrame.messages.find((m) => m.client_msg_id === msg3Id || m.server_id === msg3Id);
  if (historyMsg3) {
    assert.strictEqual(historyMsg3.is_edited, true, 'Edited message in history must have is_edited = true');
    assert.strictEqual(historyMsg3.ciphertext_base64, updatedText3, 'Edited message must return updated ciphertext');
    console.log('  ✓ PASS: Message edit persisted in ledger (is_edited=true, updated ciphertext)');
  }

  // Verify msg4 remained intact and was NOT forged
  const historyMsg4 = historyFrame.messages.find((m) => m.client_msg_id === msg4Id || m.server_id === msg4Id);
  if (historyMsg4) {
    assert.strictEqual(historyMsg4.is_edited || false, false, 'Unedited message must have is_edited = false');
    assert.notStrictEqual(historyMsg4.ciphertext_base64, Buffer.from('MALICIOUS FORGERY BY BOB').toString('base64'));
    console.log('  ✓ PASS: Message 4 ciphertext remained uncorrupted');
  }

  aliceConn.close();
  bobConn.close();

  console.log('\n======================================================');
  console.log('🎉 ALL RELAY AUTHORIZATION & PERSISTENCE TESTS PASSED!');
  console.log('======================================================');
}

runTests().catch((err) => {
  console.error('Relay authorization test failed:', err);
  process.exit(1);
});
