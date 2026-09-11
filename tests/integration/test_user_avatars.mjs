// Integration Test Suite: Option 4 - User Profile Pictures & Custom Avatars via MinIO S3
// Verifies:
// 1. Initial GetProfile returns authenticated user details with default avatarUrl
// 2. Direct-to-MinIO S3 image avatar upload via presigned upload URL
// 3. UpdateProfile persists custom avatar URL and display name in PostgreSQL
// 4. GetProfile returns updated profile details
// 5. ListUsers user discovery returns the updated avatar URL and display name to peer contacts
// 6. Preset avatar selection & persistence
// 7. Resetting / clearing avatar URL reverts to empty (allowing deterministic gradient initials)
// 8. Authentication security: unauthenticated or invalid tokens rejected with 401

import assert from 'assert';
import crypto from 'crypto';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';
const MEDIA_HTTP_URL = process.env.MEDIA_HTTP_URL || 'http://127.0.0.1:8082';

console.log('=== Starting User Profile Pictures & MinIO S3 Avatars Test Suite ===\n');

async function getDevToken(userId, displayName) {
  const deviceId = crypto.randomUUID();
  const res = await fetch(
    `${AUTH_HTTP_URL}/dev-token?user_id=${encodeURIComponent(userId)}&device_id=${encodeURIComponent(deviceId)}&display_name=${encodeURIComponent(displayName)}`
  );
  if (!res.ok) {
    throw new Error(`Failed to get dev token for ${displayName}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return { token: data.access_token, userId: data.user_id };
}

async function getProfile(token) {
  const res = await fetch(`${AUTH_HTTP_URL}/chat.v1.AuthService/GetProfile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });
  return { status: res.status, data: await res.json() };
}

async function updateProfile(token, payload) {
  const res = await fetch(`${AUTH_HTTP_URL}/chat.v1.AuthService/UpdateProfile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, data: await res.json() };
}

async function listUsers(token) {
  const res = await fetch(`${AUTH_HTTP_URL}/chat.v1.AuthService/ListUsers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });
  return { status: res.status, data: await res.json() };
}

async function run() {
  const aliceId = crypto.randomUUID();
  const bobId = crypto.randomUUID();

  console.log(`[Step 1] Authenticating test users (Alice: ${aliceId}, Bob: ${bobId})...`);
  const aliceAuth = await getDevToken(aliceId, 'Alice Cooper');
  const bobAuth = await getDevToken(bobId, 'Bob Builder');
  const aliceToken = aliceAuth.token;
  const bobToken = bobAuth.token;
  assert(aliceToken, 'Alice token must be present');
  assert(bobToken, 'Bob token must be present');
  console.log('✓ Test users authenticated successfully.\n');

  // --- Step 2: GetProfile for Alice ---
  console.log('[Step 2] Testing GetProfile for newly created user...');
  const aliceInitialProfile = await getProfile(aliceToken);
  assert.strictEqual(aliceInitialProfile.status, 200, 'GetProfile must return 200 OK');
  assert.strictEqual(aliceInitialProfile.data.userId, aliceId);
  assert.strictEqual(aliceInitialProfile.data.displayName, 'Alice Cooper');
  assert.strictEqual(aliceInitialProfile.data.avatarUrl, '', 'Default avatarUrl must be empty');
  console.log('✓ Initial profile verified: default avatar is empty string.\n');

  // --- Step 3: Direct-to-MinIO S3 Image Upload ---
  console.log('[Step 3] Uploading 1x1 test PNG avatar image to MinIO S3 via /media/upload...');
  // 1x1 transparent PNG buffer
  const samplePngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  const sha256Hex = crypto.createHash('sha256').update(samplePngBuffer).digest('hex');

  const presignRes = await fetch(`${MEDIA_HTTP_URL}/media/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content_type: 'image/png',
      content_length: samplePngBuffer.length,
      byte_size: samplePngBuffer.length,
      sha256_hash: sha256Hex,
    }),
  });

  assert.strictEqual(presignRes.status, 200, 'Media presign must succeed');
  const presignData = await presignRes.json();
  assert(presignData.upload_url, 'Presigned upload URL must be present');
  assert(presignData.download_url, 'Download URL must be present');
  console.log(`Presigned upload URL: ${presignData.upload_url.slice(0, 50)}...`);

  // PUT raw PNG image bytes directly to MinIO presigned URL
  const uploadRes = await fetch(presignData.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: samplePngBuffer,
  });
  assert(
    uploadRes.ok,
    `MinIO PUT upload failed with status ${uploadRes.status}: ${await uploadRes.text()}`
  );
  console.log('✓ Image successfully uploaded to MinIO S3 bucket.');

  const uploadedAvatarUrl = presignData.download_url;
  console.log(`Uploaded avatar accessible download URL: ${uploadedAvatarUrl}\n`);

  // --- Step 4: UpdateProfile for Alice ---
  console.log('[Step 4] Updating Alice profile with new display name and MinIO S3 avatar URL...');
  const updateRes = await updateProfile(aliceToken, {
    displayName: 'Alice C. (Updated)',
    avatarUrl: uploadedAvatarUrl,
  });

  assert.strictEqual(updateRes.status, 200, 'UpdateProfile must return 200 OK');
  assert.strictEqual(updateRes.data.userId, aliceId);
  assert.strictEqual(updateRes.data.displayName, 'Alice C. (Updated)');
  assert.strictEqual(updateRes.data.avatarUrl, uploadedAvatarUrl);
  console.log('✓ UpdateProfile returned updated profile data.\n');

  // --- Step 5: Verify GetProfile reflects updates from PostgreSQL ---
  console.log('[Step 5] Verifying GetProfile persistence...');
  const aliceUpdatedProfile = await getProfile(aliceToken);
  assert.strictEqual(aliceUpdatedProfile.status, 200);
  assert.strictEqual(aliceUpdatedProfile.data.displayName, 'Alice C. (Updated)');
  assert.strictEqual(aliceUpdatedProfile.data.avatarUrl, uploadedAvatarUrl);
  console.log('✓ GetProfile confirms persistent changes in PostgreSQL.\n');

  // --- Step 6: User Directory Discovery (Bob sees Alice's Avatar) ---
  console.log('[Step 6] Testing ListUsers directory discovery (Bob queries contacts)...');
  const bobDirectory = await listUsers(bobToken);
  assert.strictEqual(bobDirectory.status, 200);
  assert(Array.isArray(bobDirectory.data.users), 'users array must be returned');

  const aliceInBobDir = bobDirectory.data.users.find((u) => u.userId === aliceId);
  assert(aliceInBobDir, 'Alice must be discoverable in user directory');
  assert.strictEqual(aliceInBobDir.displayName, 'Alice C. (Updated)');
  assert.strictEqual(
    aliceInBobDir.avatarUrl,
    uploadedAvatarUrl,
    'Bob must see Alice’s custom avatar URL'
  );
  console.log('✓ Contact discovery verified: Bob sees Alice’s avatar URL and display name.\n');

  // --- Step 7: Preset Avatar Selection & Persistence ---
  console.log('[Step 7] Testing preset avatar selection for Bob...');
  const presetAvatarUrl = 'https://api.dicebear.com/7.x/bottts/svg?seed=Cosmo';
  const bobUpdateRes = await updateProfile(bobToken, {
    displayName: 'Bob The Bot',
    avatarUrl: presetAvatarUrl,
  });
  assert.strictEqual(bobUpdateRes.status, 200);
  assert.strictEqual(bobUpdateRes.data.displayName, 'Bob The Bot');
  assert.strictEqual(bobUpdateRes.data.avatarUrl, presetAvatarUrl);

  const bobUpdatedProfile = await getProfile(bobToken);
  assert.strictEqual(bobUpdatedProfile.data.avatarUrl, presetAvatarUrl);
  console.log('✓ Preset avatar selection and persistence verified.\n');

  // --- Step 8: Reset / Clear Avatar URL ---
  console.log('[Step 8] Testing avatar reset / removal for Alice (reverting to colorful initials)...');
  const aliceResetRes = await updateProfile(aliceToken, {
    avatarUrl: '',
  });
  assert.strictEqual(aliceResetRes.status, 200);
  assert.strictEqual(aliceResetRes.data.avatarUrl, '', 'avatarUrl must be cleared to empty string');

  const aliceClearedProfile = await getProfile(aliceToken);
  assert.strictEqual(aliceClearedProfile.data.avatarUrl, '');
  console.log('✓ Avatar reset verified: profile now has empty avatarUrl.\n');

  // --- Step 9: Authentication & Security Hardening ---
  console.log('[Step 9] Verifying authentication rejection with invalid / missing token...');
  const noAuthProfile = await fetch(`${AUTH_HTTP_URL}/chat.v1.AuthService/GetProfile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.strictEqual(noAuthProfile.status, 401, 'Request without token must be rejected with 401');

  const invalidTokenUpdate = await fetch(`${AUTH_HTTP_URL}/chat.v1.AuthService/UpdateProfile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer invalid.token.payload',
    },
    body: JSON.stringify({ displayName: 'Hacker' }),
  });
  assert.strictEqual(invalidTokenUpdate.status, 401, 'Request with invalid token must be rejected with 401');
  console.log('✓ Security verified: unauthenticated requests cleanly rejected with 401.\n');

  console.log('===============================================================');
  console.log('🎉 ALL USER PROFILE PICTURES & CUSTOM AVATARS TESTS PASSED! 🎉');
  console.log('===============================================================');
}

run().catch((err) => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
