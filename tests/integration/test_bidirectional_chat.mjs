// Comprehensive verification of bi-directional E2EE messaging and shared history
import { subtle } from 'crypto';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

async function provisionUser(displayName) {
  const res = await fetch(`${AUTH_HTTP_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) throw new Error(`Failed to provision ${displayName}: ${res.status} ${await res.text()}`);
  return await res.json();
}

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

async function openWebSocket(token, label) {
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
        const delay = 2000 * Math.pow(2, attempt - 1);
        console.error(`  ${err.message}. Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function runBidirectionalChatTest() {
  console.log('=== Testing Bi-directional E2EE Chat, History & Dedup ===\n');

  console.log('[Setup] Provisioning Alice and Bob via /dev-token...');
  const aliceData = await provisionUser('Bidir Alice');
  const bobData = await provisionUser('Bidir Bob');

  const aliceId = aliceData.user_id;
  const bobId = bobData.user_id;
  const aliceToken = aliceData.access_token;
  const bobToken = bobData.access_token;

  console.log(`✓ Alice: ${aliceId}`);
  console.log(`✓ Bob:   ${bobId}\n`);

  let passed = 0;
  let failed = 0;
  function assert(cond, msg) {
    if (cond) { console.log(`  ✓ PASS: ${msg}`); passed++; }
    else { console.error(`  ✗ FAIL: ${msg}`); failed++; }
  }

  console.log('[Setup] Connecting Alice and Bob to Gateway WebSocket...');
  const wsA = await openWebSocket(aliceToken, 'Alice');
  const wsB = await openWebSocket(bobToken, 'Bob');
  assert(true, 'Both Alice and Bob connected to gateway WebSocket');

  let step1_bobReceived = false;
  let step2_bobHistoryReceived = false;
  let step3_aliceReceived = false;
  let step4_aliceHistoryReceived = false;
  let step5_retryDedupVerified = false;
  let aliceMsg1Ack = null;
  let bobPushCount = 0;

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout! step1=${step1_bobReceived}, step2=${step2_bobHistoryReceived}, step3=${step3_aliceReceived}, step4=${step4_aliceHistoryReceived}, step5=${step5_retryDedupVerified}`));
      }, 25000);

      const done = () => { clearTimeout(timer); resolve(); };

      wsA.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(`Alice WS error: ${e?.error?.message || e?.message || String(e)}`));
      };
      wsB.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(`Bob WS error: ${e?.error?.message || e?.message || String(e)}`));
      };

      wsB.onmessage = async (event) => {
        try {
          const text = typeof event.data === 'string' ? event.data : await event.data.text();
          const frame = JSON.parse(text);

          if (frame.type === 'push' && frame.channel_id === bobId && frame.sender_id === aliceId) {
            bobPushCount++;
            const rawEnvelope = Buffer.from(frame.ciphertext_base64, 'base64').toString();
            const decrypted = await decryptPayload(rawEnvelope, bobId, aliceId);
            step1_bobReceived = true;
            console.log('  → [Bob] Received real-time push from Alice ✓');
            console.log('  → [Bob] Decrypted:', decrypted);

            setTimeout(() => {
              console.log('\n--- Step 2: Bob fetching history for Alice ---');
              wsB.send(JSON.stringify({
                action: 'fetch_history',
                channel_id: aliceId,
                limit: 10,
              }));
            }, 200);
          }

          if (frame.type === 'history' && frame.channel_id === aliceId) {
            step2_bobHistoryReceived = true;
            console.log(`  → [Bob] Received history for Alice: ${frame.messages?.length} message(s) stored in ScyllaDB ✓`);

            setTimeout(async () => {
              console.log('\n--- Step 3: Bob replying to Alice ---');
              const replyText = 'Hey Alice, I got your message loud and clear!';
              const encryptedReply = await encryptPayload(replyText, bobId, aliceId);

              wsB.send(JSON.stringify({
                action: 'send_message',
                channel_id: aliceId,
                client_msg_id: 'bob_reply_01',
                ciphertext_base64: Buffer.from(encryptedReply).toString('base64'),
                message_type: 1,
              }));
            }, 200);
          }
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      };

      wsA.onmessage = async (event) => {
        try {
          const text = typeof event.data === 'string' ? event.data : await event.data.text();
          const frame = JSON.parse(text);

          if (frame.type === 'ack' && frame.client_msg_id === 'alice_msg_01') {
            if (!aliceMsg1Ack) {
              aliceMsg1Ack = frame;
              console.log(`  → [Alice] Received initial ACK: server_id=${frame.message_id}, seq=${frame.sequence_num} ✓`);
            } else {
              console.log(`  → [Alice] Received retry ACK: server_id=${frame.message_id}, seq=${frame.sequence_num}`);
              if (frame.message_id === aliceMsg1Ack.message_id && frame.sequence_num === aliceMsg1Ack.sequence_num && frame.message_id) {
                step5_retryDedupVerified = true;
                console.log('  → [Alice] Verified retried message dedup returns identical metadata ✓');
                if (step1_bobReceived && step2_bobHistoryReceived && step3_aliceReceived && step4_aliceHistoryReceived) {
                  done();
                }
              } else {
                clearTimeout(timer);
                reject(new Error(`Dedup metadata mismatch: expected (${aliceMsg1Ack.message_id}, ${aliceMsg1Ack.sequence_num}), got (${frame.message_id}, ${frame.sequence_num})`));
              }
            }
          }

          if (frame.type === 'push' && frame.channel_id === aliceId && frame.sender_id === bobId) {
            const rawEnvelope = Buffer.from(frame.ciphertext_base64, 'base64').toString();
            const decrypted = await decryptPayload(rawEnvelope, aliceId, bobId);
            step3_aliceReceived = true;
            console.log('  → [Alice] Received real-time reply from Bob ✓');
            console.log('  → [Alice] Decrypted reply:', decrypted);

            setTimeout(() => {
              console.log('\n--- Step 4: Alice fetching history for Bob ---');
              wsA.send(JSON.stringify({
                action: 'fetch_history',
                channel_id: bobId,
                limit: 10,
              }));
            }, 200);
          }

          if (frame.type === 'history' && frame.channel_id === bobId) {
            step4_aliceHistoryReceived = true;
            console.log(`  → [Alice] Received history for Bob: ${frame.messages?.length} message(s) stored in ScyllaDB ✓`);

            setTimeout(async () => {
              console.log('\n--- Step 5: Alice retrying message alice_msg_01 (deduplication check) ---');
              const text = 'Hello Bob, this is Alice!';
              const encrypted = await encryptPayload(text, aliceId, bobId);

              wsA.send(JSON.stringify({
                action: 'send_message',
                channel_id: bobId,
                client_msg_id: 'alice_msg_01',
                ciphertext_base64: Buffer.from(encrypted).toString('base64'),
                message_type: 1,
              }));
            }, 200);
          }
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      };

      // Kick off Step 1
      setTimeout(async () => {
        try {
          console.log('\n--- Step 1: Alice sending message to Bob ---');
          const text = 'Hello Bob, this is Alice!';
          const encrypted = await encryptPayload(text, aliceId, bobId);

          wsA.send(JSON.stringify({
            action: 'send_message',
            channel_id: bobId,
            client_msg_id: 'alice_msg_01',
            ciphertext_base64: Buffer.from(encrypted).toString('base64'),
            message_type: 1,
          }));
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      }, 300);
    });
  } finally {
    try { wsA.close(); } catch {}
    try { wsB.close(); } catch {}
  }

  assert(step1_bobReceived, 'Bob received real-time push from Alice');
  assert(step2_bobHistoryReceived, 'Bob retrieved message history from ScyllaDB');
  assert(step3_aliceReceived, 'Alice received real-time reply from Bob');
  assert(step4_aliceHistoryReceived, 'Alice retrieved message history from ScyllaDB');
  assert(step5_retryDedupVerified, 'Message retry deduplication preserved server_id and sequence');

  console.log(`\n=== SUMMARY: ${passed} Passed, ${failed} Failed ===`);
  if (failed > 0) process.exit(1);
}

runBidirectionalChatTest().catch((err) => {
  console.error('\n❌ Fatal error in bidirectional chat test:', err.message || err);
  process.exit(1);
});

