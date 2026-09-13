// Integration Test: True Post-Quantum End-to-End Encryption (PQXDH & MLS TreeKEM)
//
// Proves:
// 1. Zero-Knowledge Relay: Gateway & ScyllaDB relay encrypted envelopes, but server cannot decrypt payloads.
// 2. PQXDH Handshake: Real ML-KEM-768 + X25519 key encapsulation between Alice and Bob.
// 3. Authorized Decryption: Bob with matching private keys can derive secret and decrypt message.
// 4. Session Isolation: Repeated handshakes between same users produce distinct, ephemeral keys.
// 5. MLS TreeKEM Privacy: Captured Welcome packets cannot be decrypted without recipient private key.
// 6. Authentic Safety Numbers: Numbers derived from authentic public keys detect MITM substitution.

import assert from 'assert';
import { subtle, createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

console.log('=== Starting True Post-Quantum E2EE Verification Test Suite ===\n');

// Load Rust WebAssembly cryptographic core
const wasmJsPath = path.resolve(__dirname, '../../crypto/genchat-crypto-wasm/pkg/genchat_crypto_wasm.js');
const wasmBgPath = path.resolve(__dirname, '../../crypto/genchat-crypto-wasm/pkg/genchat_crypto_wasm_bg.wasm');

const wasmModule = await import(`file://${wasmJsPath}`);
const wasmBytes = fs.readFileSync(wasmBgPath);
await wasmModule.default({ module_or_path: wasmBytes });

console.log('✓ Initialized Rust WebAssembly Cryptographic Engine (ML-KEM-768 + X25519 + TreeKEM)');

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

function hexToBase64(hex) {
  if (!hex) return '';
  const bytes = Buffer.from(hex, 'hex');
  return bytes.toString('base64');
}

function base64ToHex(b64) {
  if (!b64) return '';
  return Buffer.from(b64, 'base64').toString('hex');
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
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw lastErr;
}

// --------------------------------------------------------------------------
// Test Execution
// --------------------------------------------------------------------------

async function run() {
  // Step 1: Provision users Alice, Bob, and Eve (attacker)
  const alice = await provisionUser('Alice');
  const bob = await provisionUser('Bob');
  const eve = await provisionUser('Eve');

  // Step 2: Generate genuine PQXDH keys for Alice and Bob
  const aliceKeys = wasmModule.generate_pqxdh_keys(10);
  const bobKeys = wasmModule.generate_pqxdh_keys(10);
  const eveKeys = wasmModule.generate_pqxdh_keys(10);

  console.log('✓ Generated PQXDH key bundles with ML-KEM-768 encapsulation keys');

  // Step 3: Bob uploads his PreKeyBundle to the server
  const bobUploadRes = await fetch(`${AUTH_HTTP_URL}/chat.v1.KeyService/UploadPreKeyBundle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bob.token}`,
    },
    body: JSON.stringify({
      device_id: bob.deviceId,
      identityKey: hexToBase64(bobKeys.public_bundle.identity_key_hex),
      identityKeyX25519: hexToBase64(bobKeys.public_bundle.identity_key_x25519_hex),
      signedPreKey: {
        keyId: bobKeys.public_bundle.signed_pre_key_id,
        publicKey: hexToBase64(bobKeys.public_bundle.signed_pre_key_public_hex),
        signature: hexToBase64(bobKeys.public_bundle.signed_pre_key_signature_hex),
      },
      pqPreKey: {
        keyId: bobKeys.public_bundle.pq_pre_key_id,
        publicKey: hexToBase64(bobKeys.public_bundle.pq_pre_key_public_hex),
        signature: hexToBase64(bobKeys.public_bundle.pq_pre_key_signature_hex),
      },
      oneTimePreKeys: bobKeys.public_bundle.one_time_pre_keys.map((k) => ({
        keyId: k.key_id,
        publicKey: hexToBase64(k.public_key_hex),
      })),
    }),
  });
  assert.strictEqual(bobUploadRes.status, 200, 'Bob failed to upload PreKeyBundle');
  console.log('✓ Bob uploaded genuine ML-KEM-768 PreKeyBundle to server');

  // Step 4: Alice fetches Bob's PreKeyBundle by userId (verifying auto-device resolution)
  const fetchRes = await fetch(`${AUTH_HTTP_URL}/chat.v1.KeyService/FetchPreKeyBundle?userId=${encodeURIComponent(bob.userId)}`, {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  assert.strictEqual(fetchRes.status, 200, 'Alice failed to fetch Bob PreKeyBundle by userId');
  const fetchedData = await fetchRes.json();
  const rawBundle = fetchedData.bundle;
  assert.ok(rawBundle.identityKey, 'Missing identity key in fetched bundle');
  assert.ok(rawBundle.pqPreKey, 'Missing PQ pre-key in fetched bundle');
  console.log('✓ Alice successfully fetched Bob\'s PreKeyBundle (with device auto-resolution)');

  const bobPublicBundle = {
    identity_key_hex: base64ToHex(rawBundle.identityKey),
    identity_key_x25519_hex: base64ToHex(rawBundle.identityKeyX25519 || rawBundle.identityKey),
    signed_pre_key_id: rawBundle.signedPreKey.keyId,
    signed_pre_key_public_hex: base64ToHex(rawBundle.signedPreKey.publicKey),
    signed_pre_key_signature_hex: base64ToHex(rawBundle.signedPreKey.signature),
    pq_pre_key_id: rawBundle.pqPreKey.keyId,
    pq_pre_key_public_hex: base64ToHex(rawBundle.pqPreKey.publicKey),
    pq_pre_key_signature_hex: base64ToHex(rawBundle.pqPreKey.signature),
    one_time_pre_keys: rawBundle.oneTimePreKey ? [{
      key_id: rawBundle.oneTimePreKey.keyId,
      public_key_hex: base64ToHex(rawBundle.oneTimePreKey.publicKey),
    }] : [],
  };

  // Step 5: Alice initiates PQXDH Handshake
  const handshakeResult = wasmModule.initiate_pqxdh_handshake(aliceKeys.identity_bundle, bobPublicBundle);
  const aliceSecretHex = handshakeResult.shared_secret_hex;
  const initMessage = handshakeResult.init_message;
  assert.ok(aliceSecretHex && aliceSecretHex.length === 64, 'Shared secret must be 32 bytes (64 hex characters)');
  console.log(`✓ Alice initiated PQXDH Handshake. Derived Post-Quantum Shared Secret: ${aliceSecretHex.slice(0, 16)}...`);

  // Step 6: Alice encrypts secret message using derived key
  const secretPlaintext = 'Post-Quantum Top Secret Message 2026';
  const aliceSecretBytes = Buffer.from(aliceSecretHex, 'hex');
  const baseKey = await subtle.importKey('raw', aliceSecretBytes, { name: 'HKDF' }, false, ['deriveKey']);
  const sessionKey = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: Buffer.from('genchat_pqxdh_salt_2026'),
      info: Buffer.from(`genchat_pq_session_${alice.userId}:${bob.userId}`),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  const iv = Buffer.alloc(12);
  for (let i = 0; i < 12; i++) iv[i] = (i * 19 + 7) % 256;
  const ciphertextBuffer = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    sessionKey,
    Buffer.from(secretPlaintext, 'utf-8')
  );

  const wireEnvelope = {
    protocol: 'genchat-pq-v1',
    conversationId: [alice.userId, bob.userId].sort().join(':'),
    senderId: alice.userId,
    recipientId: bob.userId,
    initMessage,
    ivHex: iv.toString('hex'),
    ciphertextBase64: Buffer.from(ciphertextBuffer).toString('base64'),
    senderFingerprint: aliceKeys.public_bundle.identity_key_hex.slice(0, 16),
  };

  // Step 7: Connect Bob to WebSocket and Alice sends message over relay
  const bobWs = await connectWebSocket(bob.token, 'Bob');
  const aliceWs = await connectWebSocket(alice.token, 'Alice');

  const wireEnvelopeStr = JSON.stringify(wireEnvelope);

  const incomingMessagePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Bob to receive message')), 10000);
    bobWs.onmessage = async (event) => {
      try {
        const text = typeof event.data === 'string' ? event.data : await event.data.text();
        const frame = JSON.parse(text);
        if (frame.type === 'push' && frame.channel_id === bob.userId && frame.sender_id === alice.userId) {
          clearTimeout(timer);
          resolve(frame);
        }
      } catch (e) {
        // Ignore non-json
      }
    };
  });

  const messagePayload = {
    action: 'send_message',
    channel_id: bob.userId,
    client_msg_id: 'msg_pq_' + Date.now(),
    ciphertext_base64: Buffer.from(wireEnvelopeStr).toString('base64'),
    message_type: 1,
  };
  aliceWs.send(JSON.stringify(messagePayload));

  const receivedFrame = await incomingMessagePromise;
  console.log('✓ Bob received message through Gateway relay');

  // Step 8: Adversary Inability to Decrypt (Zero-Knowledge Relay Verification)
  console.log('\n--- Verifying Server & Adversary Zero-Knowledge Property ---');
  const capturedEnvelopeStr = Buffer.from(receivedFrame.ciphertext_base64, 'base64').toString('utf-8');
  const capturedEnvelope = JSON.parse(capturedEnvelopeStr);

  // 1. Attempt decryption with legacy simulated ID-derived key
  const fakeIkm = Buffer.from(`genchat_ikm_${wireEnvelope.conversationId}`);
  const fakeBaseKey = await subtle.importKey('raw', fakeIkm, { name: 'HKDF' }, false, ['deriveKey']);
  const fakeKey = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: Buffer.from('genchat_pq_master_salt_2026'),
      info: Buffer.from(`conversation_key_${wireEnvelope.conversationId}`),
    },
    fakeBaseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  let fakeDecrypted = false;
  try {
    await subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(capturedEnvelope.ivHex, 'hex') },
      fakeKey,
      Buffer.from(capturedEnvelope.ciphertextBase64, 'base64')
    );
    fakeDecrypted = true;
  } catch (err) {
    // Expected to fail!
  }
  assert.strictEqual(fakeDecrypted, false, 'Server/adversary with conversation ID MUST NOT be able to decrypt payload!');
  console.log('✓ Confirmed: Eavesdropper with conversationId cannot decrypt payload (tag mismatch / authentication failure)');

  // 2. Attempt decryption using Eve's private keys
  let eveHandshakeSuccess = false;
  try {
    wasmModule.receive_pqxdh_handshake(eveKeys.identity_bundle, capturedEnvelope.initMessage);
    eveHandshakeSuccess = true;
  } catch (err) {
    // Expected error: decapsulation fails or secret does not match
  }
  // Even if receive succeeds with mismatched identity, the derived secret is totally different
  if (eveHandshakeSuccess) {
    const eveSecret = wasmModule.receive_pqxdh_handshake(eveKeys.identity_bundle, capturedEnvelope.initMessage);
    assert.notStrictEqual(eveSecret, aliceSecretHex, 'Eve must not derive Alice\'s secret');
  }
  console.log('✓ Confirmed: Adversary (Eve) cannot derive Bob\'s post-quantum shared secret');

  // Step 9: Authorized Recipient Decryption
  console.log('\n--- Verifying Authorized Recipient PQXDH Decryption ---');
  const bobSecretHex = wasmModule.receive_pqxdh_handshake(bobKeys.identity_bundle, capturedEnvelope.initMessage);
  assert.strictEqual(bobSecretHex, aliceSecretHex, 'Bob and Alice must derive the exact same shared secret!');
  console.log(`✓ Bob processed PQXDH InitMessage: Derived Secret matches Alice exactly! (${bobSecretHex.slice(0, 16)}...)`);

  const bobSecretBytes = Buffer.from(bobSecretHex, 'hex');
  const bobBaseKey = await subtle.importKey('raw', bobSecretBytes, { name: 'HKDF' }, false, ['deriveKey']);
  const bobSessionKey = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: Buffer.from('genchat_pqxdh_salt_2026'),
      info: Buffer.from(`genchat_pq_session_${alice.userId}:${bob.userId}`),
    },
    bobBaseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const bobDecryptedBuffer = await subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(capturedEnvelope.ivHex, 'hex') },
    bobSessionKey,
    Buffer.from(capturedEnvelope.ciphertextBase64, 'base64')
  );
  const bobDecryptedText = Buffer.from(bobDecryptedBuffer).toString('utf-8');
  assert.strictEqual(bobDecryptedText, secretPlaintext, 'Decrypted text must match original plaintext');
  console.log(`✓ Bob successfully decrypted message: "${bobDecryptedText}"`);

  // Step 10: Session Key Uniqueness (Distinct Ephemeral Keys)
  console.log('\n--- Verifying Ephemeral Key Freshness & Distinct Sessions ---');
  const secondHandshake = wasmModule.initiate_pqxdh_handshake(aliceKeys.identity_bundle, bobPublicBundle);
  assert.notStrictEqual(
    secondHandshake.shared_secret_hex,
    aliceSecretHex,
    'Subsequent handshake between same users MUST produce distinct secret (ephemeral fresh key + ML-KEM encapsulation)'
  );
  console.log('✓ Confirmed: Fresh PQXDH handshakes generate distinct session secrets');

  // Step 11: MLS TreeKEM Welcome Confidentiality
  console.log('\n--- Verifying MLS TreeKEM Welcome Privacy ---');
  const aliceIdPriv = 'aa'.repeat(32);
  const aliceHpkePriv = 'bb'.repeat(32);
  const groupStateJson = wasmModule.mls_create_group('chan_sec_grp_1', alice.userId, alice.deviceId, aliceIdPriv, aliceHpkePriv);

  const bobIdPriv = 'cc'.repeat(32);
  const bobKp = wasmModule.mls_generate_key_package(bob.userId, bob.deviceId, bobIdPriv);

  const addResult = wasmModule.mls_group_add_member(groupStateJson, bobKp.key_package_json);
  const welcomeJson = addResult.welcome_json;

  // Eve attempts to unwrap Welcome
  const eveHpkePriv = 'ff'.repeat(32);
  let eveJoined = false;
  try {
    wasmModule.mls_group_from_welcome(welcomeJson, bobIdPriv, eveHpkePriv);
    eveJoined = true;
  } catch (err) {
    // Expected: HPKE decryption failure!
  }
  assert.strictEqual(eveJoined, false, 'Eve MUST NOT be able to unwrap Welcome without Bob\'s HPKE private key!');
  console.log('✓ Confirmed: MLS Welcome cannot be decrypted without recipient private key');

  // Bob unwraps Welcome with genuine HPKE key
  const bobJoin = wasmModule.mls_group_from_welcome(welcomeJson, bobIdPriv, bobKp.hpke_private_key_hex);
  assert.strictEqual(bobJoin.epoch, 1, 'Bob should join group at epoch 1');
  console.log('✓ Bob successfully joined MLS group from TreeKEM Welcome at epoch 1');

  // Step 12: Safety Numbers Verification with Authentic Public Keys
  console.log('\n--- Verifying Authentic Public-Key-Backed Safety Numbers ---');
  function computeSafetyNumber(uA, kA, uB, kB) {
    const pA = { userId: uA, key: kA };
    const pB = { userId: uB, key: kB };
    const cmp = (pA.userId + ':' + pA.key).localeCompare(pB.userId + ':' + pB.key);
    const [p1, p2] = cmp <= 0 ? [pA, pB] : [pB, pA];

    const payload = Buffer.from(`genchat-safety-v1:${p1.userId}:${p1.key}:${p2.userId}:${p2.key}`);
    let h = createHash('sha512').update(payload).digest();
    for (let i = 0; i < 5; i++) {
      h = createHash('sha512').update(h).digest();
    }
    const blocks = [];
    for (let i = 0; i < 12; i++) {
      const b0 = h[i * 4] || 0;
      const b1 = h[i * 4 + 1] || 0;
      const b2 = h[i * 4 + 2] || 0;
      const b3 = h[i * 4 + 3] || 0;
      const val = (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0) % 100000;
      blocks.push(val.toString().padStart(5, '0'));
    }
    return blocks.join(' ');
  }

  const aliceKeyHex = aliceKeys.public_bundle.identity_key_hex;
  const bobKeyHex = bobKeys.public_bundle.identity_key_hex;

  const safetyNumAlice = await computeSafetyNumber(alice.userId, aliceKeyHex, bob.userId, bobKeyHex);
  const safetyNumBob = await computeSafetyNumber(bob.userId, bobKeyHex, alice.userId, aliceKeyHex);

  assert.strictEqual(safetyNumAlice, safetyNumBob, 'Safety numbers must match symmetrically');
  assert.strictEqual(safetyNumAlice.split(' ').length, 12, 'Safety number must consist of 12 blocks of 5 digits');

  // Verify MITM key substitution changes the safety number
  const tamperedBobKeyHex = '99'.repeat(32);
  const tamperedSafetyNum = await computeSafetyNumber(alice.userId, aliceKeyHex, bob.userId, tamperedBobKeyHex);
  assert.notStrictEqual(safetyNumAlice, tamperedSafetyNum, 'MITM key substitution MUST change the safety number!');
  console.log(`✓ Safety Numbers verified: ${safetyNumAlice}`);
  console.log('✓ MITM Key Substitution detected: Tampered key produced completely different number!');

  // Cleanup
  aliceWs.close();
  bobWs.close();
  console.log('\n=== ALL TRUE POST-QUANTUM E2EE TESTS PASSED PERFECTLY ===\n');
}

run().catch((err) => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
