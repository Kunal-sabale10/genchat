import assert from 'assert';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';

console.log('=== Test 4: Tiered Rate Limiting & Abuse Defense ===\n');

async function run() {
  // Provision a user for authenticated endpoint testing
  const res = await fetch(`${AUTH_HTTP_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: 'RateLimit Tester', user_id: crypto.randomUUID(), device_id: crypto.randomUUID() }),
  });
  assert.strictEqual(res.status, 200);
  const user = await res.json();
  console.log(`✓ Provisioned test user: ${user.user_id}`);

  // Test Tiered Limiter on /auth/device-link/initiate (limit is 5 burst)
  console.log('Testing device-link burst rate limiting (max 5 tokens)...');

  let hit429 = false;
  let retryAfterHeader = null;

  for (let i = 1; i <= 20; i++) {
    const linkRes = await fetch(`${AUTH_HTTP_URL}/auth/device-link/initiate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${user.access_token}`,
      },
      body: JSON.stringify({
        ephemeral_pubkey: Buffer.from('test_pubkey_' + i).toString('base64'),
        auth_code_hash: Buffer.from('test_hash_' + i).toString('base64'),
      }),
    });

    if (linkRes.status === 429) {
      hit429 = true;
      retryAfterHeader = linkRes.headers.get('Retry-After');
      const errBody = await linkRes.json();
      assert.strictEqual(errBody.error, 'rate_limit_exceeded');
      console.log(`✓ Request #${i} triggered HTTP 429 Too Many Requests (Retry-After: ${retryAfterHeader}s)`);
      break;
    } else {
      assert.strictEqual(linkRes.status, 200);
    }
  }

  assert.ok(hit429, 'Burst requests exceeding token bucket capacity must return HTTP 429');
  assert.ok(retryAfterHeader, 'HTTP 429 response must include Retry-After header');

  console.log('\n=== ALL TIERED RATE LIMITING TESTS PASSED ===\n');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
