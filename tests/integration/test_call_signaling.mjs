// Comprehensive Verification of WebRTC Call Signaling over GenChat Gateway
import { createHmac } from 'crypto';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:8081';

function makeJWT(sub, deviceId = 'test-call-device') {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub,
    device_id: deviceId,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const aliceId = 'alice_caller_' + Date.now();
const bobId = 'bob_callee_' + Date.now();
const aliceToken = makeJWT(aliceId);
const bobToken = makeJWT(bobId);

console.log('Testing WebRTC Call Signaling');
console.log('Alice:', aliceId);
console.log('Bob:', bobId);

const wsA = new WebSocket(`${GATEWAY_WS_URL}/ws?token=${encodeURIComponent(aliceToken)}`);
const wsB = new WebSocket(`${GATEWAY_WS_URL}/ws?token=${encodeURIComponent(bobToken)}`);

let step1_bobReceivedOffer = false;
let step2_aliceReceivedAnswer = false;
let step3_bobReceivedCandidate = false;
let step4_aliceReceivedHangup = false;
let step5_aliceReceivedPeerOffline = false;

function finish(success, msg) {
  clearTimeout(timer);
  try { wsA.close(); } catch {}
  try { wsB.close(); } catch {}
  console.log(success ? `\n✅ PASS: ${msg}` : `\n❌ FAIL: ${msg}`);
  process.exit(success ? 0 : 1);
}

const timer = setTimeout(() => {
  finish(false, `Timeout! Status:
  step1_bobReceivedOffer=${step1_bobReceivedOffer}
  step2_aliceReceivedAnswer=${step2_aliceReceivedAnswer}
  step3_bobReceivedCandidate=${step3_bobReceivedCandidate}
  step4_aliceReceivedHangup=${step4_aliceReceivedHangup}
  step5_aliceReceivedPeerOffline=${step5_aliceReceivedPeerOffline}`);
}, 15000);

let openCount = 0;
function onOpen() {
  openCount++;
  if (openCount === 2) {
    console.log('Both Alice and Bob connected to gateway.');
    startStep1();
  }
}

wsA.onopen = onOpen;
wsB.onopen = onOpen;

// Step 1: Alice sends 'offer' to Bob
function startStep1() {
  console.log('\n--- Step 1: Alice initiates call (offer) to Bob ---');
  wsA.send(JSON.stringify({
    action: 'call_signal',
    target_user_id: bobId,
    signal_type: 'offer',
    call_id: 'call_test_001',
    call_type: 'video',
    sdp: 'v=0\r\no=alice_session 123456 IN IP4 127.0.0.1\r\ns=GenChat Video Call\r\n',
  }));
}

// Handler for Bob's incoming frames
wsB.onmessage = async (event) => {
  const raw = typeof event.data === 'string' ? event.data : await event.data.text();
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch (err) {
    return;
  }

  if (frame.type === 'call_signal') {
    console.log('[Bob WS] Received call_signal:', frame.signal_type, 'from', frame.sender_id);

    if (frame.signal_type === 'offer') {
      if (frame.sender_id !== aliceId || frame.call_id !== 'call_test_001' || frame.call_type !== 'video') {
        finish(false, `Bob received invalid offer frame: ${JSON.stringify(frame)}`);
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
        finish(false, `Bob received invalid ice_candidate: ${JSON.stringify(frame)}`);
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
  try {
    frame = JSON.parse(raw);
  } catch (err) {
    return;
  }

  if (frame.type === 'call_signal') {
    console.log('[Alice WS] Received call_signal:', frame.signal_type, 'from', frame.sender_id);

    if (frame.signal_type === 'answer') {
      if (frame.sender_id !== bobId || frame.call_id !== 'call_test_001') {
        finish(false, `Alice received invalid answer frame: ${JSON.stringify(frame)}`);
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
        finish(false, `Alice received invalid hangup frame: ${JSON.stringify(frame)}`);
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
      finish(true, 'WebRTC Call Signaling verification completed successfully (offer, answer, ice_candidate, hangup, peer_offline)!');
    }
  }
};
