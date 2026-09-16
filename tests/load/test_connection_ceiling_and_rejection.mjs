import assert from 'assert';
import http from 'http';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_HTTP_URL = process.env.GATEWAY_HTTP_URL || 'http://127.0.0.1:8081';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

console.log('=== Test: Gateway Connection Ceiling, Device Cap, & Active Sessions ===\n');

async function provisionUserWithDevice(name, userId, deviceId) {
  const res = await fetch(`${AUTH_HTTP_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      display_name: name,
      user_id: userId,
      device_id: deviceId,
    }),
  });
  if (!res.ok) throw new Error(`Failed to provision user: ${res.status}`);
  return await res.json();
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${GATEWAY_WS_URL}/ws?token=${encodeURIComponent(token)}`);
    const messages = [];

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, 5000);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({ ws, messages });
    });
    ws.addEventListener('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.addEventListener('message', async (event) => {
      let data = event.data;
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        data = await data.text();
      } else if (data instanceof ArrayBuffer) {
        data = new TextDecoder().decode(data);
      } else if (Buffer.isBuffer(data)) {
        data = data.toString('utf8');
      }
      messages.push(typeof data === 'string' ? data : String(data));
    });
  });
}

function attemptWsUpgrade(token, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${GATEWAY_HTTP_URL}/ws?token=${encodeURIComponent(token)}`);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        ...customHeaders,
      },
    });

    req.on('response', (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: body.trim(),
        });
      });
    });

    req.on('upgrade', (res, socket, head) => {
      socket.destroy();
      resolve({
        status: 101,
        headers: res.headers,
        body: '',
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

async function run() {
  // Test 1: Active Sessions & Remote Revocation via Auth Service
  console.log('[Test 1] Active Sessions Listing & Remote Revocation...');
  const testUserId = crypto.randomUUID();
  const dev1 = crypto.randomUUID();
  const dev2 = crypto.randomUUID();

  const userDev1 = await provisionUserWithDevice('Resilience Tester', testUserId, dev1);
  const userDev2 = await provisionUserWithDevice('Resilience Tester', testUserId, dev2);

  // Query GET /api/v1/sessions
  const sessionsResp = await fetch(`${AUTH_HTTP_URL}/api/v1/sessions`, {
    headers: { Authorization: `Bearer ${userDev1.access_token}` },
  });
  assert.strictEqual(sessionsResp.status, 200, 'GET /api/v1/sessions should return 200');
  const sessionsData = await sessionsResp.json();
  assert.ok(Array.isArray(sessionsData.sessions), 'Response should contain sessions array');
  assert.ok(sessionsData.sessions.length >= 2, 'Should list both sessions');

  const currentSess = sessionsData.sessions.find((s) => s.device_id === dev1);
  const otherSess = sessionsData.sessions.find((s) => s.device_id === dev2);
  assert.ok(currentSess, 'Current session for dev1 must exist');
  assert.ok(otherSess, 'Second session for dev2 must exist');
  assert.strictEqual(currentSess.is_current, true, 'dev1 session must have is_current=true when requested with dev1 token');

  // Revoke session for dev2
  const revokeResp = await fetch(`${AUTH_HTTP_URL}/api/v1/sessions/${otherSess.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${userDev1.access_token}` },
  });
  assert.strictEqual(revokeResp.status, 200, 'DELETE /api/v1/sessions/:id should return 200');
  const revokeData = await revokeResp.json();
  assert.strictEqual(revokeData.status, 'revoked', 'Response status should be revoked');
  assert.strictEqual(revokeData.session_id, otherSess.id, 'Response session_id should match');

  // Verify list no longer includes revoked session
  const afterRevokeResp = await fetch(`${AUTH_HTTP_URL}/api/v1/sessions`, {
    headers: { Authorization: `Bearer ${userDev1.access_token}` },
  });
  const afterRevokeData = await afterRevokeResp.json();
  const foundRevoked = afterRevokeData.sessions.find((s) => s.id === otherSess.id);
  assert.ok(!foundRevoked, 'Revoked session should not be returned in active sessions');
  console.log('✓ Active sessions and remote revocation verified');

  // Test 2: Pod Connection Capacity Ceiling Rejection (Directive 1 & Directive 8)
  console.log('\n[Test 2] Pod Connection Capacity Ceiling Rejection (503 + Retry-After)...');
  const ceilingUser = await provisionUserWithDevice('Ceiling Tester', crypto.randomUUID(), crypto.randomUUID());
  const ceilingResp = await attemptWsUpgrade(ceilingUser.access_token, {
    'X-Test-Simulate-Ceiling': 'true',
  });
  assert.strictEqual(ceilingResp.status, 503, 'Connection over ceiling must return HTTP 503 Service Unavailable');
  assert.strictEqual(ceilingResp.headers['retry-after'], '30', '503 response must include Retry-After: 30 header');
  assert.strictEqual(ceilingResp.body, 'server connection capacity reached', '503 response body must state connection capacity reached');
  console.log('✓ HTTP 503 + Retry-After: 30 capacity ceiling rejection verified');

  // Test 3: Per-User Device Limit Hard Rejection (DEVICE_CAP_POLICY=reject_new)
  console.log('\n[Test 3] Enforce Per-User 5-Device Ceiling (Hard Reject Policy)...');
  const capUserId = crypto.randomUUID();
  const sockets = [];
  const deviceMessages = [];
  const deviceIds = [];

  for (let i = 1; i <= 5; i++) {
    const devId = crypto.randomUUID();
    deviceIds.push(devId);
    const user = await provisionUserWithDevice(`Device User ${i}`, capUserId, devId);
    const { ws, messages } = await connectWs(user.access_token);
    sockets.push(ws);
    deviceMessages.push(messages);
    console.log(`  ✓ Device ${i} (${devId.slice(0, 8)}) connected`);
  }

  // Attempt 6th device connection with policy=reject_new
  const dev6Id = crypto.randomUUID();
  const user6 = await provisionUserWithDevice('Device User 6', capUserId, dev6Id);
  const rejectResp = await attemptWsUpgrade(user6.access_token, {
    'X-Test-Device-Cap-Policy': 'reject_new',
  });
  assert.strictEqual(rejectResp.status, 403, '6th concurrent device should be rejected with HTTP 403 when policy=reject_new');
  assert.ok(
    rejectResp.body.includes('device limit exceeded (maximum 5 active devices per account)'),
    `Rejection body should contain expected message, got: "${rejectResp.body}"`
  );
  console.log('✓ 6th concurrent device rejected with HTTP 403 Forbidden & clear policy message');

  // Test 4: Device Cap UX - Auto-Evict Oldest Device (DEVICE_CAP_POLICY=evict_oldest)
  console.log('\n[Test 4] Per-User Device Cap Auto-Eviction UX (evict_oldest Policy)...');
  let dev1Evicted = false;
  sockets[0].addEventListener('close', () => {
    dev1Evicted = true;
  });

  // Attempt 6th device connection with default policy=evict_oldest
  const evictUpgradeResp = await attemptWsUpgrade(user6.access_token, {
    'X-Test-Device-Cap-Policy': 'evict_oldest',
  });
  assert.strictEqual(evictUpgradeResp.status, 101, '6th device should be upgraded to WebSocket under evict_oldest policy');

  // Connect 6th device fully via WebSocket
  const { ws: ws6 } = await connectWs(user6.access_token);
  sockets.push(ws6);
  console.log('  ✓ 6th device connected successfully');

  // Wait for Device 1 (oldest) to receive the session_evicted frame and close
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(dev1Evicted, true, 'Oldest device socket should be closed by server');
  const d1Msgs = deviceMessages[0].map((m) => {
    try {
      return JSON.parse(m);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const evictedNotice = d1Msgs.find((m) => m.type === 'session_evicted');
  assert.ok(evictedNotice, 'Device 1 should have received a session_evicted frame');
  assert.strictEqual(evictedNotice.reason, 'device_limit_superseded', 'Reason should be device_limit_superseded');
  console.log('✓ Oldest device evicted with session_evicted notice & socket cleanly closed');

  // Test 5: Same-Device Reconnect Supersession
  console.log('\n[Test 5] Same-Device Reconnect Supersession...');
  let dev2Closed = false;
  sockets[1].addEventListener('close', () => {
    dev2Closed = true;
  });

  // Reconnect with same user and device 2
  const user2Reconnect = await provisionUserWithDevice('Device User 2 Reconnected', capUserId, deviceIds[1]);
  const { ws: newWs2 } = await connectWs(user2Reconnect.access_token);
  sockets.push(newWs2);
  console.log('  ✓ Reconnected socket for device 2 accepted');

  // Wait a small slice for previous socket close
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(dev2Closed, true, 'Older connection on same device ID must be superseded and closed');
  console.log('✓ Older connection superseded and evicted cleanly');

  // Cleanup open sockets
  for (const s of sockets) {
    try {
      if (typeof s.terminate === 'function') s.terminate();
      else s.close();
    } catch {}
  }

  // Test 6: Prometheus Resilience Metrics Exposure
  console.log('\n[Test 6] Verifying Prometheus Gateway Resilience Metrics...');
  const metricsResp = await fetch(`${GATEWAY_HTTP_URL}/metrics`);
  assert.strictEqual(metricsResp.status, 200, 'Metrics endpoint should return 200');
  const metricsText = await metricsResp.text();

  assert.ok(metricsText.includes('gateway_device_limit_rejections_total'), 'Metric gateway_device_limit_rejections_total should exist');
  assert.ok(metricsText.includes('gateway_connection_capacity_rejections_total'), 'Metric gateway_connection_capacity_rejections_total should exist');
  assert.ok(metricsText.includes('gateway_preauth_rate_limit_rejections_total'), 'Metric gateway_preauth_rate_limit_rejections_total should exist');
  assert.ok(metricsText.includes('gateway_loadshed_rejections_total'), 'Metric gateway_loadshed_rejections_total should exist');
  console.log('✓ All 4 resilience Prometheus metrics exposed');

  console.log('\n======================================================');
  console.log('ALL CONNECTION CEILING & RESILIENCE TESTS PASSED! ✓');
  console.log('======================================================');
  process.exit(0);
}

run().catch((err) => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
