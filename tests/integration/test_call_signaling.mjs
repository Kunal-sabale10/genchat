// Comprehensive Verification of WebRTC Call Signaling over GenChat Gateway
// Users are provisioned via /dev-token so they exist in Postgres, which avoids
// JWT<->DB inconsistency failures.

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

async function connectWS(token, label) {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`${GATEWAY_WS_URL}/ws?token=${encodeURIComponent(token)}`);
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error(`${label} WS open timeout on attempt ${attempt}`));
        }, 10000);
        ws.onopen = () => { clearTimeout(timeout); resolve(ws); };
        ws.onerror = (e) => {
          clearTimeout(timeout);
          const msg = e?.error?.message || e?.message || 'unknown';
          reject(new Error(`${label} WS connect error on attempt ${attempt}: ${msg}`));
        };
      }).then(ws => { return ws; });
      // Need to capture ws from the promise — restructure:
      break;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      const delay = 2000 * Math.pow(2, attempt - 1);
      console.error(`  ${label} attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Actually create properly — above is a draft. Use this cleaner version:
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
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function runCallSignalingTests() {
  console.log('=== Testing WebRTC Call Signaling ===\n');

  // Provision users with real Postgres-backed accounts
  console.log('Provisioning test users via /dev-token...');
  const aliceData = await provisionUser('Call Test Alice');
  const bobData = await provisionUser('Call Test Bob');

  const aliceId = aliceData.user_id;
  const bobId = bobData.user_id;
  const aliceToken = aliceData.access_token;
  const bobToken = bobData.access_token;

  console.log(`Alice: ${aliceId}`);
  console.log(`Bob:   ${bobId}\n`);

  let passed = 0;
  let failed = 0;
  function assert(cond, msg) {
    if (cond) { console.log(`  ✓ PASS: ${msg}`); passed++; }
    else { console.error(`  ✗ FAIL: ${msg}`); failed++; }
  }

  // Open WebSocket connections for both users with retry
  console.log('Connecting Alice and Bob to gateway...');
  const wsA = await openWebSocket(aliceToken, 'Alice');
  const wsB = await openWebSocket(bobToken, 'Bob');
  assert(true, 'Both Alice and Bob connected to gateway WebSocket');
  console.log('Both Alice and Bob connected to gateway.\n');

  let step1_bobReceivedOffer = false;
  let step2_aliceReceivedAnswer = false;
  let step3_bobReceivedCandidate = false;
  let step4_aliceReceivedHangup = false;
  let step5_aliceReceivedPeerOffline = false;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Call signaling test timed out! Status:
  step1_bobReceivedOffer=${step1_bobReceivedOffer}
  step2_aliceReceivedAnswer=${step2_aliceReceivedAnswer}
  step3_bobReceivedCandidate=${step3_bobReceivedCandidate}
  step4_aliceReceivedHangup=${step4_aliceReceivedHangup}
  step5_aliceReceivedPeerOffline=${step5_aliceReceivedPeerOffline}`));
    }, 20000);

    const done = () => { clearTimeout(timer); resolve(); };

    // Add error handlers so WS errors don't silently drop the test
    wsA.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`Alice WS error during test: ${e?.error?.message || e?.message || String(e)}`));
    };
    wsB.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`Bob WS error during test: ${e?.error?.message || e?.message || String(e)}`));
    };

    // Handler for Bob's incoming frames
    wsB.onmessage = async (event) => {
      const raw = typeof event.data === 'string' ? event.data : await event.data.text();
      let frame;
      try { frame = JSON.parse(raw); } catch { return; }

      if (frame.type === 'call_signal') {
        console.log('[Bob WS] Received call_signal:', frame.signal_type, 'from', frame.sender_id);

        if (frame.signal_type === 'offer') {
          if (frame.sender_id !== aliceId || frame.call_id !== 'call_test_001' || frame.call_type !== 'video') {
            clearTimeout(timer);
            reject(new Error(`Bob received invalid offer frame: ${JSON.stringify(frame)}`));
            return;
          }
          step1_bobReceivedOffer = true;
          console.log('  -> Bob validated offer from Alice successfully.');

          // Step 2: Bob sends 'answer' to Alice
          console.log('\n--- Step 2: Bob accepts call (answer) to Alice ---');
          wsB.send(JSON.stringify({
            action: 'call_signal',
            target_user_id: aliceId,
            signal_type: 'answer',
            call_id: 'call_test_001',
            call_type: 'video',
            sdp: 'v=0\r\no=bob_session 654321 IN IP4 127.0.0.1\r\ns=GenChat Answer\r\n',
          }));
        } else if (frame.signal_type === 'ice_candidate') {
          if (frame.sender_id !== aliceId || !frame.candidate || frame.candidate.candidate !== 'candidate:1 1 UDP 2122260223 127.0.0.1 5000 typ host') {
            clearTimeout(timer);
            reject(new Error(`Bob received invalid ice_candidate: ${JSON.stringify(frame)}`));
            return;
          }
          step3_bobReceivedCandidate = true;
          console.log('  -> Bob validated ICE candidate from Alice successfully.');

          // Step 4: Bob hangs up the call
          console.log('\n--- Step 4: Bob hangs up call ---');
          wsB.send(JSON.stringify({
            action: 'call_signal',
            target_user_id: aliceId,
            signal_type: 'hangup',
            call_id: 'call_test_001',
          }));
        }
      }
    };

    // Handler for Alice's incoming frames
    wsA.onmessage = async (event) => {
      const raw = typeof event.data === 'string' ? event.data : await event.data.text();
      let frame;
      try { frame = JSON.parse(raw); } catch { return; }

      if (frame.type === 'call_signal') {
        console.log('[Alice WS] Received call_signal:', frame.signal_type, 'from', frame.sender_id);

        if (frame.signal_type === 'answer') {
          if (frame.sender_id !== bobId || frame.call_id !== 'call_test_001') {
            clearTimeout(timer);
            reject(new Error(`Alice received invalid answer frame: ${JSON.stringify(frame)}`));
            return;
          }
          step2_aliceReceivedAnswer = true;
          console.log('  -> Alice validated answer from Bob successfully.');

          // Step 3: Alice sends ICE candidate to Bob
          console.log('\n--- Step 3: Alice sending ICE candidate to Bob ---');
          wsA.send(JSON.stringify({
            action: 'call_signal',
            target_user_id: bobId,
            signal_type: 'ice_candidate',
            call_id: 'call_test_001',
            candidate: {
              candidate: 'candidate:1 1 UDP 2122260223 127.0.0.1 5000 typ host',
              sdpMid: '0',
              sdpMLineIndex: 0,
            },
          }));
        } else if (frame.signal_type === 'hangup') {
          if (frame.sender_id !== bobId || frame.call_id !== 'call_test_001') {
            clearTimeout(timer);
            reject(new Error(`Alice received invalid hangup frame: ${JSON.stringify(frame)}`));
            return;
          }
          step4_aliceReceivedHangup = true;
          console.log('  -> Alice validated hangup from Bob successfully.');

          // Step 5: Test peer_offline notification when calling an offline user
          console.log('\n--- Step 5: Alice calls offline peer (testing peer_offline signal) ---');
          wsA.send(JSON.stringify({
            action: 'call_signal',
            target_user_id: 'user_completely_offline_9999',
            signal_type: 'offer',
            call_id: 'call_offline_test',
            call_type: 'audio',
            sdp: 'v=0\r\no=alice ...',
          }));
        } else if (frame.signal_type === 'peer_offline') {
          console.log('  -> Alice received peer_offline notice for callId:', frame.call_id);
          step5_aliceReceivedPeerOffline = true;
          done();
        }
      }
    };

    // Step 1: Alice sends 'offer' to Bob
    console.log('--- Step 1: Alice initiates call (offer) to Bob ---');
    wsA.send(JSON.stringify({
      action: 'call_signal',
      target_user_id: bobId,
      signal_type: 'offer',
      call_id: 'call_test_001',
      call_type: 'video',
      sdp: 'v=0\r\no=alice_session 123456 IN IP4 127.0.0.1\r\ns=GenChat Video Call\r\n',
    }));
  });

  try { wsA.close(); } catch {}
  try { wsB.close(); } catch {}

  assert(step1_bobReceivedOffer, 'Bob received call offer from Alice');
  assert(step2_aliceReceivedAnswer, 'Alice received call answer from Bob');
  assert(step3_bobReceivedCandidate, 'Bob received ICE candidate from Alice');
  assert(step4_aliceReceivedHangup, 'Alice received hangup from Bob');
  assert(step5_aliceReceivedPeerOffline, 'Alice received peer_offline for offline target');

  console.log(`\n=== SUMMARY: ${passed} Passed, ${failed} Failed ===`);
  if (failed > 0) process.exit(1);
}

runCallSignalingTests().catch((err) => {
  console.error('Fatal error in call signaling test:', err.message || err);
  process.exit(1);
});
