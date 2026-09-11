// Integration Test Suite: Cryptographic Message Reactions & Quoted / Threaded Replies
// Verifies:
// 1. WebSocket reaction frame relay ('reaction' action -> 'reaction' push frame)
// 2. Reaction add/remove operations, emoji deduplication, and user list aggregation
// 3. End-to-end encrypted quoted replies (replyTo packaged in ciphertext, zero server leakage)
// 4. Live Gateway WebSocket roundtrip between two provisioned users (Alice & Bob)

import assert from 'assert';
import crypto, { subtle } from 'crypto';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

console.log('=== Starting Cryptographic Message Reactions & Quoted Replies Test Suite ===\n');

// -------------------------------------------------------------
// Part 1: Reaction State Aggregation & Deduplication Logic
// -------------------------------------------------------------
console.log('--- Testing Client Reaction State Aggregation ---');

function applyReaction(reactions, emoji, userId, op) {
  const next = { ...(reactions || {}) };
  const currentUsers = new Set(next[emoji] || []);

  if (op === 'remove') {
    currentUsers.delete(userId);
    if (currentUsers.size === 0) {
      delete next[emoji];
    } else {
      next[emoji] = Array.from(currentUsers);
    }
  } else {
    currentUsers.add(userId);
    next[emoji] = Array.from(currentUsers);
  }
  return next;
}

let reactions = {};

// Alice reacts 👍
reactions = applyReaction(reactions, '👍', 'alice', 'add');
assert.deepStrictEqual(reactions['👍'], ['alice'], 'Alice reaction should be recorded');

// Alice reacts again 👍 (idempotent duplicate add)
reactions = applyReaction(reactions, '👍', 'alice', 'add');
assert.deepStrictEqual(reactions['👍'], ['alice'], 'Duplicate reaction from Alice must be deduplicated');

// Bob reacts 👍
reactions = applyReaction(reactions, '👍', 'bob', 'add');
assert.strictEqual(reactions['👍'].length, 2, 'Both Alice and Bob should be recorded for 👍');
assert(reactions['👍'].includes('alice') && reactions['👍'].includes('bob'));

// Bob reacts ❤️
reactions = applyReaction(reactions, '❤️', 'bob', 'add');
assert.strictEqual(reactions['❤️'].length, 1);
assert.strictEqual(reactions['❤️'][0], 'bob');

// Alice removes 👍
reactions = applyReaction(reactions, '👍', 'alice', 'remove');
assert.deepStrictEqual(reactions['👍'], ['bob'], 'Only Bob should remain for 👍');

// Bob removes 👍 (last user for emoji)
reactions = applyReaction(reactions, '👍', 'bob', 'remove');
assert.strictEqual(reactions['👍'], undefined, 'Emoji key should be pruned when user count reaches 0');
assert.strictEqual(reactions['❤️'].length, 1, '❤️ reaction should remain untouched');

console.log('✓ Reaction state aggregation and idempotent deduplication verified.');

// -------------------------------------------------------------
// Part 2: End-to-End Encrypted Quoted Reply Packaging
// -------------------------------------------------------------
console.log('\n--- Testing E2EE Quoted Reply Payload Privacy ---');

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

async function encryptE2eeMessage(text, replyTo, sender, recipient) {
  const payloadToEncrypt = JSON.stringify({
    text,
    replyTo: replyTo || undefined,
  });

  const key = await getSharedKey(sender, recipient);
  const iv = crypto.randomBytes(12);
  const enc = new TextEncoder();
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(payloadToEncrypt));

  return {
    protocol: 'genchat-pq-v1',
    ivHex: Buffer.from(iv).toString('hex'),
    ciphertextBase64: Buffer.from(ct).toString('base64'),
    senderFingerprint: `fp_${sender}`,
  };
}

async function decryptE2eeMessage(envelope, sender, recipient) {
  const key = await getSharedKey(sender, recipient);
  const iv = Buffer.from(envelope.ivHex, 'hex');
  const ct = Buffer.from(envelope.ciphertextBase64, 'base64');
  const decryptedBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  const decryptedStr = new TextDecoder().decode(decryptedBuf);
  return JSON.parse(decryptedStr);
}

const originalAliceMessage = {
  id: 'msg_alice_101',
  senderId: 'alice',
  senderName: 'Alice Springs',
  snippet: 'Hey Bob, what do you think of the new architecture?',
};

// Bob creates a quoted reply to Alice
const bobReplyPayload = await encryptE2eeMessage(
  'Looks fantastic! The zero-knowledge design is rock solid.',
  {
    messageId: originalAliceMessage.id,
    senderId: originalAliceMessage.senderId,
    senderName: originalAliceMessage.senderName,
    snippet: originalAliceMessage.snippet,
  },
  'bob',
  'alice'
);

// Verify server cannot see plaintext text or quote snippet
const rawWireStr = JSON.stringify(bobReplyPayload);
assert(!rawWireStr.includes('Looks fantastic!'), 'Plaintext reply text must not appear on the wire');
assert(!rawWireStr.includes('Alice Springs'), 'Quoted sender name must not appear in plaintext on the wire');
assert(!rawWireStr.includes('new architecture'), 'Quoted snippet must not appear in plaintext on the wire');
console.log('✓ Quoted reply completely shielded inside AES-GCM ciphertext (zero server plaintext leakage).');

// Alice decrypts the message
const decryptedByAlice = await decryptE2eeMessage(bobReplyPayload, 'alice', 'bob');
assert.strictEqual(decryptedByAlice.text, 'Looks fantastic! The zero-knowledge design is rock solid.');
assert.strictEqual(decryptedByAlice.replyTo.messageId, 'msg_alice_101');
assert.strictEqual(decryptedByAlice.replyTo.senderName, 'Alice Springs');
assert.strictEqual(decryptedByAlice.replyTo.snippet, 'Hey Bob, what do you think of the new architecture?');
console.log('✓ Alice successfully decrypted quoted reply and recovered exact quote context.');

// -------------------------------------------------------------
// Part 3: Live Gateway WebSocket Roundtrip (Alice & Bob)
// -------------------------------------------------------------
console.log('\n--- Testing Live Gateway WebSocket Reaction & Reply Relay ---');

async function provisionUser(displayName) {
  const res = await fetch(`${AUTH_HTTP_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) throw new Error(`Failed to provision ${displayName}: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function openWs(token, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${GATEWAY_WS_URL}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`WebSocket connection timed out for ${label}`));
    }, 10000);

    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error for ${label}: ${e.message || e}`));
    };
  });
}

try {
  console.log('[Setup] Provisioning Alice and Bob via /dev-token...');
  const aliceData = await provisionUser('Alice_ReactionTest');
  const bobData = await provisionUser('Bob_ReactionTest');
  const aliceId = aliceData.user_id;
  const bobId = bobData.user_id;
  const aliceToken = aliceData.access_token;
  const bobToken = bobData.access_token;
  console.log(`✓ Alice: ${aliceId}, Bob: ${bobId}`);

  console.log('[Setup] Connecting Alice and Bob to Gateway WebSocket...');
  const wsAlice = await openWs(aliceToken, 'Alice');
  const wsBob = await openWs(bobToken, 'Bob');
  console.log('✓ Both WebSockets connected.');

  const aliceInbox = [];
  wsAlice.onmessage = async (event) => {
    try {
      const text = typeof event.data === 'string' ? event.data : await event.data.text();
      const msg = JSON.parse(text);
      aliceInbox.push(msg);
    } catch (e) {
      console.error('[Alice WS parse error]:', e);
    }
  };

  const bobInbox = [];
  wsBob.onmessage = async (event) => {
    try {
      const text = typeof event.data === 'string' ? event.data : await event.data.text();
      const msg = JSON.parse(text);
      bobInbox.push(msg);
    } catch (e) {
      console.error('[Bob WS parse error]:', e);
    }
  };

  // 1. Alice sends a direct message to Bob
  const testMsgId = `test_msg_${Date.now()}`;
  console.log(`[Flow] Alice sending message ${testMsgId} to Bob...`);
  wsAlice.send(JSON.stringify({
    action: 'send_message',
    channel_id: bobId,
    client_msg_id: testMsgId,
    ciphertext_base64: Buffer.from('Initial message for reactions').toString('base64'),
    message_type: 1,
  }));

  // Wait for Bob to receive push frame
  await new Promise((r) => setTimeout(r, 600));
  const bobMsg = bobInbox.find((m) => m.type === 'push');
  assert(bobMsg, 'Bob must receive the message from Alice');
  console.log(`✓ Bob received Alice's push frame (clientMsgId=${testMsgId})`);

  // 2. Bob sends reaction (❤️, op: "add")
  console.log('[Flow] Bob sending reaction ❤️ (op: add)...');
  wsBob.send(JSON.stringify({
    action: 'reaction',
    channel_id: aliceId,
    target_id: testMsgId,
    target_msg_id: testMsgId,
    emoji: '❤️',
    op: 'add',
  }));

  // Wait for reaction broadcast
  await new Promise((r) => setTimeout(r, 600));

  const aliceReactionAdd = aliceInbox.find(
    (m) => m.type === 'reaction' && m.emoji === '❤️' && m.op === 'add'
  );
  assert(aliceReactionAdd, 'Alice must receive the reaction push frame from Bob');
  assert.strictEqual(aliceReactionAdd.target_id || aliceReactionAdd.target_msg_id, testMsgId);
  assert.strictEqual(aliceReactionAdd.sender_id, bobId);
  console.log('✓ Alice received reaction push frame: Bob reacted with ❤️');

  // Bob should also receive an echo push of his reaction
  const bobReactionAdd = bobInbox.find(
    (m) => m.type === 'reaction' && m.emoji === '❤️' && m.op === 'add'
  );
  assert(bobReactionAdd, 'Bob must receive an echo reaction push frame');
  console.log('✓ Bob received reaction echo push frame');

  // 3. Bob removes reaction (❤️, op: "remove")
  console.log('[Flow] Bob removing reaction ❤️ (op: remove)...');
  wsBob.send(JSON.stringify({
    action: 'reaction',
    channel_id: aliceId,
    target_id: testMsgId,
    target_msg_id: testMsgId,
    emoji: '❤️',
    op: 'remove',
  }));

  await new Promise((r) => setTimeout(r, 600));

  const aliceReactionRemove = aliceInbox.find(
    (m) => m.type === 'reaction' && m.emoji === '❤️' && m.op === 'remove'
  );
  assert(aliceReactionRemove, 'Alice must receive the reaction remove push frame');
  assert.strictEqual(aliceReactionRemove.target_id || aliceReactionRemove.target_msg_id, testMsgId);
  console.log('✓ Alice received reaction remove push frame');

  // 4. Bob sends quoted reply with reply_to_message_id
  const replyMsgId = `reply_msg_${Date.now()}`;
  console.log('[Flow] Bob sending quoted reply...');
  wsBob.send(JSON.stringify({
    action: 'send_message',
    channel_id: aliceId,
    client_msg_id: replyMsgId,
    ciphertext_base64: Buffer.from(JSON.stringify(bobReplyPayload)).toString('base64'),
    message_type: 1,
    reply_to_message_id: testMsgId,
  }));

  await new Promise((r) => setTimeout(r, 600));

  const aliceReplyPush = aliceInbox.find(
    (m) => m.type === 'push' && (m.client_msg_id === replyMsgId || m.reply_to_message_id === testMsgId)
  );
  assert(aliceReplyPush, 'Alice must receive Bob\'s quoted reply push frame');
  assert.strictEqual(aliceReplyPush.reply_to_message_id, testMsgId, 'reply_to_message_id wire attribute must match targetMsgId');
  console.log(`✓ Alice received quoted reply push frame (reply_to_message_id: ${aliceReplyPush.reply_to_message_id})`);

  // Alice decrypts the E2EE quoted reply
  const rawDecoded = Buffer.from(aliceReplyPush.ciphertext_base64, 'base64').toString('utf8');
  const decryptedObj = await decryptE2eeMessage(JSON.parse(rawDecoded), 'alice', 'bob');
  assert.strictEqual(decryptedObj.replyTo.messageId, 'msg_alice_101');
  console.log('✓ Alice decrypted quoted reply from live wire push frame successfully!');

  // Cleanup
  wsAlice.close();
  wsBob.close();
  console.log('\n=== All Cryptographic Reaction & Quoted Reply Tests Passed Successfully! ===');
  process.exit(0);
} catch (err) {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
}
