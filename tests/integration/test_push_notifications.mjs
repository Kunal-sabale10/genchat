import crypto from 'crypto'

async function runPushTests() {
  console.log('=== STARTING GENCHAT PUSH NOTIFICATION INTEGRATION TESTS ===\n')

  const AUTH_URL = process.env.AUTH_URL || 'http://127.0.0.1:8080'
  const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:8081'

  let passed = 0
  let failed = 0

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASS: ${message}`)
      passed++
    } else {
      console.error(`  ✗ FAIL: ${message}`)
      failed++
    }
  }

  // Provision Alice and Bob via /dev-token (persists to Postgres hermetically)
  const resA = await fetch(`${AUTH_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Push Test Alice' }),
  })
  if (!resA.ok) throw new Error(`Failed to provision Alice via dev-token: ${resA.status}`)
  const dataA = await resA.json()
  const userA = dataA.user_id
  const deviceA = dataA.device_id
  const tokenA = dataA.access_token

  const resB = await fetch(`${AUTH_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Push Test Bob' }),
  })
  if (!resB.ok) throw new Error(`Failed to provision Bob via dev-token: ${resB.status}`)
  const dataB = await resB.json()
  const userB = dataB.user_id
  const deviceB = dataB.device_id
  const tokenB = dataB.access_token

  // 1. Unauthenticated request protection
  console.log('1. Testing Unauthenticated Push Service Access...')
  const unauthRes = await fetch(`${AUTH_URL}/chat.v1.PushService/RegisterPushToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: deviceB, platform: 3, token: 'fake-token' }),
  })
  assert(unauthRes.status === 401, 'Unauthenticated RegisterPushToken returns HTTP 401')
  const unauthJson = await unauthRes.json()
  assert(unauthJson.error === 'unauthorized', 'Unauthenticated request returns generic {"error": "unauthorized"}')

  // 2. Authenticated Push Registration
  console.log('\n2. Testing Authenticated Push Token Registration...')
  const regRes = await fetch(`${AUTH_URL}/chat.v1.PushService/RegisterPushToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenB}`,
    },
    body: JSON.stringify({
      deviceId: deviceB,
      platform: 3, // WebPush
      token: 'mock-webpush-token-bob-device',
      endpoint: 'https://fcm.googleapis.com/fcm/send/bob-endpoint',
      p256dh: Buffer.from('mock-p256dh-key').toString('base64'),
      auth: Buffer.from('mock-auth-secret').toString('base64'),
    }),
  })
  assert(regRes.status === 200, 'Authenticated RegisterPushToken returns HTTP 200 OK')
  const regJson = await regRes.json()
  assert(regJson.success === true, 'Response confirms registration success: true')

  // 3. Query Registered Tokens via GetPushTokens
  console.log('\n3. Testing Push Token Query (/chat.v1.PushService/GetPushTokens)...')
  const queryRes = await fetch(`${AUTH_URL}/chat.v1.PushService/GetPushTokens?userId=${userB}`)
  assert(queryRes.status === 200, 'GetPushTokens returns HTTP 200 OK')
  const queryJson = await queryRes.json()
  assert(Array.isArray(queryJson.tokens), 'GetPushTokens returns tokens array')
  assert(queryJson.tokens.length >= 1, 'Contains at least 1 registered token for User B')
  const registeredToken = queryJson.tokens.find((t) => t.deviceId === deviceB || t.device_id === deviceB)
  assert(!!registeredToken, 'Contains exact registered device_id for User B')

  // 4. Offline Recipient Real-Time Delivery & Silent Push Triggering
  console.log('\n4. Testing Offline Recipient Handling via Gateway...')
  let wsConnectAttempts = 0
  const MAX_WS_ATTEMPTS = 5
  const WS_TIMEOUT_MS = 15000

  const runWsTest = () => new Promise((resolve, reject) => {
    wsConnectAttempts++
    const wsA = new WebSocket(`${GATEWAY_URL}/ws?token=${encodeURIComponent(tokenA)}`)
    let settled = false
    const settle = (fn, arg) => {
      if (!settled) { settled = true; fn(arg) }
    }

    const timer = setTimeout(() => {
      wsA.close()
      settle(reject, new Error(`Timed out waiting for Gateway ACK after ${WS_TIMEOUT_MS}ms (attempt ${wsConnectAttempts})`))
    }, WS_TIMEOUT_MS)

    wsA.onopen = () => {
      // Alice sends a message to Bob (who is NOT connected to WebSocket)
      const clientMsgId = 'msg-' + Date.now()
      const payload = JSON.stringify({
        action: 'send_message',
        channel_id: userB,
        client_msg_id: clientMsgId,
        ciphertext_base64: Buffer.from('Hello offline Bob!').toString('base64'),
        message_type: 1,
      })
      wsA.send(payload)

      wsA.onmessage = async (event) => {
        try {
          const text = typeof event.data === 'string' ? event.data : await event.data.text()
          const frame = JSON.parse(text)
          if (frame.type === 'ack') {
            clearTimeout(timer)
            assert(true, 'Gateway acknowledged message persistence via ScyllaDB ACK')
            assert(typeof frame.sequence_num === 'number', 'ACK contains sequence_num')
            assert(!!frame.message_id, 'ACK contains durable message_id')
            wsA.close()
            settle(resolve, undefined)
          } else if (frame.type === 'error') {
            clearTimeout(timer)
            wsA.close()
            settle(reject, new Error(`Gateway returned error frame: ${frame.message || JSON.stringify(frame)}`))
          }
        } catch (parseErr) {
          clearTimeout(timer)
          wsA.close()
          settle(reject, parseErr)
        }
      }
    }

    wsA.onerror = (errEvent) => {
      clearTimeout(timer)
      const msg = errEvent?.error?.message || errEvent?.message || String(errEvent)
      console.error(`  WebSocket error on attempt ${wsConnectAttempts}: ${msg}`)
      wsA.close()
      settle(reject, new Error(`WebSocket connect error (attempt ${wsConnectAttempts}): ${msg}`))
    }
  })

  // Retry with exponential back-off so transient "service not yet ready" errors don't fail the build
  let wsSuccess = false
  for (let attempt = 0; attempt < MAX_WS_ATTEMPTS; attempt++) {
    try {
      await runWsTest()
      wsSuccess = true
      break
    } catch (wsErr) {
      if (attempt < MAX_WS_ATTEMPTS - 1) {
        const delay = 2000 * Math.pow(2, attempt) // 2s, 4s, 8s, 16s
        console.error(`  Attempt ${attempt + 1} failed: ${wsErr.message}. Retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
      } else {
        assert(false, `WebSocket offline delivery test FAILED after ${MAX_WS_ATTEMPTS} attempts: ${wsErr.message}`)
      }
    }
  }


  // 5. Unregister Push Token
  console.log('\n5. Testing Push Token Unregistration...')
  const unregRes = await fetch(`${AUTH_URL}/chat.v1.PushService/UnregisterPushToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenB}`,
    },
    body: JSON.stringify({ deviceId: deviceB }),
  })
  assert(unregRes.status === 200, 'UnregisterPushToken returns HTTP 200 OK')
  
  // Verify token is no longer present
  const verifyRes = await fetch(`${AUTH_URL}/chat.v1.PushService/GetPushTokens?userId=${userB}`)
  const verifyJson = await verifyRes.json()
  const remaining = (verifyJson.tokens || []).filter((t) => (t.deviceId || t.device_id) === deviceB)
  assert(remaining.length === 0, 'Device token successfully pruned from database')

  console.log(`\n=== SUMMARY: ${passed} Passed, ${failed} Failed ===`)
  if (failed > 0) {
    process.exit(1)
  }
}

runPushTests().catch((err) => {
  console.error('Fatal error running push tests:', err)
  process.exit(1)
})