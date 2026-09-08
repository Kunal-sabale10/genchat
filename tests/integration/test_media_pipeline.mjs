import crypto from 'node:crypto'

async function testMediaPipeline() {
  console.log('--- Starting Media Upload & MinIO S3 Pipeline Verification ---')

  const MEDIA_URL = process.env.MEDIA_URL || 'http://localhost:8082'

  // 1. Generate test plaintext (mimicking a photo or document)
  const originalPlaintext = 'GenChat Top-Secret Document: AES-256-GCM Zero-Knowledge Media Attachment Verification Payload ' + Date.now()
  const originalBytes = Buffer.from(originalPlaintext, 'utf-8')
  console.log(`1. Original plaintext generated (${originalBytes.length} bytes)`)

  // 2. Client-side encrypt with AES-256-GCM
  const key = crypto.randomBytes(32) // 256-bit key
  const iv = crypto.randomBytes(12)  // 96-bit IV
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encryptedBytes = Buffer.concat([cipher.update(originalBytes), cipher.final(), cipher.getAuthTag()])
  console.log(`2. Client encrypted with AES-256-GCM (${encryptedBytes.length} ciphertext bytes)`)

  // 3. Request presigned upload URL from mediad
  const uploadReq = await fetch(`${MEDIA_URL}/media/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content_type: 'application/octet-stream',
      content_length: encryptedBytes.length,
    }),
  })

  if (!uploadReq.ok) {
    throw new Error(`mediad /media/upload failed (${uploadReq.status}): ${await uploadReq.text()}`)
  }

  const uploadRes = await uploadReq.json()
  console.log('3. mediad generated presigned upload & download URLs successfully:')
  console.log('   object_key:', uploadRes.object_key)
  console.log('   upload_url:', uploadRes.upload_url.slice(0, 80) + '...')
  console.log('   download_url:', uploadRes.download_url.slice(0, 80) + '...')

  if (!uploadRes.upload_url || !uploadRes.download_url || !uploadRes.object_key) {
    throw new Error('Missing expected fields in mediad upload response')
  }

  // 4. PUT ciphertext blob to MinIO
  console.log('4. Uploading ciphertext blob directly to MinIO S3 via presigned PUT...')
  const putRes = await fetch(uploadRes.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: encryptedBytes,
  })

  if (!putRes.ok) {
    throw new Error(`MinIO PUT failed (${putRes.status}): ${await putRes.text()}`)
  }
  console.log('   -> MinIO PUT returned HTTP 200 OK')

  // 5. Test mediad /media/download endpoint
  console.log('5. Testing mediad /media/download query...')
  const dlReq = await fetch(`${MEDIA_URL}/media/download?object_key=${encodeURIComponent(uploadRes.object_key)}`)
  if (!dlReq.ok) {
    throw new Error(`mediad /media/download failed (${dlReq.status}): ${await dlReq.text()}`)
  }
  const dlRes = await dlReq.json()
  console.log('   -> mediad download URL confirmed:', dlRes.download_url.slice(0, 80) + '...')

  // 6. Fetch ciphertext from MinIO via presigned GET
  console.log('6. Downloading encrypted ciphertext from MinIO...')
  const getRes = await fetch(dlRes.download_url)
  if (!getRes.ok) {
    throw new Error(`MinIO GET failed (${getRes.status}): ${await getRes.text()}`)
  }
  const downloadedCiphertext = Buffer.from(await getRes.arrayBuffer())
  console.log(`   -> Downloaded ${downloadedCiphertext.length} bytes of ciphertext from MinIO`)

  // 7. Client-side decrypt with AES-256-GCM
  console.log('7. Decrypting ciphertext with client key and IV...')
  const tagLength = 16
  const authTag = downloadedCiphertext.subarray(downloadedCiphertext.length - tagLength)
  const cipherData = downloadedCiphertext.subarray(0, downloadedCiphertext.length - tagLength)

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  const decryptedBytes = Buffer.concat([decipher.update(cipherData), decipher.final()])
  const decryptedText = decryptedBytes.toString('utf-8')

  console.log(`   -> Decrypted text: "${decryptedText}"`)

  if (decryptedText !== originalPlaintext) {
    throw new Error('Integrity check failed: Decrypted text does not match original plaintext!')
  }

  // 8. S3 SigV4 Tamper Resistance Verification directly against MinIO
  console.log('8. Testing MinIO SigV4 tamper resistance...')

  // 8a. Tampered Signature on PUT
  const tamperedUploadUrl = new URL(uploadRes.upload_url)
  const origPutSig = tamperedUploadUrl.searchParams.get('X-Amz-Signature')
  const corruptedPutSig = (origPutSig[0] === 'a' ? 'b' : 'a') + origPutSig.slice(1)
  tamperedUploadUrl.searchParams.set('X-Amz-Signature', corruptedPutSig)

  const tamperedPutRes = await fetch(tamperedUploadUrl.toString(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: encryptedBytes,
  })
  if (tamperedPutRes.status !== 403) {
    throw new Error(`MinIO must reject tampered PUT signature with 403 Forbidden, got: ${tamperedPutRes.status}`)
  }
  console.log('   -> [8a] Tampered PUT signature rejected with HTTP 403 Forbidden ✓')

  // 8b. Tampered Expiry parameter on GET
  const tamperedGetUrl = new URL(dlRes.download_url)
  tamperedGetUrl.searchParams.set('X-Amz-Expires', '99999')
  const tamperedGetRes = await fetch(tamperedGetUrl.toString())
  if (tamperedGetRes.status !== 403) {
    throw new Error(`MinIO must reject tampered GET query parameter with 403 Forbidden, got: ${tamperedGetRes.status}`)
  }
  console.log('   -> [8b] Tampered GET query parameter rejected with HTTP 403 Forbidden ✓')

  console.log('\n✅ PASS: Zero-Knowledge Media Upload, MinIO S3 Pipeline, and SigV4 Tamper Resistance verified end-to-end!')
}

testMediaPipeline().catch((err) => {
  console.error('\n❌ FAIL: Test failed:', err)
  process.exit(1)
})
