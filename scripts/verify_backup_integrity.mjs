import assert from 'assert';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';

console.log('=== Automated Backup Integrity & Recovery Diagnostic ===\n');

async function provisionUser(name, userId, deviceId) {
  const res = await fetch(`${AUTH_HTTP_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      display_name: name,
      user_id: userId,
      device_id: deviceId,
    }),
  });
  if (!res.ok) throw new Error(`Failed to provision user: ${res.status}`);
  return await res.json();
}

async function run() {
  const testUserId = crypto.randomUUID();
  const testDeviceId = crypto.randomUUID();
  const user = await provisionUser('Backup Tester', testUserId, testDeviceId);

  console.log('[Step 1] Uploading zero-knowledge key backup...');
  // Dummy high-entropy ciphertext and salt simulating client-side Argon2id derivation
  const dummyCiphertext = Buffer.from('genchat-encrypted-ratchet-state-backup-v1').toString('base64');
  const dummySalt = Buffer.from(crypto.randomUUID()).toString('base64');
  const dummyParams = Buffer.from(JSON.stringify({ m: 65536, t: 3, p: 4 })).toString('base64');

  const uploadRes = await fetch(`${AUTH_HTTP_URL}/auth/backup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${user.access_token}`,
    },
    body: JSON.stringify({
      backup_ciphertext: dummyCiphertext,
      kdf_salt: dummySalt,
      kdf_algorithm: 'argon2id-aes256gcm',
      kdf_params: { m: 65536, t: 3, p: 4 },
      bundle_version: 1,
    }),
  });

  assert.strictEqual(uploadRes.status, 200, 'Backup upload should succeed with 200 OK');
  console.log('✓ Zero-knowledge backup successfully uploaded');

  console.log('[Step 2] Fetching and verifying backup integrity...');
  const fetchRes = await fetch(`${AUTH_HTTP_URL}/auth/backup`, {
    headers: {
      'Authorization': `Bearer ${user.access_token}`,
    },
  });

  assert.strictEqual(fetchRes.status, 200, 'Backup fetch should succeed with 200 OK');
  const fetched = await fetchRes.json();

  assert.strictEqual(fetched.kdf_algorithm, 'argon2id-aes256gcm', 'Algorithm must be argon2id-aes256gcm');
  assert.strictEqual(fetched.bundle_version, 1, 'Version must match uploaded version 1');
  assert.strictEqual(fetched.backup_ciphertext, dummyCiphertext, 'Ciphertext must be preserved bit-for-bit');
  assert.strictEqual(fetched.kdf_salt, dummySalt, 'Salt must match exactly');
  console.log('✓ Backup integrity verified: zero-knowledge payload retrieved bit-for-bit');

  console.log('[Step 3] Deleting backup to verify GDPR cleanup...');
  const deleteRes = await fetch(`${AUTH_HTTP_URL}/auth/backup`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${user.access_token}`,
    },
  });
  assert.strictEqual(deleteRes.status, 200, 'Backup deletion should succeed with 200 OK');
  console.log('✓ Backup cleanly removed');

  console.log('\n======================================================');
  console.log('BACKUP INTEGRITY VERIFICATION SUCCEEDED! ✓');
  console.log('======================================================');
}

run().catch((err) => {
  console.error('❌ Backup verification failed:', err);
  process.exit(1);
});
