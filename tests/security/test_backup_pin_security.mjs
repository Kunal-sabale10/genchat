import assert from 'assert';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';

console.log('=== Test: Key Backup Recovery Brute-Force Rate Limiting & Lockout ===\n');

async function provisionUser(name) {
  const res = await fetch(`${AUTH_HTTP_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: name, user_id: crypto.randomUUID(), device_id: crypto.randomUUID() }),
  });
  if (!res.ok) throw new Error(`Failed to provision user: ${res.status}`);
  return await res.json();
}

async function run() {
  const alice = await provisionUser('Alice BackupOwner');
  console.log(`✓ Provisioned Alice (${alice.user_id})`);

  // Step 1: Upload a key backup
  const uploadRes = await fetch(`${AUTH_HTTP_URL}/auth/backup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${alice.access_token}`,
    },
    body: JSON.stringify({
      backup_ciphertext: Buffer.from('encrypted_identity_bundle').toString('base64'),
      kdf_salt: Buffer.from('random_kdf_salt_16b').toString('base64'),
      kdf_algorithm: 'PBKDF2-SHA256',
      kdf_params: { iterations: 600000, hash: 'SHA-256' },
      bundle_version: 1,
    }),
  });
  assert.strictEqual(uploadRes.status, 200);
  console.log('✓ Uploaded encrypted key backup to /auth/backup');

  // Step 2: Test recovery attempts (max 5 tokens in bucket)
  console.log('Testing recovery attempts against rate-limit token bucket (max 5 attempts)...');
  let hitRateLimit = false;
  let retryAfterSeconds = 0;

  for (let i = 1; i <= 8; i++) {
    const res = await fetch(`${AUTH_HTTP_URL}/auth/backup`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${alice.access_token}` },
    });

    if (res.status === 200) {
      console.log(`  Attempt #${i}: Allowed (HTTP 200)`);
    } else if (res.status === 429) {
      hitRateLimit = true;
      const retryHeader = res.headers.get('Retry-After');
      retryAfterSeconds = parseInt(retryHeader || '0', 10);
      console.log(`  Attempt #${i}: BLOCKED (HTTP 429 Too Many Requests, Retry-After: ${retryAfterSeconds}s)`);
      break;
    } else {
      throw new Error(`Unexpected status code: ${res.status}`);
    }
  }

  assert.ok(hitRateLimit, 'Server must enforce rate-limiting / lockout on repeated backup recovery requests');
  assert.ok(retryAfterSeconds > 0, 'Response must provide positive Retry-After lockout duration');
  console.log('✓ Rate limiting and brute-force mitigation verified for backup recovery');

  console.log('\n=== ALL BACKUP RECOVERY SECURITY TESTS PASSED ===\n');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
