import assert from 'assert';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

console.log('=== Test: Exactly-Once Delivery Resilience Across Mid-Flight Retries & Restarts ===\n');

async function provisionUser(name) {
  const res = await fetch(`${AUTH_HTTP_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: name, user_id: crypto.randomUUID(), device_id: crypto.randomUUID() }),
  });
  if (!res.ok) throw new Error(`Failed to provision user: ${res.status}`);
  return await res.json();
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${GATEWAY_WS_URL}/ws?token=${encodeURIComponent(token)}`);
    const messages = [];

    ws.addEventListener('open', () => resolve({ ws, messages }));
    ws.addEventListener('error', (err) => reject(err));
    ws.addEventListener('message', async (event) => {
      let text;
      if (typeof event.data === 'string') {
        text = event.data;
      } else if (event.data instanceof Blob) {
        text = await event.data.text();
      } else if (event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data)) {
        text = Buffer.from(event.data).toString('utf8');
      } else {
        text = String(event.data);
      }
      try {
        messages.push(JSON.parse(text));
      } catch {
        messages.push(text);
      }
    });
  });
}

async function run() {
  const alice = await provisionUser('Alice Sender');
  const bob = await provisionUser('Bob Receiver');
  console.log(`✓ Provisioned Alice (${alice.user_id}) and Bob (${bob.user_id})`);

  // Connect Alice and Bob
  const { ws: aliceWs, messages: aliceMsgs } = await connectWs(alice.access_token);
  const { ws: bobWs, messages: bobMsgs } = await connectWs(bob.access_token);
  console.log('✓ Connected Alice and Bob to Gateway');

  const clientMsgId = `midflight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ciphertext = Buffer.from('confidential-exactly-once-payload').toString('base64');

  // 1. Initial Send from Alice to Bob
  aliceWs.send(
    JSON.stringify({
      action: 'send_message',
      channel_id: bob.user_id,
      client_msg_id: clientMsgId,
      ciphertext_base64: ciphertext,
      message_type: 1,
    })
  );

  // Wait for Bob to receive message and Alice to receive ACK
  let ack1 = null;
  let bobDelivery1 = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!ack1) {
      ack1 = aliceMsgs.find((m) => m.type === 'ack' && m.client_msg_id === clientMsgId);
    }
    if (!bobDelivery1) {
      bobDelivery1 = bobMsgs.find((m) => m.type === 'push' && m.sender_id === alice.user_id && m.ciphertext_base64 === ciphertext);
    }
    if (ack1 && bobDelivery1) break;
  }

  assert.ok(ack1, 'Alice should receive ACK on initial send');
  assert.ok(bobDelivery1, 'Bob should receive first push delivery');
  console.log(`✓ Initial delivery verified. Server message_id: ${ack1.message_id}, seq: ${ack1.sequence_num}`);

  // 2. Simulate connection interruption & reconnect mid-flight
  aliceWs.close();
  await new Promise((r) => setTimeout(r, 200));

  const { ws: aliceWs2, messages: aliceMsgs2 } = await connectWs(alice.access_token);
  console.log('✓ Alice reconnected after simulated mid-flight interruption');

  // 3. Alice retries sending the same message with the exact same client_msg_id
  const bobCountBeforeRetry = bobMsgs.filter((m) => m.type === 'push' && m.sender_id === alice.user_id && m.ciphertext_base64 === ciphertext).length;
  assert.strictEqual(bobCountBeforeRetry, 1, 'Bob should have exactly 1 message before retry');

  aliceWs2.send(
    JSON.stringify({
      action: 'send_message',
      channel_id: bob.user_id,
      client_msg_id: clientMsgId,
      ciphertext_base64: ciphertext,
      message_type: 1,
    })
  );

  // Alice must receive ACK confirming the sequence number
  let ack2 = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    ack2 = aliceMsgs2.find((m) => m.type === 'ack' && m.client_msg_id === clientMsgId);
    if (ack2) break;
  }

  assert.ok(ack2, 'Alice should receive ACK on retry');
  assert.strictEqual(ack2.message_id, ack1.message_id, 'ACK should return the original message_id');
  console.log('✓ Sender received deduplicated ACK with identical message_id.');

  // Give any erroneous push time to arrive
  await new Promise((r) => setTimeout(r, 500));

  // 4. Bob must NOT have received a duplicate delivery
  const bobCountAfterRetry = bobMsgs.filter((m) => m.type === 'push' && m.sender_id === alice.user_id && m.ciphertext_base64 === ciphertext).length;
  assert.strictEqual(
    bobCountAfterRetry,
    1,
    `Exactly-once violation: Bob received ${bobCountAfterRetry} deliveries, expected exactly 1`
  );
  console.log('✓ Exactly-once invariant confirmed: Recipient received 0 duplicate deliveries.');

  aliceWs2.close();
  bobWs.close();

  console.log('\n=== All Exactly-Once Delivery Tests Passed! ===\n');
}

run().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
