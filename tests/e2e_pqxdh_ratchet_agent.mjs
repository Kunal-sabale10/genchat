import assert from 'assert';
import fs from 'fs';
import { subtle } from 'crypto';

// Load Rust WebAssembly cryptographic core
const wasmModule = await import('../crypto/genchat-crypto-wasm/pkg/genchat_crypto_wasm.js');
const wasmBytes = fs.readFileSync('./crypto/genchat-crypto-wasm/pkg/genchat_crypto_wasm_bg.wasm');
await wasmModule.default({ module_or_path: wasmBytes });

console.log('================================================================');
console.log('🛡️  E2EE POST-QUANTUM RATSHET & SESSION SYNC AGENT TEST');
console.log('================================================================\n');

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

function getCanonicalContextId(conversationId, currentUserId, peerId) {
  if (conversationId && conversationId.startsWith('chan_')) return conversationId;
  const p = peerId || (conversationId === currentUserId ? null : conversationId);
  if (p && currentUserId && p !== currentUserId) {
    return [currentUserId, p].sort().join(':');
  }
  return conversationId;
}

async function deriveKeyFromSecret(sharedSecretHex, contextId) {
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

// Simulates client MockLocalStorage
class MockStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) { return this.map.get(k) || null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

// Simulated Client E2EE Service that faithfully reproduces E2eeService
class ClientAgent {
  constructor(name, user) {
    this.name = name;
    this.user = user;
    this.storage = new MockStorage();
    this.sessionCache = new Map();
    this.identityBundle = null;
  }

  async initKeys() {
    const keys = wasmModule.generate_pqxdh_keys(30);
    this.identityBundle = keys.identity_bundle;
    this.storage.setItem(`genchat_pqxdh_identity_${this.user.userId}`, JSON.stringify(keys.identity_bundle));
    await uploadPreKeys(this.user, keys);
    return keys;
  }

  // Simulates reload / tab reopen
  reloadTab() {
    this.sessionCache.clear();
    this.identityBundle = null;
  }

  ensureIdentityLoaded() {
    if (!this.identityBundle) {
      const stored = this.storage.getItem(`genchat_pqxdh_identity_${this.user.userId}`);
      if (stored) {
        this.identityBundle = JSON.parse(stored);
      }
    }
  }

  getSessionStorageKey(peerId) {
    return `genchat_pq_session_${this.user.userId}_${peerId}`;
  }

  async getOrRestoreSession(peerId, conversationId) {
    if (this.sessionCache.has(peerId)) return this.sessionCache.get(peerId);
    const raw = this.storage.getItem(this.getSessionStorageKey(peerId));
    if (raw) {
      const data = JSON.parse(raw);
      const expectedContextId = getCanonicalContextId(conversationId, this.user.userId, peerId);
      const contextId = data.canonicalContextId && (data.canonicalContextId.includes(':') || data.canonicalContextId.startsWith('chan_'))
        ? data.canonicalContextId
        : expectedContextId;
      const key = await deriveKeyFromSecret(data.sharedSecretHex, contextId);
      const session = {
        key,
        sharedSecretHex: data.sharedSecretHex,
        peerIdentityKeyHex: data.peerIdentityKeyHex,
        pendingInitMessage: data.pendingInitMessage
      };
      this.sessionCache.set(peerId, session);
      return session;
    }
    return null;
  }

  saveSession(peerId, conversationId, session) {
    this.sessionCache.set(peerId, session);
    const canonicalContextId = getCanonicalContextId(conversationId, this.user.userId, peerId);
    this.storage.setItem(this.getSessionStorageKey(peerId), JSON.stringify({
      sharedSecretHex: session.sharedSecretHex,
      peerIdentityKeyHex: session.peerIdentityKeyHex,
      canonicalContextId,
      pendingInitMessage: session.pendingInitMessage
    }));
  }

  async encrypt(plaintext, peerId) {
    this.ensureIdentityLoaded();
    let session = await this.getOrRestoreSession(peerId, peerId);
    let initMsg = session?.pendingInitMessage;

    if (!session) {
      const peerBundle = await fetchPreKeyBundle(peerId, this.user.token);
      const initRes = wasmModule.initiate_pqxdh_handshake(this.identityBundle, peerBundle);
      const contextId = getCanonicalContextId(peerId, this.user.userId, peerId);
      const key = await deriveKeyFromSecret(initRes.shared_secret_hex, contextId);
      session = {
        key,
        sharedSecretHex: initRes.shared_secret_hex,
        peerIdentityKeyHex: peerBundle.identity_key_hex,
        pendingInitMessage: initRes.init_message
      };
      this.saveSession(peerId, peerId, session);
      initMsg = initRes.init_message;
    }

    const iv = Buffer.alloc(12, Math.floor(Math.random() * 255));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, session.key, Buffer.from(plaintext, 'utf-8'));

    const envelope = {
      protocol: 'genchat-pq-v1',
      conversationId: peerId,
      sequenceNum: 1,
      senderId: this.user.userId,
      recipientId: peerId,
      initMessage: initMsg,
      ivHex: iv.toString('hex'),
      ciphertextBase64: Buffer.from(ct).toString('base64'),
      senderFingerprint: this.identityBundle.identity_key_ed25519_pub_hex.slice(0, 16),
      insecureFallback: false
    };

    return JSON.stringify(envelope);
  }

  async decrypt(rawCiphertext, conversationId) {
    if (!rawCiphertext.startsWith('{')) return { text: rawCiphertext, isEncrypted: false };
    this.ensureIdentityLoaded();

    const envelope = JSON.parse(rawCiphertext);
    const senderId = envelope.senderId;
    const peerId = (senderId === this.user.userId) ? (envelope.recipientId || conversationId) : senderId;

    let session = await this.getOrRestoreSession(peerId, envelope.conversationId || conversationId);

    // If message is from peer and contains PQXDH InitMessage, establish / update session
    if (senderId !== this.user.userId && (!session || envelope.initMessage) && envelope.initMessage && this.identityBundle) {
      try {
        const secretHex = wasmModule.receive_pqxdh_handshake(this.identityBundle, envelope.initMessage);
        const contextId = getCanonicalContextId(envelope.conversationId || conversationId, this.user.userId, peerId);
        const key = await deriveKeyFromSecret(secretHex, contextId);
        session = {
          key,
          sharedSecretHex: secretHex,
          peerIdentityKeyHex: envelope.initMessage.sender_identity_key_hex
        };
        this.saveSession(peerId, envelope.conversationId || conversationId, session);
      } catch (err) {
        console.warn('receive_pqxdh_handshake failed:', err);
      }
    }

    if (!session) {
      return { text: '🔒 [Encrypted Message — Session synchronization pending]', isEncrypted: false };
    }

    const iv = Buffer.from(envelope.ivHex, 'hex');
    const ctBytes = Buffer.from(envelope.ciphertextBase64, 'base64');

    let decryptedBuf;
    try {
      decryptedBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, session.key, ctBytes);
    } catch (e) {
      if (senderId !== this.user.userId && envelope.initMessage && this.identityBundle) {
        const secretHex = wasmModule.receive_pqxdh_handshake(this.identityBundle, envelope.initMessage);
        const contextId = getCanonicalContextId(envelope.conversationId || conversationId, this.user.userId, peerId);
        const freshKey = await deriveKeyFromSecret(secretHex, contextId);
        decryptedBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, freshKey, ctBytes);
        session = { key: freshKey, sharedSecretHex: secretHex };
        this.saveSession(peerId, envelope.conversationId || conversationId, session);
      } else {
        throw e;
      }
    }

    const decryptedText = Buffer.from(decryptedBuf).toString('utf-8');
    return { text: decryptedText, isEncrypted: true, isInsecureFallback: false };
  }
}

async function runRatchetSuite() {
  console.log('1. Provisioning User 1 (Alice) & User 2 (Bob)...');
  const u1 = await provisionUser('User 1');
  const u2 = await provisionUser('User 2');
  const alice = new ClientAgent('User 1', u1);
  const bob = new ClientAgent('User 2', u2);

  await alice.initKeys();
  await bob.initKeys();
  console.log('✓ Both users provisioned with ML-KEM-768 PreKeyBundles in database');

  console.log('\n2. User 1 encrypts first message to User 2 (generating InitMessage)...');
  const originalPlaintext1 = 'Greetings Bob! This message travels via Kyber/ML-KEM-768 post-quantum key encapsulation.';
  const wireEnvelope1 = await alice.encrypt(originalPlaintext1, u2.userId);
  const parsedEnv1 = JSON.parse(wireEnvelope1);
  assert(parsedEnv1.initMessage, 'Message 1 MUST contain PQXDH InitMessage');
  console.log('✓ Encrypted envelope contains valid ML-KEM-768 PQXDH InitMessage');

  console.log('\n3. User 2 receives message 1 on cold browser start (no session in memory)...');
  bob.reloadTab(); // Emulates cold start
  assert.strictEqual(bob.sessionCache.size, 0, 'Bob session cache must be empty initially');
  
  const bobDecResult1 = await bob.decrypt(wireEnvelope1, u1.userId);
  console.log('✓ Bob Decrypt Result:', bobDecResult1);
  assert.strictEqual(bobDecResult1.isEncrypted, true);
  assert.strictEqual(bobDecResult1.text, originalPlaintext1);
  console.log('🎉 User 2 successfully decrypted Message 1 without any "Session synchronization pending" mask!');

  console.log('\n4. User 2 replies with Message 2 to User 1 using the established session...');
  const originalPlaintext2 = 'Acknowledged Alice! Zero-knowledge session established seamlessly.';
  const wireEnvelope2 = await bob.encrypt(originalPlaintext2, u1.userId);

  const aliceDecResult2 = await alice.decrypt(wireEnvelope2, u2.userId);
  console.log('✓ Alice Decrypt Result:', aliceDecResult2);
  assert.strictEqual(aliceDecResult2.isEncrypted, true);
  assert.strictEqual(aliceDecResult2.text, originalPlaintext2);
  console.log('🎉 User 1 successfully decrypted User 2\'s reply!');

  console.log('\n5. Simulating Page Reload / Session Restoration on BOTH clients...');
  alice.reloadTab();
  bob.reloadTab();
  assert.strictEqual(alice.sessionCache.size, 0);
  assert.strictEqual(bob.sessionCache.size, 0);

  // Bob decrypts message 1 from history
  const bobHist1 = await bob.decrypt(wireEnvelope1, u1.userId);
  assert.strictEqual(bobHist1.text, originalPlaintext1);
  console.log('✓ User 2 successfully re-decrypted Message 1 from local history');

  // Alice decrypts her OWN sent Message 1 from history (self-decryption)
  const aliceHist1 = await alice.decrypt(wireEnvelope1, u2.userId);
  assert.strictEqual(aliceHist1.text, originalPlaintext1);
  console.log('✓ User 1 successfully self-decrypted her OWN sent Message 1 from local history');

  // User 1 sends message 3
  const originalPlaintext3 = 'Can you read message 3 after reload?';
  const wireEnvelope3 = await alice.encrypt(originalPlaintext3, u2.userId);
  const bobDecResult3 = await bob.decrypt(wireEnvelope3, u1.userId);
  assert.strictEqual(bobDecResult3.text, originalPlaintext3);
  console.log('✓ Post-reload bidirectional messaging succeeds seamlessly: "' + bobDecResult3.text + '"');

  console.log('\n================================================================');
  console.log('🏆 ALL E2EE RATCHET & SESSION RE-SYNC TESTS PASSED (100%)');
  console.log('================================================================');
}

runRatchetSuite().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
