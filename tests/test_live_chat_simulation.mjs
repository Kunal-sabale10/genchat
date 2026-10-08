import fs from 'fs';
import { subtle } from 'crypto';

// Load wasm module
const wasmModule = await import('../crypto/genchat-crypto-wasm/pkg/genchat_crypto_wasm.js');
const wasmBytes = fs.readFileSync('./crypto/genchat-crypto-wasm/pkg/genchat_crypto_wasm_bg.wasm');
await wasmModule.default({ module_or_path: wasmBytes });

console.log('✓ Wasm initialized');

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

async function getDevToken(name) {
  const res = await fetch(`${AUTH_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: name })
  });
  if (!res.ok) throw new Error(`dev-token failed: ${res.status}`);
  return res.json();
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

async function deriveKey(sharedSecretHex, contextId) {
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

async function runTest() {
  console.log('--- Step 1: Provision Users ---');
  const user1 = await getDevToken('Test User 1');
  const user2 = await getDevToken('Test User 2');
  console.log(`User 1: ${user1.user_id}`);
  console.log(`User 2: ${user2.user_id}`);

  // Generate PQXDH keys for both users
  const user1Keys = wasmModule.generate_pqxdh_keys(10);
  const user2Keys = wasmModule.generate_pqxdh_keys(10);

  // Upload user2 PreKeyBundle to server
  const upload2 = await fetch(`${AUTH_URL}/chat.v1.KeyService/UploadPreKeyBundle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user2.access_token}`
    },
    body: JSON.stringify({
      device_id: user2.device_id,
      identityKey: hexToBase64(user2Keys.public_bundle.identity_key_hex),
      identityKeyX25519: hexToBase64(user2Keys.public_bundle.identity_key_x25519_hex),
      signedPreKey: {
        keyId: user2Keys.public_bundle.signed_pre_key_id,
        publicKey: hexToBase64(user2Keys.public_bundle.signed_pre_key_public_hex),
        signature: hexToBase64(user2Keys.public_bundle.signed_pre_key_signature_hex)
      },
      pqPreKey: {
        keyId: user2Keys.public_bundle.pq_pre_key_id,
        publicKey: hexToBase64(user2Keys.public_bundle.pq_pre_key_public_hex),
        signature: hexToBase64(user2Keys.public_bundle.pq_pre_key_signature_hex)
      },
      oneTimePreKeys: user2Keys.public_bundle.one_time_pre_keys.map(k => ({
        keyId: k.key_id,
        publicKey: hexToBase64(k.public_key_hex)
      }))
    })
  });
  console.log('User 2 PreKey upload status:', upload2.status);

  console.log('\n--- Step 2: User 1 initiates PQXDH session with User 2 ---');
  const peerBundle = await fetchPreKeyBundle(user2.user_id, user1.access_token);
  const handshakeRes = wasmModule.initiate_pqxdh_handshake(user1Keys.identity_bundle, peerBundle);
  console.log('✓ Handshake initiated. Secret:', handshakeRes.shared_secret_hex.slice(0, 16) + '...');

  const canonicalContext = [user1.user_id, user2.user_id].sort().join(':');
  console.log('Canonical Context:', canonicalContext);
  const user1Key = await deriveKey(handshakeRes.shared_secret_hex, canonicalContext);

  // User 1 encrypts message
  const plaintext = 'Hello User 2, this is a post-quantum secret!';
  const iv = Buffer.alloc(12, 42);
  const ciphertextBuffer = await subtle.encrypt({ name: 'AES-GCM', iv }, user1Key, Buffer.from(plaintext, 'utf-8'));

  const envelope = {
    protocol: 'genchat-pq-v1',
    conversationId: user2.user_id,
    sequenceNum: 1,
    senderId: user1.user_id,
    recipientId: user2.user_id,
    initMessage: handshakeRes.init_message,
    ivHex: iv.toString('hex'),
    ciphertextBase64: Buffer.from(ciphertextBuffer).toString('base64'),
    senderFingerprint: user1Keys.public_bundle.identity_key_hex.slice(0, 16),
    insecureFallback: false
  };

  console.log('\n--- Step 3: Connect User 2 to WebSocket Gateway ---');
  const ws2 = new WebSocket(`${GATEWAY_WS_URL}/ws?token=${encodeURIComponent(user2.access_token)}`);
  await new Promise((resolve, reject) => {
    ws2.addEventListener('open', resolve);
    ws2.addEventListener('error', (e) => reject(new Error('ws2 connection failed')));
    setTimeout(() => reject(new Error('ws2 connect timeout')), 5000);
  });
  console.log('✓ User 2 connected to Gateway');

  const ws1 = new WebSocket(`${GATEWAY_WS_URL}/ws?token=${encodeURIComponent(user1.access_token)}`);
  await new Promise((resolve, reject) => {
    ws1.addEventListener('open', resolve);
    ws1.addEventListener('error', (e) => reject(new Error('ws1 connection failed')));
    setTimeout(() => reject(new Error('ws1 connect timeout')), 5000);
  });
  console.log('✓ User 1 connected to Gateway');

  const receivePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for push frame')), 10000);
    ws2.addEventListener('message', async (event) => {
      try {
        const text = typeof event.data === 'string' ? event.data : await event.data.text();
        const data = JSON.parse(text);
        if (data.type === 'push') {
          clearTimeout(timer);
          resolve(data);
        }
      } catch (err) {
        console.warn('Error parsing frame:', err);
      }
    });
  });

  // User 1 sends envelope over Gateway
  const sendPayload = {
    action: 'send_message',
    channel_id: user2.user_id,
    client_msg_id: 'msg_test_' + Date.now(),
    ciphertext_base64: Buffer.from(JSON.stringify(envelope)).toString('base64'),
    message_type: 1
  };
  ws1.send(JSON.stringify(sendPayload));
  console.log('✓ User 1 dispatched envelope through WebSocket');

  const pushFrame = await receivePromise;
  console.log('✓ User 2 received push frame from Gateway');

  const receivedEnvStr = Buffer.from(pushFrame.ciphertext_base64, 'base64').toString('utf-8');
  const receivedEnv = JSON.parse(receivedEnvStr);

  console.log('\n--- Step 4: User 2 decrypts message ---');
  // Process incoming PQXDH handshake
  const bobSecretHex = wasmModule.receive_pqxdh_handshake(user2Keys.identity_bundle, receivedEnv.initMessage);
  console.log('Bob secret:', bobSecretHex.slice(0, 16) + '...');
  console.log('Secrets match?', bobSecretHex === handshakeRes.shared_secret_hex);

  const user2Key = await deriveKey(bobSecretHex, canonicalContext);
  const ivRecv = Buffer.from(receivedEnv.ivHex, 'hex');
  const ctBytes = Buffer.from(receivedEnv.ciphertextBase64, 'base64');
  const decryptedBuf = await subtle.decrypt({ name: 'AES-GCM', iv: ivRecv }, user2Key, ctBytes);
  const decryptedText = Buffer.from(decryptedBuf).toString('utf-8');

  console.log('✓ Decrypted plaintext:', decryptedText);
  if (decryptedText === plaintext) {
    console.log('🎉 SUCCESS: Full E2EE Post-Quantum Send & Receive verified!');
  } else {
    console.error('❌ Mismatch in decrypted text!');
  }

  ws1.close();
  ws2.close();
}

runTest().catch(console.error);
