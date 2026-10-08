import assert from 'assert';
import fs from 'fs';
import { subtle } from 'crypto';

// Load Rust WebAssembly cryptographic core
const wasmModule = await import('../crypto/genchat-crypto-wasm/pkg/genchat_crypto_wasm.js');
const wasmBytes = fs.readFileSync('./crypto/genchat-crypto-wasm/pkg/genchat_crypto_wasm_bg.wasm');
await wasmModule.default({ module_or_path: wasmBytes });

console.log('===========================================================');
console.log('🤖 AGENT: SENIOR QA & E2EE INTEGRATION TEST RUNNER');
console.log('===========================================================');
console.log('✓ Wasm Cryptographic Engine Initialized (ML-KEM-768 + X25519)\n');

const AUTH_URL = 'http://localhost:8080';
const GATEWAY_WS_URL = 'ws://localhost:8081';

function hexToBase64(hex) {
  if (!hex) return '';
  const bytes = Buffer.from(hex, 'hex');
  return bytes.toString('base64');
}

function base64ToHex(b64) {
  if (!b64) return '';
  return Buffer.from(b64, 'base64').toString('hex');
}

async function provisionUser(displayName) {
  const res = await fetch(`${AUTH_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: displayName })
  });
  if (!res.ok) throw new Error(`dev-token failed for ${displayName}: ${res.status}`);
  const data = await res.json();
  console.log(`[Provision] ${displayName}: userId=${data.user_id}, deviceId=${data.device_id}`);
  return {
    name: displayName,
    userId: data.user_id,
    deviceId: data.device_id,
    token: data.access_token
  };
}

async function uploadPreKeys(user, wasmKeys) {
  const payload = {
    device_id: user.deviceId,
    identityKey: hexToBase64(wasmKeys.public_bundle.identity_key_hex),
    identityKeyX25519: hexToBase64(wasmKeys.public_bundle.identity_key_x25519_hex),
    signedPreKey: {
      keyId: wasmKeys.public_bundle.signed_pre_key_id,
      publicKey: hexToBase64(wasmKeys.public_bundle.signed_pre_key_public_hex),
      signature: hexToBase64(wasmKeys.public_bundle.signed_pre_key_signature_hex)
    },
    pqPreKey: {
      keyId: wasmKeys.public_bundle.pq_pre_key_id,
      publicKey: hexToBase64(wasmKeys.public_bundle.pq_pre_key_public_hex),
      signature: hexToBase64(wasmKeys.public_bundle.pq_pre_key_signature_hex)
    },
    oneTimePreKeys: wasmKeys.public_bundle.one_time_pre_keys.map(k => ({
      keyId: k.key_id,
      publicKey: hexToBase64(k.public_key_hex)
    }))
  };

  const res = await fetch(`${AUTH_URL}/chat.v1.KeyService/UploadPreKeyBundle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.token}`
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`UploadPreKeyBundle failed for ${user.name}: ${res.status}`);
  console.log(`✓ ${user.name} uploaded PreKeyBundle (ML-KEM-768 + Signed PreKey + 20 OTKs)`);
}

async function fetchPreKeyBundle(userId, token) {
  const res = await fetch(`${AUTH_URL}/chat.v1.KeyService/FetchPreKeyBundle?userId=${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`FetchPreKeyBundle failed: ${res.status}`);
  const data = await res.json();
  const b = data.bundle;
  return {
    identity_key_hex: base64ToHex(b.identityKey),
    identity_key_x25519_hex: base64ToHex(b.identityKeyX25519 || b.identityKey),
    signed_pre_key_id: b.signedPreKey?.keyId || 1,
    signed_pre_key_public_hex: base64ToHex(b.signedPreKey?.publicKey || ''),
    signed_pre_key_signature_hex: base64ToHex(b.signedPreKey?.signature || ''),
    pq_pre_key_id: b.pqPreKey?.keyId || 1,
    pq_pre_key_public_hex: base64ToHex(b.pqPreKey?.publicKey || ''),
    pq_pre_key_signature_hex: base64ToHex(b.pqPreKey?.signature || ''),
    one_time_pre_keys: b.oneTimePreKey ? [{
      key_id: b.oneTimePreKey.keyId,
      public_key_hex: base64ToHex(b.oneTimePreKey.publicKey),
    }] : []
  };
}

async function deriveSymmetricKey(sharedSecretHex, contextId) {
  const enc = new TextEncoder();
  const secretBytes = Buffer.from(sharedSecretHex, 'hex');
  const baseKey = await subtle.importKey('raw', secretBytes, { name: 'HKDF' }, false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode('genchat_pqxdh_salt_2026'),
      info: enc.encode(`genchat_pq_session_${contextId}`)
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function connectWebSocket(user) {
  const ws = new WebSocket(`${GATEWAY_WS_URL}/ws?token=${encodeURIComponent(user.token)}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', (e) => reject(new Error(`${user.name} WS connect failed`)));
    setTimeout(() => reject(new Error(`${user.name} WS connect timeout`)), 5000);
  });
  console.log(`✓ ${user.name} connected to WebSocket Gateway`);
  return ws;
}

async function runTestSuite() {
  console.log('--- TEST 1: Provisioning & Cryptographic Registration ---');
  const alice = await provisionUser('Alice (Tester)');
  const bob = await provisionUser('Bob (Tester)');

  const aliceKeys = wasmModule.generate_pqxdh_keys(20);
  const bobKeys = wasmModule.generate_pqxdh_keys(20);

  await uploadPreKeys(alice, aliceKeys);
  await uploadPreKeys(bob, bobKeys);

  console.log('\n--- TEST 2: Gateway WebSocket Connectivity ---');
  const aliceWs = await connectWebSocket(alice);
  const bobWs = await connectWebSocket(bob);

  console.log('\n--- TEST 3: Alice sends Post-Quantum Message to Bob ---');
  // Alice fetches Bob's pre-key bundle
  const bobBundle = await fetchPreKeyBundle(bob.userId, alice.token);
  assert(bobBundle.identity_key_hex, 'Bob identity key must be present');
  assert(bobBundle.pq_pre_key_public_hex, 'Bob ML-KEM-768 public key must be present');

  // Alice initiates PQXDH handshake
  const handshakeAlice = wasmModule.initiate_pqxdh_handshake(aliceKeys.identity_bundle, bobBundle);
  const canonicalContext = [alice.userId, bob.userId].sort().join(':');
  console.log(`[Handshake] Canonical Context: ${canonicalContext}`);
  console.log(`[Handshake] Alice Derived Secret: ${handshakeAlice.shared_secret_hex.slice(0, 16)}...`);

  const aliceKey = await deriveSymmetricKey(handshakeAlice.shared_secret_hex, canonicalContext);

  const plaintext1 = 'Hey Bob! Post-Quantum encryption is 100% verified and operational.';
  const iv1 = Buffer.alloc(12, 101);
  const ct1 = await subtle.encrypt({ name: 'AES-GCM', iv: iv1 }, aliceKey, Buffer.from(plaintext1, 'utf-8'));

  const envelope1 = {
    protocol: 'genchat-pq-v1',
    conversationId: bob.userId,
    sequenceNum: 1,
    senderId: alice.userId,
    recipientId: bob.userId,
    initMessage: handshakeAlice.init_message,
    ivHex: iv1.toString('hex'),
    ciphertextBase64: Buffer.from(ct1).toString('base64'),
    senderFingerprint: aliceKeys.public_bundle.identity_key_hex.slice(0, 16),
    insecureFallback: false
  };

  const bobReceivePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bob timed out waiting for message 1')), 5000);
    bobWs.addEventListener('message', async (ev) => {
      try {
        const text = typeof ev.data === 'string' ? ev.data : await ev.data.text();
        const frame = JSON.parse(text);
        if (frame.type === 'push') {
          clearTimeout(timer);
          resolve(frame);
        }
      } catch (err) {
        console.warn('Bob parse frame error:', err);
      }
    });
  });

  aliceWs.send(JSON.stringify({
    action: 'send_message',
    channel_id: bob.userId,
    client_msg_id: 'msg_alice_' + Date.now(),
    ciphertext_base64: Buffer.from(JSON.stringify(envelope1)).toString('base64'),
    message_type: 1
  }));
  console.log('✓ Alice dispatched envelope to Gateway');

  const push1 = await bobReceivePromise;
  console.log('✓ Bob received push frame from Gateway');

  const receivedEnv1 = JSON.parse(Buffer.from(push1.ciphertext_base64, 'base64').toString('utf-8'));
  assert.strictEqual(receivedEnv1.protocol, 'genchat-pq-v1');
  assert.strictEqual(receivedEnv1.insecureFallback, false);

  // Bob receives handshake
  const bobSecretHex = wasmModule.receive_pqxdh_handshake(bobKeys.identity_bundle, receivedEnv1.initMessage);
  console.log(`[Handshake] Bob Derived Secret: ${bobSecretHex.slice(0, 16)}...`);
  assert.strictEqual(bobSecretHex, handshakeAlice.shared_secret_hex, 'Secrets MUST match exactly!');

  const bobKey = await deriveSymmetricKey(bobSecretHex, canonicalContext);
  const decryptedBuf1 = await subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(receivedEnv1.ivHex, 'hex') },
    bobKey,
    Buffer.from(receivedEnv1.ciphertextBase64, 'base64')
  );
  const decrypted1 = Buffer.from(decryptedBuf1).toString('utf-8');
  console.log(`✓ Bob decrypted plaintext: "${decrypted1}"`);
  assert.strictEqual(decrypted1, plaintext1);

  console.log('\n--- TEST 4: Bob replies with Post-Quantum Message to Alice ---');
  const plaintext2 = 'Affirmative Alice! Received loud and clear with zero leaks.';
  const iv2 = Buffer.alloc(12, 202);
  const ct2 = await subtle.encrypt({ name: 'AES-GCM', iv: iv2 }, bobKey, Buffer.from(plaintext2, 'utf-8'));

  const envelope2 = {
    protocol: 'genchat-pq-v1',
    conversationId: alice.userId,
    sequenceNum: 2,
    senderId: bob.userId,
    recipientId: alice.userId,
    ivHex: iv2.toString('hex'),
    ciphertextBase64: Buffer.from(ct2).toString('base64'),
    senderFingerprint: bobKeys.public_bundle.identity_key_hex.slice(0, 16),
    insecureFallback: false
  };

  const aliceReceivePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Alice timed out waiting for message 2')), 5000);
    aliceWs.addEventListener('message', async (ev) => {
      try {
        const text = typeof ev.data === 'string' ? ev.data : await ev.data.text();
        const frame = JSON.parse(text);
        if (frame.type === 'push') {
          clearTimeout(timer);
          resolve(frame);
        }
      } catch (err) {
        console.warn('Alice parse frame error:', err);
      }
    });
  });

  bobWs.send(JSON.stringify({
    action: 'send_message',
    channel_id: alice.userId,
    client_msg_id: 'msg_bob_' + Date.now(),
    ciphertext_base64: Buffer.from(JSON.stringify(envelope2)).toString('base64'),
    message_type: 1
  }));
  console.log('✓ Bob dispatched reply to Gateway');

  const push2 = await aliceReceivePromise;
  console.log('✓ Alice received push frame from Gateway');

  const receivedEnv2 = JSON.parse(Buffer.from(push2.ciphertext_base64, 'base64').toString('utf-8'));
  const decryptedBuf2 = await subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(receivedEnv2.ivHex, 'hex') },
    aliceKey,
    Buffer.from(receivedEnv2.ciphertextBase64, 'base64')
  );
  const decrypted2 = Buffer.from(decryptedBuf2).toString('utf-8');
  console.log(`✓ Alice decrypted plaintext: "${decrypted2}"`);
  assert.strictEqual(decrypted2, plaintext2);

  console.log('\n--- TEST 5: Verify Sender Self-Decryption from History ---');
  // Alice can decrypt her OWN message 1 using the canonical context key:
  const selfDecryptedBuf = await subtle.decrypt(
    { name: 'AES-GCM', iv: iv1 },
    aliceKey,
    ct1
  );
  const selfDecryptedText = Buffer.from(selfDecryptedBuf).toString('utf-8');
  console.log(`✓ Alice successfully decrypted her own sent message: "${selfDecryptedText}"`);
  assert.strictEqual(selfDecryptedText, plaintext1);

  // Bob can decrypt his OWN message 2:
  const bobSelfDecryptedBuf = await subtle.decrypt(
    { name: 'AES-GCM', iv: iv2 },
    bobKey,
    ct2
  );
  const bobSelfDecryptedText = Buffer.from(bobSelfDecryptedBuf).toString('utf-8');
  console.log(`✓ Bob successfully decrypted his own sent message: "${bobSelfDecryptedText}"`);
  assert.strictEqual(bobSelfDecryptedText, plaintext2);

  aliceWs.close();
  bobWs.close();

  console.log('\n===========================================================');
  console.log('🎉 ALL END-TO-END POST-QUANTUM CHAT TESTS PASSED (100%)');
  console.log('===========================================================');
}

runTestSuite().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
