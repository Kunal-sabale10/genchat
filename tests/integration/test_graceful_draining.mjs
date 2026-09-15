import assert from 'assert';
import { execSync } from 'child_process';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

console.log('=== Test: Graceful Pod Draining & Reconnect Signaling ===\n');

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
    const frames = [];
    let closeEvent = null;

    ws.addEventListener('open', () => resolve({ ws, frames, getClose: () => closeEvent }));
    ws.addEventListener('error', (err) => reject(err));
    ws.addEventListener('close', (ev) => {
      closeEvent = ev;
    });
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
        frames.push(JSON.parse(text));
      } catch {
        frames.push(text);
      }
    });
  });
}

async function run() {
  const alice = await provisionUser('Alice Drain Tester');
  console.log(`✓ Provisioned Alice (${alice.user_id})`);

  // 1. Connect Alice to Gateway
  const { ws, frames, getClose } = await connectWs(alice.access_token);
  console.log('✓ Alice connected to Gateway WebSocket');

  // Ping test to confirm live
  ws.send(JSON.stringify({ action: 'ping' }));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(frames.some((f) => f.type === 'pong'), 'Gateway should respond to ping');
  console.log('✓ Gateway responsive (pong received)');

  // 2. Trigger graceful draining via SIGTERM
  console.log('Sending SIGTERM to gateway container to initiate draining...');
  try {
    execSync('docker kill -s SIGTERM deploy-gateway-1');
  } catch (err) {
    console.warn('docker kill output:', err.message);
  }

  // 3. Alice should receive the reconnect notification
  let receivedReconnect = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (frames.some((f) => f.type === 'reconnect' && f.reason === 'server_shutdown')) {
      receivedReconnect = true;
      break;
    }
  }

  assert.ok(receivedReconnect, 'Client must receive "reconnect" frame before connection terminates');
  console.log('✓ Client received graceful "reconnect" frame from draining gateway:');
  const recFrame = frames.find((f) => f.type === 'reconnect');
  console.log('   Frame:', JSON.stringify(recFrame));

  // 4. Wait for connection close
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (getClose() !== null) break;
  }
  const closeEv = getClose();
  assert.ok(closeEv, 'Connection should close gracefully after drain interval');
  console.log(`✓ Connection closed gracefully (code=${closeEv.code}, reason=${closeEv.reason})`);

  // 5. Restart gateway container
  console.log('Bringing gateway container back up...');
  execSync('docker compose -f deploy/docker-compose.yaml up -d gateway');
  await new Promise((r) => setTimeout(r, 2500));

  // 6. Verify client can reconnect cleanly
  const { ws: newWs, frames: newFrames } = await connectWs(alice.access_token);
  newWs.send(JSON.stringify({ action: 'ping' }));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(newFrames.some((f) => f.type === 'pong'), 'New gateway instance should respond');
  console.log('✓ Client reconnected successfully to new gateway instance');
  newWs.close();

  console.log('\n=== All Graceful Draining Tests Passed! ===\n');
}

run().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
