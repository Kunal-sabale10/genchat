import crypto from 'crypto'

async function runSecurityTests() {
  console.log('=== STARTING GENCHAT SYSTEM SECURITY TESTS ===\n')

  const AUTH_URL = process.env.AUTH_URL || 'http://localhost:8080'
  const MEDIA_URL = process.env.MEDIA_URL || 'http://localhost:8082'
  const TURN_SECRET = process.env.TURN_SECRET || 'dev_turn_shared_secret_32b_change_in_prod'
  const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production'

  // Helper to generate a valid test JWT matching authd HS256 format
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

  // TEST 1: Ephemeral TURN Credential Generation & Verification
  console.log('1. Testing RFC 7635 Ephemeral TURN Credentials...')
  const testUserId = 'user-sec-test-' + Date.now()
  const testToken = createTestJWT(testUserId, 'dev-001')

  // 1a. Unauthorized request without token
  const unauthRes = await fetch(`${AUTH_URL}/chat.v1.AuthService/GetIceServers`)
  assert(unauthRes.status === 401, 'Unauthenticated request to GetIceServers returns HTTP 401')
  const unauthJson = await unauthRes.json().catch(() => ({}))
  assert(unauthJson.error === 'unauthorized', 'Unauthenticated request returns generic {"error": "unauthorized"}')

  // 1b. Authenticated request with valid JWT
  const authRes = await fetch(`${AUTH_URL}/chat.v1.AuthService/GetIceServers`, {
    headers: { Authorization: `Bearer ${testToken}` },
  })
  assert(authRes.status === 200, 'Authenticated request to GetIceServers returns HTTP 200')
  const iceConfig = await authRes.json()
  assert(Array.isArray(iceConfig.iceServers), 'Response contains iceServers array')

  const turnServer = iceConfig.iceServers.find((s) => s.username && s.credential)
  assert(!!turnServer, 'Response contains TURN server with ephemeral credentials')
  if (turnServer) {
    console.log(`    Observed TURN username: ${turnServer.username}`)
    console.log(`    Observed TURN credential: ${turnServer.credential}`)

    const parts = turnServer.username.split(':')
    const expiry = parseInt(parts[0], 10)
    assert(parts.length === 2 && parts[1] === testUserId, 'TURN username has <expiry>:<userId> structure')
    assert(expiry > Math.floor(Date.now() / 1000), 'Expiry timestamp is valid and in the future')

    // Verify HMAC-SHA1
    const expectedMac = crypto.createHmac('sha1', TURN_SECRET).update(turnServer.username).digest('base64')
    assert(turnServer.credential === expectedMac, 'Ephemeral password matches HMAC-SHA1(turnSharedSecret, username)')
  }

  // TEST 2: Strict CORS & Security Headers
  console.log('\n2. Testing Strict Origin CORS & Security Headers...')
  // 2a. Allowed origin preflight
  const allowedPreflight = await fetch(`${AUTH_URL}/chat.v1.AuthService/GetIceServers`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:3000',
      'Access-Control-Request-Method': 'GET',
    },
  })
  assert(allowedPreflight.status === 200, 'Preflight from allowed origin returns HTTP 200')
  assert(
    allowedPreflight.headers.get('access-control-allow-origin') === 'http://localhost:3000',
    'Preflight reflects allowed origin'
  )
  assert(allowedPreflight.headers.get('x-content-type-options') === 'nosniff', 'Has X-Content-Type-Options: nosniff')
  assert(allowedPreflight.headers.get('x-frame-options') === 'DENY', 'Has X-Frame-Options: DENY')
  assert(
    allowedPreflight.headers.get('referrer-policy') === 'strict-origin-when-cross-origin',
    'Has Referrer-Policy header'
  )

  // 2b. Disallowed origin preflight
  const badPreflight = await fetch(`${AUTH_URL}/chat.v1.AuthService/GetIceServers`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://malicious-site.com',
      'Access-Control-Request-Method': 'GET',
    },
  })
  assert(badPreflight.status === 403, 'Preflight from malicious origin is rejected with HTTP 403 Forbidden')

  // 2c. Mediad CORS & security headers
  const mediaPreflight = await fetch(`${MEDIA_URL}/media/upload`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'POST',
    },
  })
  assert(mediaPreflight.status === 200, 'Mediad preflight from allowed origin returns HTTP 200')
  assert(
    mediaPreflight.headers.get('access-control-allow-origin') === 'http://localhost:5173',
    'Mediad reflects allowed origin http://localhost:5173'
  )
  assert(
    mediaPreflight.headers.get('x-content-type-options') === 'nosniff',
    'Mediad has X-Content-Type-Options: nosniff'
  )

  // Disallowed origin on mediad
  const mediaBadPreflight = await fetch(`${MEDIA_URL}/media/upload`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://evil-site.org',
      'Access-Control-Request-Method': 'POST',
    },
  })
  assert(mediaBadPreflight.status === 403, 'Mediad preflight from evil origin is rejected with HTTP 403 Forbidden')

  // TEST 3: Error Message Sanitization
  console.log('\n3. Testing Error Message Sanitization (Zero Leakage)...')
  // 3a. Malformed JSON to authd
  const malformedAuth = await fetch(`${AUTH_URL}/chat.v1.AuthService/BeginRegistration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"invalid_json: 123',
  })
  assert(malformedAuth.status === 400, 'Malformed JSON returns HTTP 400')
  const authErrBody = await malformedAuth.json().catch(() => ({}))
  assert(authErrBody.error === 'invalid request payload', 'Auth error body is sanitized generic message')
  assert(!JSON.stringify(authErrBody).includes('syntax error'), 'No raw Go parser error in auth response')

  // 3b. Missing parameter on mediad
  const badMedia = await fetch(`${MEDIA_URL}/media/download`)
  assert(badMedia.status === 400, 'Missing parameter on mediad returns HTTP 400')
  const mediaErrBody = await badMedia.json().catch(() => ({}))
  assert(mediaErrBody.error === 'missing object_key parameter', 'Mediad error body is sanitized generic message')
  assert(!JSON.stringify(mediaErrBody).includes('postgres'), 'No database leak')
  assert(!JSON.stringify(mediaErrBody).includes('minio'), 'No internal storage leak')

  // TEST 4: Per-IP Rate Limiting
  console.log('\n4. Testing Per-IP Rate Limiting...')
  // Auth ceremony rate limit is burst 5, 15/min. Sending 10 rapid BeginRegistration calls should trigger 429
  let hit429 = false
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${AUTH_URL}/chat.v1.AuthService/BeginRegistration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: `RateLimitUser${i}` }),
    })
    if (res.status === 429) {
      hit429 = true
      const errJson = await res.json().catch(() => ({}))
      assert(
        errJson.error === 'rate limit exceeded, please slow down',
        'Rate limit error body contains generic message'
      )
      break
    }
  }
  // TEST 5: User Discovery Directory (ListUsers)
  console.log('\n5. Testing User Discovery Directory (/chat.v1.AuthService/ListUsers)...')
  const unauthListRes = await fetch(`${AUTH_URL}/chat.v1.AuthService/ListUsers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert(unauthListRes.status === 401, 'Unauthenticated ListUsers returns HTTP 401')
  const unauthListJson = await unauthListRes.json().catch(() => ({}))
  assert(
    unauthListJson.error === 'unauthorized',
    'Unauthenticated ListUsers returns generic {"error": "unauthorized"}'
  )

  const authListRes = await fetch(`${AUTH_URL}/chat.v1.AuthService/ListUsers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testToken}`,
    },
    body: JSON.stringify({}),
  })
  assert(authListRes.status === 200, 'Authenticated ListUsers returns HTTP 200 OK')
  const listData = await authListRes.json()
  assert(Array.isArray(listData.users), 'ListUsers response contains users array')
  assert(listData.users.length > 0, 'ListUsers returns at least 1 registered user')
  assert(
    listData.users.every((u) => u.userId && typeof u.isSelf === 'boolean'),
    'All returned users have valid userId and boolean isSelf flag'
  )

  console.log(`\n=== SUMMARY: ${passed} Passed, ${failed} Failed ===`)
  if (failed > 0) {
    process.exit(1)
  }
}

runSecurityTests().catch((e) => {
  console.error('Test execution failed:', e)
  process.exit(1)
})
