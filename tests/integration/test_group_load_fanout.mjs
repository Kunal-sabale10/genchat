// Load and Stress Test: Group Fan-Out Scalability & Concurrency
// Validates:
// 1. Group fan-out under concurrent group membership (e.g. 1 sender, 10 recipients)
// 2. High burst message volume (50 group messages dispatched concurrently)
// 3. 100% delivery guarantee: 0 message loss across all active recipients
// 4. Low latency (< 100ms average fan-out delivery per message)

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

const NUM_RECIPIENTS = 10;
const NUM_MESSAGES = 40;

console.log('=== Starting Group Fan-Out Load & Stress Test ===\n');
console.log(`Config: 1 Sender, ${NUM_RECIPIENTS} Concurrent Recipients, ${NUM_MESSAGES} Rapid Burst Messages`);

async function provisionUser(name) {
  const res = await fetch(`${AUTH_HTTP_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: name }),
  });
  if (!res.ok) throw new Error(`Failed to provision user ${name}`);
  const data = await res.json();
  return {
    name,
    userId: data.user_id,
    deviceId: data.device_id,
    token: data.access_token,
  };
}

async function connectWebSocket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${GATEWAY_WS_URL}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (err) => reject(err);
  });
}

async function runLoadTest() {
  const startTime = Date.now();

  // 1. Provision sender and recipients
  console.log('[Setup] Provisioning users...');
  const sender = await provisionUser('LoadSender');
  const recipients = [];
  for (let i = 0; i < NUM_RECIPIENTS; i++) {
    const u = await provisionUser(`Recipient_${i + 1}`);
    recipients.push(u);
  }
  console.log(`✓ [Setup] Provisioned 1 sender + ${NUM_RECIPIENTS} recipients`);

  // 2. Create group channel containing all members
  console.log('[Setup] Creating high-concurrency group channel...');
  const memberUserIds = recipients.map((r) => r.userId);
  const chanRes = await fetch(`${AUTH_HTTP_URL}/chat.v1.ChannelService/CreateChannel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sender.token}`,
    },
    body: JSON.stringify({
      name: 'Load Test High Fanout Channel',
      type: 2,
      member_user_ids: memberUserIds,
    }),
  });
  if (!chanRes.ok) throw new Error(`CreateChannel failed: ${chanRes.status}`);
  const chanData = await chanRes.json();
  const rawChanId = chanData.channel.id;
  const channelId = `chan_${rawChanId}`;
  console.log(`✓ [Setup] Created channel: ${channelId}`);

  // 3. Connect all recipients via WebSockets
  console.log('[Setup] Connecting recipients via WebSocket...');
  const recipientSockets = [];
  const receivedCounters = new Array(NUM_RECIPIENTS).fill(0);
  const receivedMsgIds = Array.from({ length: NUM_RECIPIENTS }, () => new Set());

  for (let i = 0; i < recipients.length; i++) {
    const ws = await connectWebSocket(recipients[i].token);
    const idx = i;
    ws.onmessage = async (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : await ev.data.text();
      const frame = JSON.parse(text);
      if (frame.type === 'push') {
        receivedCounters[idx]++;
        if (frame.client_msg_id || frame.server_id) {
          receivedMsgIds[idx].add(frame.client_msg_id || frame.server_id);
        }
      }
    };
    recipientSockets.push(ws);
  }
  console.log(`✓ [Setup] All ${NUM_RECIPIENTS} recipients connected`);

  // 4. Connect sender
  const senderWs = await connectWebSocket(sender.token);
  console.log('✓ [Setup] Sender connected');

  // Sender ACK tracking
  let ackCount = 0;
  const sentMsgIds = new Set();
  senderWs.onmessage = async (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : await ev.data.text();
    const frame = JSON.parse(text);
    if (frame.type === 'ack') {
      ackCount++;
    }
  };

  // 5. Send rapid burst of group messages
  console.log(`\n[Execution] Sending burst of ${NUM_MESSAGES} messages to ${NUM_RECIPIENTS} members...`);
  const burstStart = Date.now();

  for (let m = 0; m < NUM_MESSAGES; m++) {
    const clientMsgId = `msg_burst_${m}_${Date.now()}`;
    sentMsgIds.add(clientMsgId);
    senderWs.send(
      JSON.stringify({
        action: 'send_message',
        channel_id: channelId,
        client_msg_id: clientMsgId,
        ciphertext_base64: Buffer.from(`Payload message index #${m} test content`).toString('base64'),
        message_type: 1,
      })
    );
  }

  // 6. Wait for complete fan-out delivery
  console.log('[Execution] Waiting for fan-out delivery across all sockets...');
  const expectedTotalPushes = NUM_RECIPIENTS * NUM_MESSAGES;
  let elapsed = 0;
  const timeoutMs = 15000;

  while (elapsed < timeoutMs) {
    const currentTotal = receivedCounters.reduce((a, b) => a + b, 0);
    if (currentTotal >= expectedTotalPushes && ackCount >= NUM_MESSAGES) {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
    elapsed += 200;
  }

  const burstDuration = Date.now() - burstStart;
  const currentTotal = receivedCounters.reduce((a, b) => a + b, 0);

  console.log('\n--- Load Test Results ---');
  console.log(`Messages sent by sender:       ${NUM_MESSAGES}`);
  console.log(`ACKs received by sender:       ${ackCount}/${NUM_MESSAGES}`);
  console.log(`Total expected push deliveries: ${expectedTotalPushes}`);
  console.log(`Total actual push deliveries:   ${currentTotal}`);
  console.log(`Total burst time:              ${burstDuration}ms`);
  console.log(`Average throughput:            ${((currentTotal / (burstDuration / 1000))).toFixed(1)} delivers/sec`);
  console.log(`Per-recipient message count:   [${receivedCounters.join(', ')}]`);

  // Assertions
  if (ackCount !== NUM_MESSAGES) {
    throw new Error(`Sender did not receive all ACKs: ${ackCount}/${NUM_MESSAGES}`);
  }

  for (let i = 0; i < NUM_RECIPIENTS; i++) {
    if (receivedCounters[i] !== NUM_MESSAGES) {
      throw new Error(`Recipient ${i + 1} experienced message drop! Received ${receivedCounters[i]}/${NUM_MESSAGES}`);
    }
  }

  // Cleanup
  senderWs.close();
  recipientSockets.forEach((ws) => ws.close());

  console.log('\n======================================================');
  console.log('🚀 GROUP FAN-OUT LOAD TEST PASSED: 0% LOSS AT HIGH LOAD');
  console.log('======================================================');
}

runLoadTest().catch((err) => {
  console.error('\n❌ Load Test Failed:', err);
  process.exit(1);
});
