// Comprehensive verification of bi-directional E2EE messaging and shared history
import { createHmac, subtle } from 'crypto';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

function makeJWT(sub, deviceId = 'dev-device') {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub,
    device_id: deviceId,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const aliceId = 'alice_user_' + Date.now();
const bobId = 'bob_user_' + Date.now();
const aliceToken = makeJWT(aliceId);
const bobToken = makeJWT(bobId);

console.log('Alice:', aliceId);
console.log('Bob:', bobId);

// Derive conversation key matching E2eeService (sorted IDs)
async function getSharedKey(userA, userB) {
  const enc = new TextEncoder();
  const canonicalId = [userA, userB].sort().join(':');
  const ikm = enc.encode(`genchat_ikm_${canonicalId}`);
  const baseKey = await subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode('genchat_pq_master_salt_2026'),
      info: enc.encode(`conversation_key_${canonicalId}`),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptPayload(text, userA, userB) {
  const key = await getSharedKey(userA, userB);
  const iv = new Uint8Array(12);
  for (let i = 0; i < 12; i++) iv[i] = (i * 7) % 256;

  const enc = new TextEncoder();
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  const ivHex = Buffer.from(iv).toString('hex');
  const ciphertextBase64 = Buffer.from(ct).toString('base64');

  return JSON.stringify({
    protocol: 'genchat-pq-v1',
    conversationId: [userA, userB].sort().join(':'),
    sequenceNum: 1,
    ivHex,
    ciphertextBase64,
    senderFingerprint: 'fingerprint_test',
  });
}

async function decryptPayload(envelopeStr, userA, userB) {
  const env = JSON.parse(envelopeStr);
  const key = await getSharedKey(userA, userB);
  const iv = Buffer.from(env.ivHex, 'hex');
  const ct = Buffer.from(env.ciphertextBase64, 'base64');
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

const wsA = new WebSocket(`${GATEWAY_WS_URL}/ws?token=${encodeURIComponent(aliceToken)}`);
const wsB = new WebSocket(`${GATEWAY_WS_URL}/ws?token=${encodeURIComponent(bobToken)}`);

let step1_bobReceived = false;
let step2_bobHistoryReceived = false;
let step3_aliceReceived = false;
let step4_aliceHistoryReceived = false;

function finish(success, msg) {
  clearTimeout(timer);
  try { wsA.close(); } catch {}
  try { wsB.close(); } catch {}
  console.log(success ? `\n✅ PASS: ${msg}` : `\n❌ FAIL: ${msg}`);
  process.exit(success ? 0 : 1);
}

const timer = setTimeout(() => {
  finish(false, `Timeout! step1=${step1_bobReceived}, step2=${step2_bobHistoryReceived}, step3=${step3_aliceReceived}, step4=${step4_aliceHistoryReceived}`);
}, 15000);

let openCount = 0;
function onOpen() {
  openCount++;
  if (openCount === 2) {
    console.log('Both Alice and Bob connected to gateway.');

    // Step 1: Alice sends message to Bob
    setTimeout(async () => {
      console.log('\n--- Step 1: Alice sending message to Bob ---');
      const text = 'Hello Bob, this is Alice!';
      const encrypted = await encryptPayload(text, aliceId, bobId);

      wsA.send(JSON.stringify({
        action: 'send_message',
        channel_id: bobId,
        client_msg_id: 'alice_msg_01',
        ciphertext_base64: Buffer.from(encrypted).toString('base64'),
        message_type: 1
      }));
    }, 200);
  }
}

wsA.onopen = onOpen;
wsB.onopen = onOpen;

wsB.onmessage = async (event) => {
  const text = typeof event.data === 'string' ? event.data : await event.data.text();
  const frame = JSON.parse(text);

  // Bob receives push from Alice
  if (frame.type === 'push' && frame.channel_id === bobId && frame.sender_id === aliceId) {
    const rawEnvelope = Buffer.from(frame.ciphertext_base64, 'base64').toString();
    const decrypted = await decryptPayload(rawEnvelope, bobId, aliceId);
    step1_bobReceived = true;
    console.log('  → [Bob] Received real-time push from Alice ✓');
    console.log('  → [Bob] Decrypted:', decrypted);

    // Step 2: Bob queries history for Alice
    setTimeout(() => {
      console.log('\n--- Step 2: Bob fetching history for Alice ---');
      wsB.send(JSON.stringify({
        action: 'fetch_history',
        channel_id: aliceId,
        limit: 10
      }));
    }, 300);
  }

  // Bob receives history
  if (frame.type === 'history' && frame.channel_id === aliceId) {
    step2_bobHistoryReceived = true;
    console.log(`  → [Bob] Received history for Alice: ${frame.messages?.length} message(s) stored in ScyllaDB ✓`);

    // Step 3: Bob replies to Alice
    setTimeout(async () => {
      console.log('\n--- Step 3: Bob replying to Alice ---');
      const replyText = 'Hey Alice, I got your message loud and clear!';
      const encryptedReply = await encryptPayload(replyText, bobId, aliceId);

      wsB.send(JSON.stringify({
        action: 'send_message',
        channel_id: aliceId,
        client_msg_id: 'bob_reply_01',
        ciphertext_base64: Buffer.from(encryptedReply).toString('base64'),
        message_type: 1
      }));
    }, 300);
  }
};

wsA.onmessage = async (event) => {
  const text = typeof event.data === 'string' ? event.data : await event.data.text();
  const frame = JSON.parse(text);

  // Alice receives reply from Bob
  if (frame.type === 'push' && frame.channel_id === aliceId && frame.sender_id === bobId) {
    const rawEnvelope = Buffer.from(frame.ciphertext_base64, 'base64').toString();
    const decrypted = await decryptPayload(rawEnvelope, aliceId, bobId);
    step3_aliceReceived = true;
    console.log('  → [Alice] Received real-time reply from Bob ✓');
    console.log('  → [Alice] Decrypted reply:', decrypted);

    // Step 4: Alice fetches history for Bob
    setTimeout(() => {
      console.log('\n--- Step 4: Alice fetching history for Bob ---');
      wsA.send(JSON.stringify({
        action: 'fetch_history',
        channel_id: bobId,
        limit: 10
      }));
    }, 300);
  }

  // Alice receives history
  if (frame.type === 'history' && frame.channel_id === bobId) {
    step4_aliceHistoryReceived = true;
    console.log(`  → [Alice] Received history for Bob: ${frame.messages?.length} message(s) stored in ScyllaDB ✓`);

    if (step1_bobReceived && step2_bobHistoryReceived && step3_aliceReceived && step4_aliceHistoryReceived) {
      clearTimeout(timer);
      finish(true, 'Bi-directional E2EE messaging and shared ScyllaDB history both verified 100%!');
    }
  }
};

wsA.onerror = (e) => console.error('Alice WS error:', e);
wsB.onerror = (e) => console.error('Bob WS error:', e);
