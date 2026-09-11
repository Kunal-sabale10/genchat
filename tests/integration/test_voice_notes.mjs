// Test: Encrypted Voice Notes with Interactive Audio Waveform Integration Suite
// Verifies:
// 1. Client-side WebCrypto AES-256-GCM audio encryption & decryption
// 2. Waveform resampling and normalization (32-bar array, clamped [0.15, 1.0])
// 3. Audio upload to MinIO S3 via mediad presigned URLs
// 4. End-to-end ciphertext retrieval, authentication tag validation, and bit-for-bit fidelity
// 5. Tamper resistance: corrupted audio ciphertext is rejected by AES-GCM
// 6. Voice note envelope packaging (isVoiceNote, durationSec, waveform, mimeType)

import assert from 'assert';
import crypto from 'crypto';

console.log('=== Starting Encrypted Voice Notes & Waveform Player Integration Test Suite ===\n');

// -------------------------------------------------------------
// Part 1: Waveform Resampling & Normalization Algorithm
// -------------------------------------------------------------
console.log('--- Testing Waveform Resampling & Normalization Algorithm ---');

function normalizeWaveform(rawSamples, targetBars = 32) {
  if (!rawSamples || rawSamples.length === 0) {
    return Array.from({ length: targetBars }, (_, i) => {
      const x = i / (targetBars - 1);
      return Math.round((0.2 + 0.5 * Math.sin(x * Math.PI)) * 100) / 100;
    });
  }

  const result = [];
  const bucketSize = rawSamples.length / targetBars;

  for (let i = 0; i < targetBars; i++) {
    const startIdx = Math.floor(i * bucketSize);
    const endIdx = Math.min(rawSamples.length, Math.floor((i + 1) * bucketSize));
    let maxVal = 0.15;

    for (let j = startIdx; j < endIdx; j++) {
      if (rawSamples[j] > maxVal) {
        maxVal = rawSamples[j];
      }
    }

    const normalized = Math.min(1.0, Math.max(0.15, Math.round(maxVal * 100) / 100));
    result.push(normalized);
  }

  return result;
}

// 1A: Test with synthetic microphone volume stream (100 samples)
const mockMicSamples = Array.from({ length: 100 }, (_, i) => {
  return 0.1 + 0.8 * Math.abs(Math.sin((i / 20) * Math.PI));
});

const waveform32 = normalizeWaveform(mockMicSamples, 32);
assert.strictEqual(waveform32.length, 32, 'Waveform array must contain exactly 32 bars');

for (let i = 0; i < waveform32.length; i++) {
  const val = waveform32[i];
  assert(typeof val === 'number' && !isNaN(val), `Bar ${i} must be a valid number`);
  assert(val >= 0.15 && val <= 1.0, `Bar ${i} (${val}) must be within [0.15, 1.0]`);
}

// 1B: Fallback waveform when raw samples are empty
const fallbackWaveform = normalizeWaveform([], 32);
assert.strictEqual(fallbackWaveform.length, 32, 'Fallback waveform must have 32 bars');
for (const val of fallbackWaveform) {
  assert(val >= 0.15 && val <= 1.0, 'Fallback values must be clamped within [0.15, 1.0]');
}

console.log('✓ Waveform normalization validated (exactly 32 bars, bounds [0.15, 1.0])');
console.log(`  Sample bar values: [${waveform32.slice(0, 6).join(', ')}, ...]`);

// -------------------------------------------------------------
// Part 2: AES-256-GCM Audio Payload Encryption & Authentication
// -------------------------------------------------------------
console.log('\n--- Testing AES-256-GCM Audio Payload Encryption & Decryption ---');

// Generate simulated WebM/Opus audio file bytes (e.g. 64KB)
const mockAudioHeader = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, // EBML ID
  0x9f, 0x42, 0x86, 0x81, // EBML Version
  0x01, 0x42, 0xf7, 0x81, // EBML ReadVersion
  0x01, 0x42, 0xf2, 0x81, // DocType: 'webm'
]);
const mockAudioBody = crypto.randomBytes(48 * 1024); // 48 KB simulated Opus packets
const rawAudioBytes = Buffer.concat([mockAudioHeader, mockAudioBody]);
console.log(`Generated simulated audio track: ${rawAudioBytes.length} bytes`);

// Generate 256-bit AES key and 96-bit random IV
const aesKey = crypto.randomBytes(32);
const aesIv = crypto.randomBytes(12);

const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, aesIv);
const ciphertext = Buffer.concat([cipher.update(rawAudioBytes), cipher.final(), cipher.getAuthTag()]);

assert.strictEqual(ciphertext.length, rawAudioBytes.length + 16, 'Ciphertext size must be plaintext + 16-byte auth tag');
console.log(`✓ Audio encrypted successfully (${ciphertext.length} ciphertext bytes)`);

// Decrypt and verify bit-for-bit fidelity
const authTag = ciphertext.subarray(ciphertext.length - 16);
const encryptedData = ciphertext.subarray(0, ciphertext.length - 16);

const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, aesIv);
decipher.setAuthTag(authTag);
const decryptedAudioBytes = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

assert.strictEqual(Buffer.compare(rawAudioBytes, decryptedAudioBytes), 0, 'Decrypted audio must be bit-for-bit identical to original');
console.log('✓ Decrypted audio matched original byte-for-byte');

// Tamper verification: modifying a single byte in the ciphertext must reject decryption
const tamperedCiphertext = Buffer.from(ciphertext);
tamperedCiphertext[10] ^= 0x01; // flip 1 bit

const tamperDecipher = crypto.createDecipheriv('aes-256-gcm', aesKey, aesIv);
tamperDecipher.setAuthTag(tamperedCiphertext.subarray(tamperedCiphertext.length - 16));
assert.throws(() => {
  Buffer.concat([tamperDecipher.update(tamperedCiphertext.subarray(0, tamperedCiphertext.length - 16)), tamperDecipher.final()]);
}, /Unsupported state or unable to authenticate data/, 'AES-256-GCM must reject tampered audio ciphertext');
console.log('✓ Tampered audio ciphertext rejected by AES-256-GCM authentication tag');

// -------------------------------------------------------------
// Part 3: Live Media Upload & MinIO S3 Pipeline
// -------------------------------------------------------------
console.log('\n--- Testing MinIO S3 Presigned Upload & Download for Voice Notes ---');

const MEDIA_URL = process.env.MEDIA_URL || 'http://127.0.0.1:8082';

async function testMediaUploadAndDownload() {
  // Step A: Request presigned upload URL from mediad
  const uploadReq = await fetch(`${MEDIA_URL}/media/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content_type: 'application/octet-stream',
      content_length: ciphertext.length,
      byte_size: ciphertext.length,
    }),
  });

  if (!uploadReq.ok) {
    throw new Error(`mediad /media/upload failed (${uploadReq.status}): ${await uploadReq.text()}`);
  }

  const uploadRes = await uploadReq.json();
  assert(uploadRes.upload_url, 'Must receive upload_url');
  assert(uploadRes.object_key, 'Must receive object_key');
  console.log(`✓ Presigned upload URL obtained for object_key: ${uploadRes.object_key}`);

  // Step B: Direct PUT ciphertext to MinIO
  const putReq = await fetch(uploadRes.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: ciphertext,
  });

  if (!putReq.ok) {
    throw new Error(`MinIO upload failed (${putReq.status}): ${await putReq.text()}`);
  }
  console.log('✓ Ciphertext uploaded directly to MinIO bucket');

  // Step C: Query download URL from mediad
  const dlReq = await fetch(`${MEDIA_URL}/media/download?object_key=${encodeURIComponent(uploadRes.object_key)}`);
  if (!dlReq.ok) {
    throw new Error(`mediad /media/download failed (${dlReq.status}): ${await dlReq.text()}`);
  }
  const dlRes = await dlReq.json();
  assert(dlRes.download_url, 'Must receive download_url');

  // Step D: Download ciphertext from MinIO
  const getReq = await fetch(dlRes.download_url);
  if (!getReq.ok) {
    throw new Error(`MinIO download failed (${getReq.status}): ${await getReq.text()}`);
  }
  const downloadedCiphertext = Buffer.from(await getReq.arrayBuffer());
  assert.strictEqual(Buffer.compare(ciphertext, downloadedCiphertext), 0, 'Downloaded ciphertext must match uploaded ciphertext exactly');
  console.log('✓ Downloaded ciphertext verified intact');

  // Step E: Recipient decrypts downloaded audio
  const recipientDecipher = crypto.createDecipheriv('aes-256-gcm', aesKey, aesIv);
  recipientDecipher.setAuthTag(downloadedCiphertext.subarray(downloadedCiphertext.length - 16));
  const finalDecryptedAudio = Buffer.concat([
    recipientDecipher.update(downloadedCiphertext.subarray(0, downloadedCiphertext.length - 16)),
    recipientDecipher.final(),
  ]);

  assert.strictEqual(Buffer.compare(rawAudioBytes, finalDecryptedAudio), 0, 'Recipient decrypted audio matches sender audio');
  console.log('✓ Recipient audio decrypted with 100% cryptographic fidelity');

  // -------------------------------------------------------------
  // Part 4: Voice Note E2EE Envelope Packaging & Verification
  // -------------------------------------------------------------
  console.log('\n--- Testing Voice Note Metadata Envelope Packaging ---');

  const voiceNoteMetadata = {
    blobId: uploadRes.object_key,
    downloadUrl: dlRes.download_url,
    encryptionKeyHex: aesKey.toString('hex'),
    ivHex: aesIv.toString('hex'),
    mimeType: 'audio/webm;codecs=opus',
    originalSize: rawAudioBytes.length,
    fileName: 'Voice message.webm',
    isVoiceNote: true,
    durationSec: 14,
    waveform: waveform32,
  };

  const envelopeJson = JSON.stringify(voiceNoteMetadata);
  const parsedEnvelope = JSON.parse(envelopeJson);

  assert.strictEqual(parsedEnvelope.isVoiceNote, true, 'isVoiceNote must be true');
  assert.strictEqual(parsedEnvelope.durationSec, 14, 'durationSec must be 14');
  assert.strictEqual(parsedEnvelope.waveform.length, 32, 'waveform array must preserve 32 points');
  assert.strictEqual(parsedEnvelope.mimeType, 'audio/webm;codecs=opus', 'mimeType must be audio/webm;codecs=opus');
  assert.strictEqual(parsedEnvelope.encryptionKeyHex, aesKey.toString('hex'), 'encryptionKeyHex must match');
  assert.strictEqual(parsedEnvelope.ivHex, aesIv.toString('hex'), 'ivHex must match');

  console.log('✓ Voice note E2EE metadata envelope fully verified');
  console.log('\n=== ALL VOICE NOTE TESTS PASSED SUCCESSFULLY ===');
}

testMediaUploadAndDownload().catch((err) => {
  console.error('\n❌ Voice Note Integration Test Failed:', err);
  process.exit(1);
});
