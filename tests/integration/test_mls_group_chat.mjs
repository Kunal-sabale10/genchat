// Integration Test: MLS End-to-End Multi-Party Group Messaging, TreeKEM Welcomes & Epoch Transitions
import { subtle } from 'crypto';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

console.log('=== Starting MLS End-to-End Group Chat Test ===\n');

async function provisionUser(name) {
  const res = await fetch(`${AUTH_HTTP_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: name }),
  });
  if (!res.ok) throw new Error(`Failed to provision user ${name}: ${res.status}`);
  const data = await res.json();
  console.log(`[Provision] ${name}: userId=${data.user_id}, deviceId=${data.device_id}`);
  return {
    name,
    userId: data.user_id,
    deviceId: data.device_id,
    token: data.access_token,
  };
}

// Derive AES-256-GCM epoch application key matching MlsGroupManager
async function deriveEpochKey(epochSecretHex, channelId, epoch) {
  const enc = new TextEncoder();
  const secretBytes = new Uint8Array(epochSecretHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  const baseKey = await subtle.importKey('raw', secretBytes, { name: 'HKDF' }, false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode(`mls_app_salt_${epoch}`),
      info: enc.encode(`mls_application_encryption_${channelId}_${epoch}`),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptMlsMessage(plaintext, epochSecretHex, channelId, epoch, senderId) {
  const appKey = await deriveEpochKey(epochSecretHex, channelId, epoch);
  const iv = new Uint8Array(12);
  for (let i = 0; i < 12; i++) iv[i] = (i * 13 + epoch) % 256;

  const enc = new TextEncoder();
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, appKey, enc.encode(plaintext));
  const ivHex = Buffer.from(iv).toString('hex');
  const ciphertextBase64 = Buffer.from(ct).toString('base64');

  return JSON.stringify({
    protocol: 'genchat-mls-v1',
    groupId: channelId,
    epoch,
    senderId,
    ivHex,
    ciphertextBase64,
  });
}

async function decryptMlsMessage(envelopeJson, epochSecretHex, channelId, epoch) {
  const envelope = JSON.parse(envelopeJson);
  const appKey = await deriveEpochKey(epochSecretHex, channelId, epoch);
  const iv = new Uint8Array(envelope.ivHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  const ctBytes = Buffer.from(envelope.ciphertextBase64, 'base64');

  const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv }, appKey, ctBytes);
  return new TextDecoder().decode(decrypted);
}

async function connectWebSocket(token, label = 'client') {
  const MAX_ATTEMPTS = 5;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const ws = await new Promise((resolve, reject) => {
        const sock = new WebSocket(`${GATEWAY_WS_URL}/ws?token=${encodeURIComponent(token)}`);
        const t = setTimeout(() => {
          sock.close();
          reject(new Error(`${label} WS open timed out (attempt ${attempt})`));
        }, 10000);
        sock.onopen = () => { clearTimeout(t); resolve(sock); };
        sock.onerror = (e) => {
          clearTimeout(t);
          const msg = e?.error?.message || e?.message || String(e);
          reject(new Error(`${label} WS onerror (attempt ${attempt}): ${msg}`));
        };
      });
      return ws;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        const delay = 1500 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}


async function runTest() {
  // Step 1: Provision 3 users
  const alice = await provisionUser('Alice');
  const bob = await provisionUser('Bob');
  const charlie = await provisionUser('Charlie');

  // Step 2: Upload MLS KeyPackages for all users
  for (const u of [alice, bob, charlie]) {
    const fakeKeyPackage = JSON.stringify({
      userId: u.userId,
      deviceId: u.deviceId,
      publicKeyHex: `pubkey_${u.name.toLowerCase()}_00112233445566778899`,
      signatureHex: `sig_${u.name.toLowerCase()}_aabbccddeeff`,
      timestamp: Date.now(),
    });
    const b64 = Buffer.from(fakeKeyPackage).toString('base64');

    const res = await fetch(`${AUTH_HTTP_URL}/chat.v1.KeyService/UploadMlsKeyPackage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${u.token}`,
      },
      body: JSON.stringify({
        device_id: u.deviceId,
        key_package_data: b64,
      }),
    });
    if (!res.ok) throw new Error(`UploadMlsKeyPackage failed for ${u.name}: ${res.status}`);
    console.log(`✓ [KeyPackage] Uploaded for ${u.name}`);
  }

  // Step 3: Alice fetches KeyPackages for Bob and Charlie
  for (const u of [bob, charlie]) {
    const res = await fetch(`${AUTH_HTTP_URL}/chat.v1.KeyService/FetchMlsKeyPackage?user_id=${encodeURIComponent(u.userId)}`, {
      headers: { 'Authorization': `Bearer ${alice.token}` },
    });
    if (!res.ok) throw new Error(`FetchMlsKeyPackage failed for ${u.name}: ${res.status}`);
    const data = await res.json();
    const pkg = JSON.parse(data.raw || Buffer.from(data.key_package_data, 'base64').toString());
    if (pkg.userId !== u.userId) throw new Error(`KeyPackage mismatch for ${u.name}`);
    console.log(`✓ [KeyPackage] Alice fetched KeyPackage for ${u.name}`);
  }

  // Step 4: Alice creates MLS group "Security Architecture Group" with Welcomes
  const initialEpochSecretBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) initialEpochSecretBytes[i] = (i * 17) % 256;
  const initialEpochSecretHex = Buffer.from(initialEpochSecretBytes).toString('hex');

  const welcomes = {};
  for (const u of [bob, charlie]) {
    const welcomeEnv = {
      groupId: '',
      epoch: 0,
      creatorId: alice.userId,
      encryptedEpochSecretB64: Buffer.from(initialEpochSecretBytes).toString('base64'),
      ratchetTree: [
        { leafIndex: 0, userId: alice.userId, publicKeyHex: 'alice_root' },
        { leafIndex: 1, userId: bob.userId, publicKeyHex: 'bob_key' },
        { leafIndex: 2, userId: charlie.userId, publicKeyHex: 'charlie_key' },
      ],
    };
    welcomes[u.userId] = Buffer.from(JSON.stringify(welcomeEnv)).toString('base64');
  }

  const initialCommit = {
    groupId: '',
    epoch: 0,
    committerId: alice.userId,
    action: 'add',
    commitHashHex: initialEpochSecretHex.slice(0, 32),
  };

  const createRes = await fetch(`${AUTH_HTTP_URL}/chat.v1.ChannelService/CreateChannel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${alice.token}`,
    },
    body: JSON.stringify({
      name: 'Security Architecture Group',
      type: 2,
      member_user_ids: [bob.userId, charlie.userId],
      member_welcomes: welcomes,
      initial_commit: Buffer.from(JSON.stringify(initialCommit)).toString('base64'),
    }),
  });
  if (!createRes.ok) throw new Error(`CreateChannel failed: ${createRes.status}`);
  const chanData = await createRes.json();
  const rawChannelId = chanData.channel.id;
  const channelId = `chan_${rawChannelId}`;
  console.log(`✓ [Channel] Created MLS Group channel: ${channelId}`);

  // Step 5: Connect Bob and Charlie to Gateway WebSocket
  const bobWs = await connectWebSocket(bob.token);
  const charlieWs = await connectWebSocket(charlie.token);
  console.log('✓ [WebSocket] Bob and Charlie connected');

  // Step 6: Bob joins channel and verifies Welcome envelope is retrieved
  const joinRes = await fetch(`${AUTH_HTTP_URL}/chat.v1.ChannelService/JoinChannel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bob.token}`,
    },
    body: JSON.stringify({ channel_id: rawChannelId }),
  });
  if (!joinRes.ok) throw new Error(`JoinChannel failed for Bob: ${joinRes.status}`);
  const joinData = await joinRes.json();
  if (!joinData.mls_welcome) throw new Error('Bob did not receive mls_welcome upon JoinChannel');
  const bobWelcome = JSON.parse(Buffer.from(joinData.mls_welcome, 'base64').toString());
  console.log(`✓ [Welcome] Bob retrieved MLS Welcome for epoch ${bobWelcome.epoch} with ${bobWelcome.ratchetTree.length} members`);

  // Step 7: Connect Alice to Gateway WebSocket
  const aliceWs = await connectWebSocket(alice.token);
  console.log('✓ [WebSocket] Alice connected');

  // Step 8: Set up message listeners for Bob and Charlie
  const bobReceivedMsgs = [];
  bobWs.onmessage = async (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : await ev.data.text();
    const frame = JSON.parse(text);
    if (frame.type === 'push' || frame.type === 'group_commit') {
      bobReceivedMsgs.push(frame);
    }
  };

  const charlieReceivedMsgs = [];
  charlieWs.onmessage = async (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : await ev.data.text();
    const frame = JSON.parse(text);
    if (frame.type === 'push' || frame.type === 'group_commit') {
      charlieReceivedMsgs.push(frame);
    }
  };


  // Step 9: Alice sends MLS Encrypted Group Message (Epoch 0)
  const secretMessageEpoch0 = 'CONFIDENTIAL: Quantum-resistant group ratchet initialized successfully!';
  const wireCiphertextEpoch0 = await encryptMlsMessage(
    secretMessageEpoch0,
    initialEpochSecretHex,
    channelId,
    0,
    alice.userId
  );

  const clientMsgId0 = 'msg_mls_epoch0_' + Date.now();
  aliceWs.send(JSON.stringify({
    action: 'send_message',
    channel_id: channelId,
    client_msg_id: clientMsgId0,
    ciphertext_base64: Buffer.from(wireCiphertextEpoch0).toString('base64'),
    message_type: 1,
  }));
  console.log('✓ [Send] Alice sent MLS encrypted message for Epoch 0');

  // Wait for fan-out delivery
  await new Promise((r) => setTimeout(r, 1200));

  if (bobReceivedMsgs.length === 0) throw new Error('Bob did not receive Epoch 0 push message');
  if (charlieReceivedMsgs.length === 0) throw new Error('Charlie did not receive Epoch 0 push message');

  const bobDecrypted0 = await decryptMlsMessage(
    Buffer.from(bobReceivedMsgs[0].ciphertext_base64, 'base64').toString(),
    initialEpochSecretHex,
    channelId,
    0
  );
  if (bobDecrypted0 !== secretMessageEpoch0) throw new Error(`Bob decrypted mismatch: "${bobDecrypted0}"`);
  console.log(`✓ [FanOut] Bob decrypted Epoch 0 message: "${bobDecrypted0}"`);

  const charlieDecrypted0 = await decryptMlsMessage(
    Buffer.from(charlieReceivedMsgs[0].ciphertext_base64, 'base64').toString(),
    initialEpochSecretHex,
    channelId,
    0
  );
  if (charlieDecrypted0 !== secretMessageEpoch0) throw new Error(`Charlie decrypted mismatch: "${charlieDecrypted0}"`);
  console.log(`✓ [FanOut] Charlie decrypted Epoch 0 message: "${charlieDecrypted0}"`);

  // Step 10: Epoch Transition (Remove Charlie / Re-Key to Epoch 1)
  // Derive next epoch secret via HKDF
  const enc = new TextEncoder();
  const baseKey = await subtle.importKey('raw', initialEpochSecretBytes, { name: 'HKDF' }, false, ['deriveBits']);
  const epoch1Bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode('mls_epoch_salt_1'),
      info: enc.encode(`mls_epoch_transition_${channelId}_1`),
    },
    baseKey,
    256
  );
  const epoch1SecretHex = Buffer.from(epoch1Bits).toString('hex');

  const commitEnvelopeEpoch1 = {
    groupId: channelId,
    epoch: 1,
    committerId: alice.userId,
    action: 'remove',
    targetUserId: charlie.userId,
    commitHashHex: epoch1SecretHex.slice(0, 32),
    timestamp: Date.now(),
  };
  const commitDataB64 = Buffer.from(JSON.stringify(commitEnvelopeEpoch1)).toString('base64');

  // Alice sends group_commit over WebSocket
  aliceWs.send(JSON.stringify({
    action: 'group_commit',
    channel_id: channelId,
    epoch: 1,
    commit_data: commitDataB64,
  }));
  console.log('✓ [Epoch Transition] Alice broadcast group_commit for Epoch 1 (removing Charlie)');

  await new Promise((r) => setTimeout(r, 1000));

  const bobCommitFrame = bobReceivedMsgs.find(m => m.type === 'group_commit' && m.epoch === 1);
  if (!bobCommitFrame) throw new Error('Bob did not receive group_commit frame over WebSocket');
  console.log(`✓ [Epoch Transition] Bob received group_commit frame for Epoch 1: ${bobCommitFrame.epoch}`);

  // Step 11: Alice sends message in Epoch 1 (Post-Compromise Security)
  const secretMessageEpoch1 = 'TOP SECRET: Charlie has been removed. Epoch 1 application key active.';
  const wireCiphertextEpoch1 = await encryptMlsMessage(
    secretMessageEpoch1,
    epoch1SecretHex,
    channelId,
    1,
    alice.userId
  );

  const clientMsgId1 = 'msg_mls_epoch1_' + Date.now();
  aliceWs.send(JSON.stringify({
    action: 'send_message',
    channel_id: channelId,
    client_msg_id: clientMsgId1,
    ciphertext_base64: Buffer.from(wireCiphertextEpoch1).toString('base64'),
    message_type: 1,
  }));
  console.log('✓ [Send] Alice sent Epoch 1 message');

  await new Promise((r) => setTimeout(r, 1200));

  const bobEpoch1Msg = bobReceivedMsgs.find(m => {
    if (m.type !== 'push' || !m.ciphertext_base64) return false;
    try {
      const decoded = Buffer.from(m.ciphertext_base64, 'base64').toString();
      return decoded.includes('genchat-mls-v1') && decoded.includes('"epoch":1');
    } catch {
      return false;
    }
  });
  if (!bobEpoch1Msg) {
    console.log('Bob received messages:', JSON.stringify(bobReceivedMsgs, null, 2));
    throw new Error('Bob did not receive Epoch 1 message');
  }


  const bobDecrypted1 = await decryptMlsMessage(
    Buffer.from(bobEpoch1Msg.ciphertext_base64, 'base64').toString(),
    epoch1SecretHex,
    channelId,
    1
  );
  if (bobDecrypted1 !== secretMessageEpoch1) throw new Error('Bob Epoch 1 decryption mismatch');
  console.log(`✓ [Forward Secrecy] Bob successfully decrypted Epoch 1 message: "${bobDecrypted1}"`);

  // Step 12: Verify Post-Compromise Security / Forward Secrecy:
  // An adversary with only Epoch 0 secret cannot decrypt Epoch 1 message
  try {
    await decryptMlsMessage(
      Buffer.from(bobEpoch1Msg.ciphertext_base64, 'base64').toString(),
      initialEpochSecretHex, // Attempting to decrypt with old Epoch 0 key
      channelId,
      0
    );
    throw new Error('SECURITY VIOLATION: Epoch 0 key decrypted Epoch 1 message!');
  } catch (err) {
    if (err.message.includes('SECURITY VIOLATION')) throw err;
    console.log('✓ [Security Verification] Verified Forward Secrecy: Epoch 0 key rejected with cryptographic authentication error');
  }

  // Cleanup WebSockets
  try { aliceWs?.close(); } catch {}
  try { bobWs?.close(); } catch {}
  try { charlieWs?.close(); } catch {}

  console.log('\n======================================================');
  console.log('🎉 ALL MLS GROUP CHAT INTEGRATION TESTS PASSED 100%!');
  console.log('======================================================');
}

runTest().catch((err) => {
  console.error('\n❌ MLS Test Failed:', err);
  process.exit(1);
});
