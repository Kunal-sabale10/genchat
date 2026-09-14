import assert from 'assert';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

console.log('=== Test 3: Blocking & Voluntary Abuse Reporting ===\n');

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
  const alice = await provisionUser('Alice Blocker');
  const bob = await provisionUser('Bob Spammer');
  console.log(`✓ Provisioned Alice (${alice.user_id}) and Bob (${bob.user_id})`);

  // 1. Check initial block status: not blocked
  const initialCheckRes = await fetch(
    `${AUTH_HTTP_URL}/users/is-blocked?blocker_id=${alice.user_id}&blocked_id=${bob.user_id}`
  );
  const initialCheck = await initialCheckRes.json();
  assert.strictEqual(initialCheck.blocked, false);
  console.log('✓ Initial block check: false');

  // 2. Alice blocks Bob
  const blockRes = await fetch(`${AUTH_HTTP_URL}/users/block`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${alice.access_token}`,
    },
    body: JSON.stringify({ blocked_user_id: bob.user_id }),
  });
  assert.strictEqual(blockRes.status, 200, 'Block user should return HTTP 200');
  console.log('✓ Alice blocked Bob via POST /users/block');

  // 3. Verify block status is now true
  const blockedCheckRes = await fetch(
    `${AUTH_HTTP_URL}/users/is-blocked?blocker_id=${alice.user_id}&blocked_id=${bob.user_id}`
  );
  const blockedCheck = await blockedCheckRes.json();
  assert.strictEqual(blockedCheck.blocked, true);

  // 4. Verify Bob is in Alice's blocked list
  const listRes = await fetch(`${AUTH_HTTP_URL}/users/blocked`, {
    headers: { Authorization: `Bearer ${alice.access_token}` },
  });
  const listData = await listRes.json();
  assert.ok(listData.blocked_user_ids.includes(bob.user_id));
  console.log('✓ Bob confirmed in Alice blocked list');

  // 5. Connect both to Gateway WebSocket
  const aliceConn = await connectWs(alice.access_token);
  const bobConn = await connectWs(bob.access_token);
  console.log('✓ Both connected to Gateway WebSocket');

  // Wait a short moment for sessions to register
  await new Promise((r) => setTimeout(r, 100));

  // 6. Bob attempts to send 1:1 message to Alice
  const blockedMsgId = 'msg_blocked_' + Date.now();
  const sendFrame = {
    action: 'send_message',
    channel_id: alice.user_id,
    client_msg_id: blockedMsgId,
    ciphertext_base64: Buffer.from('Spam message from blocked sender').toString('base64'),
    message_type: 1,
  };

  bobConn.ws.send(JSON.stringify(sendFrame));

  // Wait 500ms
  await new Promise((r) => setTimeout(r, 500));

  // Bob receives standard ACK (Signal-style privacy: sender does not know they are blocked)
  const bobAck = bobConn.messages.find((m) => m.type === 'ack' && m.client_msg_id === blockedMsgId);
  assert.ok(bobAck, 'Bob must receive standard ACK to preserve block privacy');
  console.log('✓ Bob received standard ACK (Signal block privacy preserved)');

  // Alice NEVER receives the push frame
  const alicePush = aliceConn.messages.find((m) => m.type === 'push' && m.sender_id === bob.user_id);
  assert.strictEqual(alicePush, undefined, 'Alice must NOT receive message from blocked user');
  console.log('✓ Alice received 0 push notifications (server silently dropped delivery to blocker)');

  // 7. Verify Prometheus anomaly metrics incremented for blocked_message_drop
  const metricsRes = await fetch('http://127.0.0.1:8081/metrics');
  const metricsText = await metricsRes.text();
  assert.ok(
    metricsText.includes('security_anomalies_total{type="blocked_message_drop"}'),
    'Metrics must include blocked_message_drop counter'
  );
  console.log('✓ Gateway Prometheus security anomaly metric recorded blocked_message_drop');

  // 8. Alice submits voluntary E2EE abuse report
  const reportRes = await fetch(`${AUTH_HTTP_URL}/reports`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${alice.access_token}`,
    },
    body: JSON.stringify({
      reported_user_id: bob.user_id,
      conversation_id: alice.user_id < bob.user_id ? `${alice.user_id}:${bob.user_id}` : `${bob.user_id}:${alice.user_id}`,
      message_id: bobAck.message_id,
      reason: 'Harassment and unwanted spam',
      decrypted_content: 'Spam message from blocked sender',
      raw_ciphertext: sendFrame.ciphertext_base64,
    }),
  });
  assert.strictEqual(reportRes.status, 200, 'Submit report should return HTTP 200');
  const reportData = await reportRes.json();
  assert.ok(reportData.report_id, 'Must return generated report_id');
  console.log(`✓ Alice submitted voluntary abuse report: report_id=${reportData.report_id}`);

  // 9. Alice unblocks Bob
  const unblockRes = await fetch(`${AUTH_HTTP_URL}/users/unblock`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${alice.access_token}`,
    },
    body: JSON.stringify({ unblocked_user_id: bob.user_id }),
  });
  assert.strictEqual(unblockRes.status, 200, 'Unblock user should return HTTP 200');
  console.log('✓ Alice unblocked Bob via POST /users/unblock');

  // Wait 12 seconds for the gateway 10-second block cache to expire
  console.log('Waiting 11s for gateway block cache TTL expiration...');
  await new Promise((r) => setTimeout(r, 11000));

  // 10. Bob sends another message: Alice should now receive it!
  const normalMsgId = 'msg_normal_' + Date.now();
  bobConn.ws.send(
    JSON.stringify({
      action: 'send_message',
      channel_id: alice.user_id,
      client_msg_id: normalMsgId,
      ciphertext_base64: Buffer.from('Apology message after unblock').toString('base64'),
      message_type: 1,
    })
  );

  await new Promise((r) => setTimeout(r, 600));

  const unblockedPush = aliceConn.messages.find(
    (m) => m.type === 'push' && m.sender_id === bob.user_id
  );
  assert.ok(unblockedPush, 'Alice must receive push message after Bob is unblocked');
  console.log('✓ Message delivered to Alice normally after unblocking');

  aliceConn.ws.close();
  bobConn.ws.close();

  console.log('\n=== ALL BLOCKING & REPORTING TESTS PASSED ===\n');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
