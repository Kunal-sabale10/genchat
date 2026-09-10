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
  const queryRes = await fetch(`${AUTH_URL}/chat.v1.PushService/GetPushTokens?userId=${userB}`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  })
  assert(queryRes.status === 200, 'GetPushTokens returns HTTP 200 OK')
  const queryJson = await queryRes.json()
  const tokens = queryJson.tokens || []
  assert(Array.isArray(tokens), 'GetPushTokens returns tokens array')
  assert(tokens.length >= 1, 'Contains at least 1 registered token for User B')
  const registeredToken = tokens.find((t) => (t.deviceId || t.device_id) === deviceB)
  assert(!!registeredToken, 'Contains exact registered device_id for User B')

  // Helper for opening WebSocket with retry and timeout
  async function openWebSocket(token, label) {
    const MAX_ATTEMPTS = 5
    let lastErr
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const ws = await new Promise((resolve, reject) => {
          let sock
          try {
            sock = new WebSocket(`${GATEWAY_URL}/ws?token=${encodeURIComponent(token)}`)
          } catch (initErr) {
            reject(initErr)
            return
          }
          const t = setTimeout(() => {
            try { sock.close() } catch (_) {}
            reject(new Error(`${label} WS open timed out (attempt ${attempt})`))
          }, 10000)
          sock.onopen = () => { clearTimeout(t); resolve(sock) }
          sock.onerror = (e) => {
            clearTimeout(t)
            const msg = e?.error?.message || e?.message || String(e)
            reject(new Error(`${label} WS onerror (attempt ${attempt}): ${msg}`))
          }
        })
        return ws
      } catch (err) {
        lastErr = err
        if (attempt < MAX_ATTEMPTS) {
          const delay = 1500 * Math.pow(2, attempt - 1)
          console.error(`  ${label} WS attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms...`)
          await new Promise((r) => setTimeout(r, delay))
        }
      }
    }
    throw lastErr
  }

  // 4. Offline Recipient Real-Time Delivery & Silent Push Triggering
  console.log('\n4. Testing Offline Recipient Handling via Gateway...')
  let wsA = null
  try {
    wsA = await openWebSocket(tokenA, 'Alice')
    assert(true, 'Alice connected to gateway WebSocket')

    await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error('Timed out waiting for Gateway ACK on offline message (15s)'))
        }
      }, 15000)

      wsA.onerror = (e) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          const msg = e?.error?.message || e?.message || String(e)
          reject(new Error(`WebSocket error while awaiting ACK: ${msg}`))
        }
      }

      wsA.onmessage = async (event) => {
        try {
          let text
          if (typeof event.data === 'string') {
            text = event.data
          } else if (typeof event.data?.text === 'function') {
            text = await event.data.text()
          } else if (event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data)) {
            text = Buffer.from(event.data).toString('utf8')
          } else {
            text = Buffer.from(event.data).toString('utf8')
          }

          const frame = JSON.parse(text)
          if (frame.type === 'ack') {
            if (!settled) {
              settled = true
              clearTimeout(timer)
              assert(true, 'Gateway acknowledged message persistence via ScyllaDB ACK')
              assert(typeof frame.sequence_num === 'number', 'ACK contains sequence_num')
              assert(!!frame.message_id, 'ACK contains durable message_id')
              resolve()
            }
          } else if (frame.type === 'error') {
            if (!settled) {
              settled = true
              clearTimeout(timer)
              reject(new Error(`Gateway returned error frame: ${frame.message || JSON.stringify(frame)}`))
            }
          }
        } catch (parseErr) {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(parseErr)
          }
        }
      }

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
    })
  } catch (offlineErr) {
    assert(false, `Offline recipient delivery test failed: ${offlineErr.message}`)
  } finally {
    if (wsA) {
      try { wsA.close() } catch (_) {}
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
    body: JSON.stringify({ deviceId: deviceB, device_id: deviceB }),
  })
  assert(unregRes.status === 200, 'UnregisterPushToken returns HTTP 200 OK')
  
  // Verify token is no longer present
  const verifyRes = await fetch(`${AUTH_URL}/chat.v1.PushService/GetPushTokens?userId=${userB}`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  })
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