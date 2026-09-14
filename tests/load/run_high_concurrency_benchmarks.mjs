import assert from 'assert';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

const CONCURRENT_CLIENTS = parseInt(process.env.CONCURRENT_CLIENTS || '100', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '150', 10);
const MSG_RATE_PER_SEC = parseInt(process.env.MSG_RATE_PER_SEC || '30', 10);

console.log('================================================================');
console.log('=== GenChat Enterprise High-Concurrency Load Benchmark Suite ===');
console.log(`=== Target Clients: ${CONCURRENT_CLIENTS} | Message Batch: ${BATCH_SIZE} | Rate: ${MSG_RATE_PER_SEC} msgs/s ===`);
console.log('================================================================\n');

async function provisionUser(idx) {
  const res = await fetch(`${AUTH_HTTP_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      display_name: `BenchUser_${idx}`,
      user_id: crypto.randomUUID(),
      device_id: crypto.randomUUID(),
    }),
  });
  if (!res.ok) throw new Error(`Failed to provision user ${idx}: ${res.status}`);
  return await res.json();
}

function connectWs(token, userId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${GATEWAY_WS_URL}/ws?token=${encodeURIComponent(token)}`);
    const received = [];

    ws.addEventListener('open', () => resolve({ ws, userId, received }));
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
        const frame = JSON.parse(text);
        if (frame.type === 'push' || frame.type === 'ack') {
          frame._receivedAt = Date.now();
          received.push(frame);
        }
      } catch {}
    });
  });
}

function calculatePercentiles(latencies) {
  if (latencies.length === 0) return { p50: 0, p90: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const p = (pct) => sorted[Math.min(Math.floor((pct / 100) * sorted.length), sorted.length - 1)];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: (sum / sorted.length).toFixed(2),
    p50: p(50),
    p90: p(90),
    p95: p(95),
    p99: p(99),
  };
}

async function run() {
  console.log(`[Stage 1] Provisioning ${CONCURRENT_CLIENTS} accounts concurrently...`);
  const startProv = Date.now();
  const users = await Promise.all(
    Array.from({ length: CONCURRENT_CLIENTS }, (_, i) => provisionUser(i + 1))
  );
  console.log(`✓ Provisioned ${users.length} accounts in ${Date.now() - startProv}ms`);

  console.log(`\n[Stage 2] Establishing ${CONCURRENT_CLIENTS} concurrent WebSocket connections...`);
  const startConn = Date.now();
  const connections = await Promise.all(
    users.map((u) => connectWs(u.access_token, u.user_id))
  );
  console.log(`✓ All ${connections.length} WebSockets connected and handshaken in ${Date.now() - startConn}ms`);

  console.log(`\n[Stage 3] Dispatching ${BATCH_SIZE} broadcast messages at ${MSG_RATE_PER_SEC} msgs/s to chan_public...`);
  const sentMessages = new Map();
  const intervalMs = 1000 / MSG_RATE_PER_SEC;
  let sentCount = 0;

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (sentCount >= BATCH_SIZE) {
        clearInterval(timer);
        resolve();
        return;
      }
      const sender = connections[sentCount % connections.length];
      const clientMsgId = `bench_${Date.now()}_${sentCount}_${Math.random().toString(36).substring(2, 6)}`;
      const now = Date.now();
      sentMessages.set(clientMsgId, now);

      sender.ws.send(
        JSON.stringify({
          action: 'send_message',
          channel_id: 'chan_public',
          client_msg_id: clientMsgId,
          ciphertext_base64: Buffer.from(`Benchmark payload ${sentCount}`).toString('base64'),
          message_type: 1,
        })
      );
      sentCount++;
    }, intervalMs);
  });

  console.log(`✓ Dispatched ${sentCount} messages. Awaiting fan-out convergence (3s)...`);
  await new Promise((r) => setTimeout(r, 3000));

  console.log(`\n[Stage 4] Compiling Latency and Throughput Statistics...`);
  const ackLatencies = [];
  let totalPushes = 0;

  for (const c of connections) {
    for (const msg of c.received) {
      if (msg.type === 'ack') {
        const sentTime = sentMessages.get(msg.client_msg_id);
        if (sentTime) {
          ackLatencies.push(msg._receivedAt - sentTime);
        }
      } else if (msg.type === 'push') {
        totalPushes++;
      }
    }
  }

  const ackStats = calculatePercentiles(ackLatencies);

  // Close all sockets
  for (const c of connections) {
    try { c.ws.close(); } catch {}
  }

  console.log('\n================================================================');
  console.log('                 HIGH-SCALE BENCHMARK RESULTS                   ');
  console.log('================================================================');
  console.log(`Concurrent Clients       : ${CONCURRENT_CLIENTS}`);
  console.log(`Total Messages Sent      : ${sentCount}`);
  console.log(`Total ACKs Received      : ${ackLatencies.length} (${((ackLatencies.length / sentCount) * 100).toFixed(1)}%)`);
  console.log(`Total Fan-Out Pushes     : ${totalPushes}`);
  console.log(`Expected Deliveries      : ~${sentCount * (CONCURRENT_CLIENTS - 1)}`);
  console.log('----------------------------------------------------------------');
  console.log('ScyllaDB Write & Gateway Dispatch Latency:');
  console.log(`  Min : ${ackStats.min} ms`);
  console.log(`  Avg : ${ackStats.avg} ms`);
  console.log(`  p50 : ${ackStats.p50} ms`);
  console.log(`  p90 : ${ackStats.p90} ms`);
  console.log(`  p95 : ${ackStats.p95} ms`);
  console.log(`  p99 : ${ackStats.p99} ms`);
  console.log(`  Max : ${ackStats.max} ms`);
  console.log('================================================================\n');

  assert.ok(ackLatencies.length > 0, 'Must receive ACKs for sent messages');
  assert.ok(ackStats.p95 < 1500, `p95 ACK latency must be under 1500ms under load, got ${ackStats.p95}ms`);
  console.log('✓ High-concurrency throughput and SLA criteria verified!');
}

run().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
