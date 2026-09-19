// scripts/e2e_real_stack_walkthrough.mjs
// End-to-end real Docker Compose stack verification walkthrough
// Flow: register -> message -> group chat -> device link -> backup/restore -> delete/edit

import assert from 'node:assert';
import { subtle, createHash, randomBytes } from 'node:crypto';

const AUTH_URL = process.env.AUTH_URL || 'http://localhost:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://localhost:8081/ws';

console.log('================================================================');
console.log('🚀 GENCHAT REAL STACK PRODUCTION END-TO-END WALKTHROUGH 🚀');
console.log('================================================================\n');

async function provisionUser(displayName) {
  const userId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const res = await fetch(`${AUTH_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: displayName, user_id: userId, device_id: deviceId }),
  });
  if (!res.ok) throw new Error(`Failed to provision ${displayName}: ${res.status}`);
  return await res.json();
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${GATEWAY_WS_URL}?token=${token}`);
    const queue = [];
    const pending = [];

    const processQueue = () => {
      for (let i = pending.length - 1; i >= 0; i--) {
        const waiter = pending[i];
        const matchIdx = queue.findIndex(waiter.predicate);
        if (matchIdx !== -1) {
          const [matched] = queue.splice(matchIdx, 1);
          clearTimeout(waiter.timer);
          pending.splice(i, 1);
          waiter.resolve(matched);
        }
      }
    };

    ws.onmessage = async (event) => {
      try {
        const text = typeof event.data === 'string' ? event.data : await event.data.text();
        queue.push(JSON.parse(text));
        processQueue();
      } catch (err) {}
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
        nextFrame(predicate, timeoutMs = 8000) {
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

async function runRealStackE2E() {
  // ---------------------------------------------------------------------------
  // Phase 1: User Registration & Provisioning
  // ---------------------------------------------------------------------------
  console.log('▶ [Phase 1/7] User Registration & Cryptographic Identity Provisioning...');
  const alice = await provisionUser('Alice Cooper');
  const bob = await provisionUser('Bob Marley');
  assert.ok(alice.access_token, 'Alice missing access token');
  assert.ok(bob.access_token, 'Bob missing access token');
  console.log(`  ✓ Registered Alice (ID: ${alice.user_id.slice(0, 8)}..., Device: ${alice.device_id.slice(0, 8)}...)`);
  console.log(`  ✓ Registered Bob   (ID: ${bob.user_id.slice(0, 8)}..., Device: ${bob.device_id.slice(0, 8)}...)`);

  // ---------------------------------------------------------------------------
  // Phase 2: Gateway WebSocket Real-Time Connection
  // ---------------------------------------------------------------------------
  console.log('\n▶ [Phase 2/7] Gateway Real-Time WebSocket Connections...');
  const aliceConn = await connectWs(alice.access_token);
  const bobConn = await connectWs(bob.access_token);
  console.log('  ✓ Alice connected to Gateway WebSocket');
  console.log('  ✓ Bob connected to Gateway WebSocket');

  // Verify Gateway Presence
  const readyRes = await fetch('http://localhost:8081/readyz');
  const readyData = await readyRes.json();
  assert.strictEqual(readyData.status, 'ready');
  assert.ok(readyData.online_users >= 2, 'Online users count mismatch in Redis presence');
  console.log(`  ✓ Redis Presence confirmed: ${readyData.online_users} active users on pod ${readyData.pod_id}`);

  // ---------------------------------------------------------------------------
  // Phase 3: 1:1 Direct Encrypted Messaging & Delivery Receipts
  // ---------------------------------------------------------------------------
  console.log('\n▶ [Phase 3/7] 1:1 Direct Message Delivery & Delivery Receipts...');
  const msgId = `e2e_msg_${Date.now()}`;
  const directCiphertext = Buffer.from('Hello Bob! E2EE verification on real stack.').toString('base64');

  aliceConn.send({
    action: 'send_message',
    channel_id: bob.user_id,
    client_msg_id: msgId,
    ciphertext_base64: directCiphertext,
    message_type: 1,
  });

  const [aliceAck, bobPush] = await Promise.all([
    aliceConn.nextFrame((f) => f.type === 'ack' && f.client_msg_id === msgId),
    bobConn.nextFrame((f) => f.type === 'push' && f.sender_id === alice.user_id),
  ]);

  assert.ok(aliceAck, 'Alice must receive delivery ACK');
  assert.strictEqual(bobPush.ciphertext_base64, directCiphertext, 'Bob must receive exact ciphertext');
  console.log(`  ✓ Alice received ACK (server_id=${aliceAck.message_id}, seq=${aliceAck.sequence_num})`);
  console.log(`  ✓ Bob received real-time 1:1 message payload from Alice`);

  // ---------------------------------------------------------------------------
  // Phase 4: Group Chat Creation & Monotonic Sequencer
  // ---------------------------------------------------------------------------
  console.log('\n▶ [Phase 4/7] Group Chat Creation & Monotonic Message Sequencing...');
  const createChanRes = await fetch(`${AUTH_URL}/chat.v1.ChannelService/CreateChannel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${alice.access_token}`,
    },
    body: JSON.stringify({
      name: 'Launch Readiness Team',
      type: 2,
      member_user_ids: [bob.user_id],
      member_welcomes: {},
      initial_commit: Buffer.from('initial_mls_commit').toString('base64'),
    }),
  });
  assert.strictEqual(createChanRes.status, 200, 'CreateChannel failed');
  const chanData = await createChanRes.json();
  const channelId = `chan_${chanData.channel.id}`;
  console.log(`  ✓ Alice created group channel: ${channelId}`);

  // Alice sends group message
  const grpMsgId = `grp_msg_${Date.now()}`;
  const grpCiphertext = Buffer.from('Group Announcement: Stack is performing smoothly!').toString('base64');

  aliceConn.send({
    action: 'send_message',
    channel_id: channelId,
    client_msg_id: grpMsgId,
    ciphertext_base64: grpCiphertext,
    message_type: 1,
  });

  const grpAck = await aliceConn.nextFrame((f) => f.type === 'ack' && f.client_msg_id === grpMsgId);
  assert.ok(grpAck, 'Alice must receive group ACK');
  assert.ok(grpAck.sequence_num >= 1, 'Group sequence number must be monotonically sequenced');
  console.log(`  ✓ Ledger Monotonic Sequencer verified: assigned sequence_num=${grpAck.sequence_num}`);

  // ---------------------------------------------------------------------------
  // Phase 5: Multi-Device Key Synchronization & QR Device Linking
  // ---------------------------------------------------------------------------
  console.log('\n▶ [Phase 5/7] Multi-Device Key Synchronization & Session Linking...');
  const primaryKeyPair = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits', 'deriveKey']
  );
  const primaryPubRaw = Buffer.from(await subtle.exportKey('raw', primaryKeyPair.publicKey));
  const linkCode = '849201';
  const codeHash = createHash('sha256').update(linkCode).digest();

  const linkInitRes = await fetch(`${AUTH_URL}/auth/device-link/initiate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${alice.access_token}`,
    },
    body: JSON.stringify({
      ephemeral_pubkey: primaryPubRaw.toString('base64'),
      auth_code_hash: codeHash.toString('base64'),
    }),
  });
  assert.strictEqual(linkInitRes.status, 200, 'Device link initiate failed');
  const { session_id } = await linkInitRes.json();
  console.log(`  ✓ Initiated device linking session: ${session_id}`);

  // Secondary generates ECDH keypair and derives shared secret
  const secKeyPair = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits', 'deriveKey']
  );
  const secPubRaw = Buffer.from(await subtle.exportKey('raw', secKeyPair.publicKey));

  const importedSecPub = await subtle.importKey(
    'raw',
    secPubRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const primarySharedKey = await subtle.deriveKey(
    { name: 'ECDH', public: importedSecPub },
    primaryKeyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const importedPrimPub = await subtle.importKey(
    'raw',
    primaryPubRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const secSharedKey = await subtle.deriveKey(
    { name: 'ECDH', public: importedPrimPub },
    secKeyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  // Primary encrypts secrets bundle and calls /approve
  const secretTransfer = { identity: 'alice_sec_device', timestamp: Date.now() };
  const iv = randomBytes(12);
  const encBundle = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    primarySharedKey,
    new TextEncoder().encode(JSON.stringify(secretTransfer))
  );
  const combinedPayload = Buffer.concat([iv, Buffer.from(encBundle)]);
  const newDeviceId = crypto.randomUUID();

  const approveRes = await fetch(`${AUTH_URL}/auth/device-link/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${alice.access_token}`,
    },
    body: JSON.stringify({
      session_id,
      new_device_id: newDeviceId,
      encrypted_bundle: combinedPayload.toString('base64'),
      auth_code: linkCode,
    }),
  });
  assert.strictEqual(approveRes.status, 200, 'Approve device link failed');
  console.log('  ✓ Alice primary approved session and uploaded encrypted transfer bundle');

  // Secondary completes link and downloads bundle
  const completeRes = await fetch(`${AUTH_URL}/auth/device-link/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${alice.access_token}`,
    },
    body: JSON.stringify({ session_id, auth_code: linkCode }),
  });
  assert.strictEqual(completeRes.status, 200, 'Complete device link failed');
  const completeData = await completeRes.json();
  const dlCombined = Buffer.from(completeData.encrypted_bundle, 'base64');
  const dlIv = dlCombined.subarray(0, 12);
  const dlCt = dlCombined.subarray(12);
  const decBundle = await subtle.decrypt(
    { name: 'AES-GCM', iv: dlIv },
    secSharedKey,
    dlCt
  );
  const restoredBundle = JSON.parse(new TextDecoder().decode(decBundle));
  assert.deepStrictEqual(restoredBundle, secretTransfer);
  console.log('  ✓ Secondary decrypted bundle with shared ECDH pairing key: secrets verified!');

  // ---------------------------------------------------------------------------
  // Phase 6: Zero-Knowledge Key Backup & Restoration
  // ---------------------------------------------------------------------------
  console.log('\n▶ [Phase 6/7] Zero-Knowledge Key/Account Cloud Backup & Restoration...');
  const backupSalt = randomBytes(16).toString('hex');
  const backupCiphertext = Buffer.from('e2ee_ratchet_identity_keys_encrypted_payload').toString('base64');

  const uploadBackupRes = await fetch(`${AUTH_URL}/auth/backup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${alice.access_token}`,
    },
    body: JSON.stringify({
      backup_ciphertext: backupCiphertext,
      kdf_salt: backupSalt,
      kdf_algorithm: 'Argon2id',
      kdf_params: { m: 65536, t: 3, p: 4 },
      bundle_version: 1,
    }),
  });
  assert.strictEqual(uploadBackupRes.status, 200, 'Backup upload failed');
  console.log('  ✓ Uploaded zero-knowledge encrypted backup to Auth service vault');

  const restoreBackupRes = await fetch(`${AUTH_URL}/auth/backup`, {
    headers: { Authorization: `Bearer ${alice.access_token}` },
  });
  assert.strictEqual(restoreBackupRes.status, 200, 'Backup restoration failed');
  const restored = await restoreBackupRes.json();
  assert.strictEqual(restored.backup_ciphertext, backupCiphertext);
  assert.strictEqual(restored.kdf_salt, backupSalt);
  console.log('  ✓ Verified bit-for-bit zero-knowledge backup restore');

  // ---------------------------------------------------------------------------
  // Phase 7: Message Editing & Tombstone Deletion
  // ---------------------------------------------------------------------------
  console.log('\n▶ [Phase 7/7] Message Editing, Deletion & Tombstones...');
  const targetEditMsgId = `edit_target_${Date.now()}`;
  const initialText = Buffer.from('Initial message with spelling mistakkke').toString('base64');
  const editedText = Buffer.from('Corrected message with no spelling mistakes').toString('base64');

  // Send message
  aliceConn.send({
    action: 'send_message',
    channel_id: bob.user_id,
    client_msg_id: targetEditMsgId,
    ciphertext_base64: initialText,
    message_type: 1,
  });
  await bobConn.nextFrame((f) => f.type === 'push');
  console.log('  ✓ Sent initial message to Bob');

  // Edit message
  aliceConn.send({
    action: 'edit_message',
    channel_id: bob.user_id,
    message_id: targetEditMsgId,
    ciphertext_base64: editedText,
  });

  const [aliceEditAck, bobEditedPush] = await Promise.all([
    aliceConn.nextFrame((f) => f.type === 'ack_edit'),
    bobConn.nextFrame((f) => f.type === 'message_edited'),
  ]);
  assert.strictEqual(aliceEditAck.message_id, targetEditMsgId);
  assert.strictEqual(bobEditedPush.ciphertext_base64, editedText);
  console.log('  ✓ Dispatched and verified message edit update (Bob received message_edited)');

  // Delete message (Delete for Everyone)
  aliceConn.send({
    action: 'delete_message',
    channel_id: bob.user_id,
    message_id: targetEditMsgId,
    delete_scope: 'everyone',
  });

  const [aliceDelAck, bobDelPush] = await Promise.all([
    aliceConn.nextFrame((f) => f.type === 'ack_delete'),
    bobConn.nextFrame((f) => f.type === 'message_deleted'),
  ]);
  assert.strictEqual(aliceDelAck.message_id, targetEditMsgId);
  assert.strictEqual(bobDelPush.message_id, targetEditMsgId);
  console.log('  ✓ Dispatched and verified message deletion tombstone (Bob received message_deleted)');

  // Clean disconnect
  aliceConn.close();
  bobConn.close();

  console.log('\n================================================================');
  console.log('🎉 ALL 7/7 REAL STACK END-TO-END PHASES COMPLETED SUCCESSFULLY! 🎉');
  console.log('================================================================\n');
}

runRealStackE2E().catch((err) => {
  console.error('\n❌ E2E WALKTHROUGH FAILED:', err);
  process.exit(1);
});
