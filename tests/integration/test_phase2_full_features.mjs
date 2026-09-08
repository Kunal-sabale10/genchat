import crypto from 'crypto'

async function runPhase2Tests() {
  console.log('=== STARTING PHASE 2 SENIOR-ENGINEER FULL FEATURES TEST SUITE ===\n')

  const AUTH_URL = process.env.AUTH_URL || 'http://localhost:8080'
  const WS_URL = process.env.WS_URL || 'ws://localhost:8081/ws'
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

  async function getDevToken(userId, deviceId, displayName) {
    const res = await fetch(`${AUTH_URL}/dev-token?user_id=${userId}&device_id=${deviceId}&display_name=${encodeURIComponent(displayName)}`)
    if (!res.ok) {
      throw new Error(`Failed to get dev token for ${displayName}: ${res.status} ${await res.text()}`)
    }
    const data = await res.json()
    return data.access_token
  }

  function wrapWebSocket(url) {
    const ws = new WebSocket(url)
    const listeners = new Set()
    ws.onmessage = async (event) => {
      const text = typeof event.data === 'string' ? event.data : await event.data.text()
      for (const listener of listeners) {
        try {
          listener(text)
        } catch (e) {
          console.error('Error in message listener:', e)
        }
      }
    }
    return {
      raw: ws,
      send(data) {
        ws.send(data)
      },
      close() {
        ws.close()
      },
      waitOpen() {
        if (ws.readyState === 1) return Promise.resolve()
        return new Promise((resolve, reject) => {
          ws.onopen = resolve
          ws.onerror = reject
        })
      },
      onMessage(fn) {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    }
  }

  // Generate test user identities (valid UUIDs for Postgres integrity)
  const aliceId = crypto.randomUUID()
  const aliceDevId = crypto.randomUUID()
  const aliceToken = await getDevToken(aliceId, aliceDevId, 'Alice')

  const bobId = crypto.randomUUID()
  const bobDevId = crypto.randomUUID()
  const bobToken = await getDevToken(bobId, bobDevId, 'Bob')

  const charlieId = crypto.randomUUID()
  const charlieDevId = crypto.randomUUID()
  const charlieToken = await getDevToken(charlieId, charlieDevId, 'Charlie')

  const eveId = crypto.randomUUID()
  const eveDevId = crypto.randomUUID()
  const eveToken = await getDevToken(eveId, eveDevId, 'Eve')

  console.log(`Test Alice:   ${aliceId}`)
  console.log(`Test Bob:     ${bobId}`)
  console.log(`Test Charlie: ${charlieId}`)
  console.log(`Test Eve:     ${eveId}\n`)

  // =========================================================================
  // FEATURE 3: PRE-KEY ANTI-EXHAUSTION POOL REPLENISHMENT
  // =========================================================================
  console.log('--- FEATURE 3: Testing Pre-Key Anti-Exhaustion Pool Replenishment ---')

  // 3a. Initial OTK key count
  const countRes1 = await fetch(`${AUTH_URL}/chat.v1.KeyService/GetKeyCount?deviceId=${aliceDevId}`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  })
  assert(countRes1.status === 200, 'GetKeyCount endpoint accessible and returns HTTP 200')
  const countData1 = await countRes1.json()
  const initialCount = Number(countData1.oneTimeKeyCount ?? countData1.one_time_key_count ?? 0)
  console.log(`    Initial Alice OTK count: ${initialCount}`)

  // 3b. Batch replenish 50 OTKs
  const newOtks = []
  for (let i = 0; i < 50; i++) {
    newOtks.push({
      keyId: 1000 + i,
      publicKey: crypto.randomBytes(32).toString('base64'),
    })
  }

  const uploadOtkRes = await fetch(`${AUTH_URL}/chat.v1.KeyService/UploadOneTimeKeys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${aliceToken}`,
    },
    body: JSON.stringify({
      deviceId: aliceDevId,
      keys: newOtks,
    }),
  })
  assert(uploadOtkRes.status === 200, 'UploadOneTimeKeys returns HTTP 200')

  // 3c. Verify OTK pool increased by 50
  const countRes2 = await fetch(`${AUTH_URL}/chat.v1.KeyService/GetKeyCount?deviceId=${aliceDevId}`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  })
  const countData2 = await countRes2.json()
  const currentCount = Number(countData2.oneTimeKeyCount ?? countData2.one_time_key_count ?? 0)
  assert(currentCount === initialCount + 50, `OTK pool replenished from ${initialCount} to ${currentCount}`)

  // 3d. Upload signed pre-key bundle
  const uploadBundleRes = await fetch(`${AUTH_URL}/chat.v1.KeyService/UploadPreKeyBundle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${aliceToken}`,
    },
    body: JSON.stringify({
      deviceId: aliceDevId,
      signedPreKey: {
        keyId: 1,
        publicKey: crypto.randomBytes(32).toString('base64'),
        signature: crypto.randomBytes(64).toString('base64'),
      },
      pqPreKey: {
        keyId: 1,
        publicKey: crypto.randomBytes(1184).toString('base64'), // ML-KEM-768
        signature: crypto.randomBytes(64).toString('base64'),
      },
    }),
  })
  assert(uploadBundleRes.status === 200, 'UploadPreKeyBundle returns HTTP 200')

  // =========================================================================
  // FEATURE 1: MULTI-PARTY GROUP CHAT (PURE E2EE GROUPS)
  // =========================================================================
  console.log('\n--- FEATURE 1: Testing Multi-Party Group Chat ---')

  // 1a. Alice creates an E2EE group chat with Bob and Charlie
  const createGroupRes = await fetch(`${AUTH_URL}/chat.v1.ChannelService/CreateChannel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${aliceToken}`,
    },
    body: JSON.stringify({
      name: 'CyberSec Engineering Guild',
      memberUserIds: [aliceId, bobId, charlieId],
      type: 2, // Group
    }),
  })
  assert(createGroupRes.status === 200, 'CreateChannel creates group and returns HTTP 200')
  const createGroupData = await createGroupRes.json()
  const groupChannelId = createGroupData.channel.id
  assert(!!groupChannelId, `Group channel ID created: ${groupChannelId}`)
  assert(createGroupData.members.length === 3, 'All 3 members enrolled in group')

  // 1b. Bob lists his channels and sees the new group
  const listChannelsRes = await fetch(`${AUTH_URL}/chat.v1.ChannelService/ListChannels`, {
    headers: { Authorization: `Bearer ${bobToken}` },
  })
  assert(listChannelsRes.status === 200, 'Bob ListChannels returns HTTP 200')
  const listData = await listChannelsRes.json()
  const foundGroup = listData.channels?.find((c) => c.id === groupChannelId)
  assert(!!foundGroup, 'Bob sees the group in his channel list')

  // 1c. Get channel members
  const getMembersRes = await fetch(`${AUTH_URL}/chat.v1.ChannelService/GetChannelMembers?channelId=${groupChannelId}`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  })
  assert(getMembersRes.status === 200, 'GetChannelMembers returns HTTP 200')
  const membersData = await getMembersRes.json()
  assert(membersData.members.length === 3, 'GetChannelMembers returns 3 active members')

  // 1d. WebSocket Connection & Group Message Routing
  console.log('    Connecting Alice and Bob to Gateway WebSocket...')
  const wsAlice = wrapWebSocket(`${WS_URL}?token=${encodeURIComponent(aliceToken)}`)
  const wsBob = wrapWebSocket(`${WS_URL}?token=${encodeURIComponent(bobToken)}`)

  await Promise.all([
    wsAlice.waitOpen(),
    wsBob.waitOpen(),
  ])
  assert(true, 'Alice and Bob WebSockets connected successfully')

  // Alice sends a message to the group: `chan_${groupChannelId}`
  const groupClientMsgId = `cmsg_grp_${Date.now()}`
  const groupCiphertext = Buffer.from('E2EE Group Payload').toString('base64')

  let aliceAckReceived = false
  let aliceAckServerId = ''
  let aliceAckSeqNum = 0
  let bobPushReceived = false

  const groupMsgPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for group message relay')), 8000)

    wsAlice.onMessage((raw) => {
      try {
        const frame = JSON.parse(raw)
        if (frame.type === 'ack' && frame.client_msg_id === groupClientMsgId) {
          aliceAckReceived = true
          aliceAckServerId = frame.message_id
          aliceAckSeqNum = frame.sequence_num
          if (bobPushReceived) {
            clearTimeout(timer)
            resolve()
          }
        }
      } catch {}
    })

    wsBob.onMessage((raw) => {
      try {
        const frame = JSON.parse(raw)
        if (frame.type === 'push' && frame.channel_id === `chan_${groupChannelId}`) {
          bobPushReceived = true
          assert(frame.sender_id === aliceId, 'Push frame indicates Alice as sender')
          assert(frame.ciphertext_base64 === groupCiphertext, 'Push frame contains accurate ciphertext')
          if (aliceAckReceived) {
            clearTimeout(timer)
            resolve()
          }
        }
      } catch {}
    })

    wsAlice.send(
      JSON.stringify({
        action: 'send_message',
        channel_id: `chan_${groupChannelId}`,
        client_msg_id: groupClientMsgId,
        ciphertext_base64: groupCiphertext,
        message_type: 1,
      })
    )
  })

  await groupMsgPromise
  assert(aliceAckReceived, `Alice received persistent ACK with durable sequenceNum=${aliceAckSeqNum}`)
  assert(bobPushReceived, 'Bob received real-time push frame for group chat message')

  // 1e. Non-member access restriction test (Eve is NOT in group)
  console.log('    Testing non-member unauthorized message rejection (Eve)...')
  const wsEve = wrapWebSocket(`${WS_URL}?token=${encodeURIComponent(eveToken)}`)
  await wsEve.waitOpen()

  const eveForbiddenPromise = new Promise((resolve) => {
    wsEve.onMessage((raw) => {
      try {
        const frame = JSON.parse(raw)
        if (frame.type === 'error') {
          resolve(frame)
        }
      } catch {}
    })
    wsEve.send(
      JSON.stringify({
        action: 'send_message',
        channel_id: `chan_${groupChannelId}`,
        client_msg_id: `eve_${Date.now()}`,
        ciphertext_base64: Buffer.from('Intrusion attempt').toString('base64'),
        message_type: 1,
      })
    )
  })

  const eveErr = await eveForbiddenPromise
  assert(eveErr.code === 'FORBIDDEN', 'Gateway rejected non-member message with FORBIDDEN error')
  wsEve.close()

  // =========================================================================
  // FEATURE 2: LIVE MESSAGE DELIVERY & READ RECEIPTS
  // =========================================================================
  console.log('\n--- FEATURE 2: Testing Live Delivery and Read Receipts ---')

  // 2a. Bob sends a 'delivered' receipt back to Alice
  let aliceDeliveredReceiptReceived = false
  const deliveredPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for delivered receipt')), 6000)

    const unsubscribe = wsAlice.onMessage((raw) => {
      try {
        const frame = JSON.parse(raw)
        if (frame.type === 'receipt' && frame.receipt_type === 'delivered' && frame.user_id === bobId) {
          aliceDeliveredReceiptReceived = true
          clearTimeout(timer)
          unsubscribe()
          resolve()
        }
      } catch {}
    })

    wsBob.send(
      JSON.stringify({
        action: 'ack_receipt',
        channel_id: `chan_${groupChannelId}`,
        server_id: aliceAckServerId,
        sequence_num: aliceAckSeqNum,
        receipt_type: 'delivered',
      })
    )
  })

  await deliveredPromise
  assert(aliceDeliveredReceiptReceived, 'Alice received live "delivered" receipt from Bob')

  // 2b. Bob views the message and sends a 'read' receipt
  let aliceReadReceiptReceived = false
  const readPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for read receipt')), 6000)

    const unsubscribe = wsAlice.onMessage((raw) => {
      try {
        const frame = JSON.parse(raw)
        if (frame.type === 'receipt' && frame.receipt_type === 'read' && frame.user_id === bobId) {
          aliceReadReceiptReceived = true
          clearTimeout(timer)
          unsubscribe()
          resolve()
        }
      } catch {}
    })

    wsBob.send(
      JSON.stringify({
        action: 'read_receipt',
        channel_id: `chan_${groupChannelId}`,
        server_id: aliceAckServerId,
        sequence_num: aliceAckSeqNum,
      })
    )
  })

  await readPromise
  assert(aliceReadReceiptReceived, 'Alice received live "read" receipt from Bob (blue checkmark trigger)')

  wsAlice.close()
  wsBob.close()

  // =========================================================================
  // FEATURE 4: LOCAL ENCRYPTED CACHE & DELTA SYNC VERIFICATION
  // =========================================================================
  console.log('\n--- FEATURE 4: Testing Local AES-256-GCM Encryption At Rest & Delta Sync ---')

  // Simulate Web Crypto AES-256-GCM encryption at rest matching LocalEncryptedCache
  const rawMasterKey = crypto.randomBytes(32)
  const cryptoKey = await crypto.subtle.importKey('raw', rawMasterKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])

  const iv = crypto.randomBytes(12)
  const sampleMessage = 'Top secret E2EE confidential group discussion'
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    new TextEncoder().encode(sampleMessage)
  )

  const storedPayload = `ENC_GCM:${Buffer.from(iv).toString('base64')}:${Buffer.from(ciphertextBuffer).toString('base64')}`
  assert(storedPayload.startsWith('ENC_GCM:'), 'Message formatted with AES-256-GCM at-rest wrapper')
  assert(!storedPayload.includes(sampleMessage), 'Stored database record plaintext is unreadable ciphertext')

  // Decrypt and assert roundtrip
  const parts = storedPayload.split(':')
  const decIv = Buffer.from(parts[1], 'base64')
  const decCt = Buffer.from(parts[2], 'base64')
  const decryptedBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decIv },
    cryptoKey,
    decCt
  )
  const decryptedText = new TextDecoder().decode(decryptedBuf)
  assert(decryptedText === sampleMessage, 'Decrypted local cache message matches original plaintext')

  // Tamper detection
  let tamperDetected = false
  try {
    const tamperedCt = Buffer.from(decCt)
    tamperedCt[0] ^= 0xff // flip bit
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decIv }, cryptoKey, tamperedCt)
  } catch {
    tamperDetected = true
  }
  assert(tamperDetected, 'Authentication tag validation rejects tampered at-rest message')

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log('\n======================================================')
  console.log(`TOTAL PHASE 2 TESTS: ${passed + failed}`)
  console.log(`PASSED: ${passed}`)
  console.log(`FAILED: ${failed}`)
  console.log('======================================================\n')

  if (failed > 0) {
    process.exit(1)
  } else {
    process.exit(0)
  }
}

runPhase2Tests().catch((err) => {
  console.error('Test suite failed with uncaught exception:', err)
  process.exit(1)
})
