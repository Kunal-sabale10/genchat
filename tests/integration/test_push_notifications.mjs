import crypto from 'crypto'
import { execSync } from 'child_process'

async function runPushTests() {
  console.log('=== STARTING GENCHAT PUSH NOTIFICATION INTEGRATION TESTS ===\n')

  const AUTH_URL = process.env.AUTH_URL || 'http://localhost:8080'
  const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://localhost:8081'
  const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production'

  function createTestJWT(sub, deviceId, expiresInSec = 900) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const exp = Math.floor(Date.now() / 1000) + expiresInSec
    const payload = Buffer.from(JSON.stringify({ sub, device_id: deviceId, exp })).toString('base64url')
    const sigBase = `${header}.${payload}`
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(sigBase).digest('base64url')
    return `${sigBase}.${sig}`
  }

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

  const userA = crypto.randomUUID()
  const userB = crypto.randomUUID()
  const deviceA = crypto.randomUUID()
  const deviceB = crypto.randomUUID()

  // Seed userB and deviceB in Postgres to satisfy foreign key constraints
  try {
    const pubKey = crypto.randomBytes(32).toString('hex')
    const devKey = crypto.randomBytes(32).toString('hex')
    execSync(`docker compose -f deploy/docker-compose.yaml exec -T postgres psql -U genchat -d genchat -c "INSERT INTO users (id, display_name, identity_key) VALUES ('${userB}', 'Push Test Bob', '\\\\x${pubKey}') ON CONFLICT DO NOTHING; INSERT INTO user_devices (id, user_id, device_label, identity_key) VALUES ('${deviceB}', '${userB}', 'Bob Device', '\\\\x${devKey}') ON CONFLICT DO NOTHING;"`, { stdio: 'pipe' })
  } catch (err) {
    console.warn('Could not seed user in postgres directly:', err.message)
  }

  const tokenA = createTestJWT(userA, deviceA)
  const tokenB = createTestJWT(userB, deviceB)

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
  await new Promise((resolve, reject) => {
    const wsA = new WebSocket(`${GATEWAY_URL}/ws?token=${tokenA}`)
    
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
    }

    wsA.onmessage = async (event) => {
      try {
        const text = typeof event.data === 'string' ? event.data : await event.data.text()
        const frame = JSON.parse(text)
        if (frame.type === 'ack') {
          assert(true, 'Gateway acknowledged message persistence via ScyllaDB ACK')
          assert(typeof frame.sequence_num === 'number', 'ACK contains sequence_num')
          assert(!!frame.message_id, 'ACK contains durable message_id')
          wsA.close()
          resolve()
        }
      } catch (err) {
        reject(err)
      }
    }

    wsA.onerror = (err) => {
      assert(false, `WebSocket connection error: ${err.message || 'unknown'}`)
      reject(err)
    }

    setTimeout(() => {
      reject(new Error('Timed out waiting for Gateway ACK on offline message'))
    }, 5000)
  })

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