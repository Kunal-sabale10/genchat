import assert from 'assert';
import { execSync, spawn } from 'child_process';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';
const REDIS_CONTAINER = process.env.REDIS_CONTAINER || 'deploy-redis-1';

console.log('=== Test: Cross-Pod Gateway Message Routing & Redis Presence ===\n');

function redisGet(key) {
  try {
    const out = execSync(`docker exec ${REDIS_CONTAINER} redis-cli get "${key}"`).toString().trim();
    if (!out || out === 'nil' || out === '(nil)') return null;
    return out;
  } catch {
    return null;
  }
}

function redisSet(key, value) {
  execSync(`docker exec ${REDIS_CONTAINER} redis-cli set "${key}" "${value}"`);
}

function redisSMembers(key) {
  try {
    const out = execSync(`docker exec ${REDIS_CONTAINER} redis-cli smembers "${key}"`).toString().trim();
    if (!out) return [];
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function redisSAdd(key, value) {
  execSync(`docker exec ${REDIS_CONTAINER} redis-cli sadd "${key}" "${value}"`);
}

function redisPublish(channel, message) {
  const safeMsg = message.replace(/"/g, '\\"');
  execSync(`docker exec ${REDIS_CONTAINER} redis-cli publish "${channel}" "${safeMsg}"`);
}

function subscribeChannel(channel, onMessage) {
  const proc = spawn('docker', ['exec', REDIS_CONTAINER, 'redis-cli', 'subscribe', channel]);
  let buffer = '';
  proc.stdout.on('data', (data) => {
    buffer += data.toString();
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || '';
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 'message' && i + 2 < parts.length) {
        onMessage(parts[i + 2]);
      }
    }
  });
  return () => {
    proc.kill();
  };
}

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
  const ping = execSync(`docker exec ${REDIS_CONTAINER} redis-cli ping`).toString().trim();
  assert.strictEqual(ping, 'PONG', 'Redis must respond with PONG');
  console.log('✓ Connected to Redis (PONG confirmed)');

  const alice = await provisionUser('Alice Local');
  const bob = await provisionUser('Bob Remote');
  console.log(`✓ Provisioned Alice (${alice.user_id}) and Bob (${bob.user_id})`);

  // 1. Connect Alice to gatewayd WebSocket
  const { ws: aliceWs, messages: aliceMsgs } = await connectWs(alice.access_token);
  console.log('✓ Alice connected to Gateway WebSocket');

  // Wait for Redis registration
  await new Promise((r) => setTimeout(r, 600));

  // 2. Verify Alice's presence directory keys in Redis
  const aliceInstance = redisGet(`user:${alice.user_id}:gateway_instance`);
  assert.ok(aliceInstance, 'Alice gateway_instance key should exist in Redis');
  const aliceGateways = redisSMembers(`user:${alice.user_id}:gateways`);
  assert.ok(aliceGateways.includes(aliceInstance), 'Alice gateways set should contain the instance ID');
  console.log(`✓ Redis presence directory verified: user:${alice.user_id}:gateway_instance = ${aliceInstance}`);

  // 3. Simulate a cross-pod delivery inbound from another pod to Alice via Redis Pub/Sub:
  const simulatedRemotePayload = {
    type: 'push',
    channel_id: 'dm:remote:alice',
    sender_id: 'simulated-remote-sender',
    ciphertext_base64: Buffer.from('cross-pod-secret').toString('base64'),
    server_id: 'srv-remote-123',
    server_time: Date.now(),
  };

  const podEnvelope = {
    target_user_id: alice.user_id,
    payload: Buffer.from(JSON.stringify(simulatedRemotePayload)).toString('base64'),
  };

  redisPublish(`gateway:pod:${aliceInstance}`, JSON.stringify(podEnvelope));
  console.log(`✓ Published cross-pod envelope to channel gateway:pod:${aliceInstance}`);

  // Wait for Alice to receive the delivered frame over WebSocket
  let received = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (aliceMsgs.some((m) => m.sender_id === 'simulated-remote-sender')) {
      received = true;
      break;
    }
  }
  assert.ok(received, 'Alice should receive cross-instance message forwarded by Redis subscriber');
  console.log('✓ Cross-pod message delivered to Alice WebSocket successfully.');

  // 4. Test outbound routing: Bob is registered as being on remote pod 'pod-charlie' in Redis
  redisSet(`user:${bob.user_id}:gateway_instance`, 'pod-charlie');
  redisSAdd(`user:${bob.user_id}:gateways`, 'pod-charlie');

  // Subscribe to 'pod-charlie' channel to verify gateway routes outbound send to Bob's owning pod
  let routedMessage = null;
  const unsubscribeCharlie = subscribeChannel('gateway:pod:pod-charlie', (raw) => {
    try {
      routedMessage = JSON.parse(raw);
    } catch {
      routedMessage = raw;
    }
  });

  // Small delay to allow subscription to establish
  await new Promise((r) => setTimeout(r, 600));

  // Alice sends a message to Bob
  aliceWs.send(
    JSON.stringify({
      action: 'send_message',
      channel_id: bob.user_id,
      client_msg_id: 'cmsg-to-bob-1',
      ciphertext_base64: Buffer.from('hello-bob').toString('base64'),
      message_type: 1,
    })
  );

  // Wait for message to be routed to pod-charlie
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (routedMessage) break;
  }

  assert.ok(routedMessage, 'Message to Bob should be routed to pod-charlie Redis channel');
  assert.strictEqual(routedMessage.target_user_id, bob.user_id);
  console.log('✓ Outbound cross-instance routing to owning pod (pod-charlie) verified.');

  unsubscribeCharlie();

  // 5. Clean disconnect: verify presence cleanup
  aliceWs.close();
  await new Promise((r) => setTimeout(r, 600));
  const postDisconnectInstance = redisGet(`user:${alice.user_id}:gateway_instance`);
  assert.strictEqual(postDisconnectInstance, null, 'gateway_instance should be cleaned up on disconnect');
  console.log('✓ Disconnect presence cleanup verified.');

  console.log('\n=== All Cross-Pod Routing Tests Passed! ===\n');
}

run().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
