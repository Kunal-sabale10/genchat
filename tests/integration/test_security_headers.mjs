import assert from 'assert';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';

console.log('=== Test: HTTP Security Headers & CORS Isolation ===\n');

async function testSecurityHeaders() {
  console.log('[Test 1] Verifying OWASP security headers on API responses...');
  
  // Make a preflight request to verify security headers
  const res = await fetch(`${AUTH_HTTP_URL}/dev-token`, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'http://localhost:5134',
    },
  });
  
  assert.strictEqual(res.status, 200, 'Endpoint should return 200');

  // Check required security headers
  const headers = res.headers;
  
  assert.strictEqual(headers.get('x-content-type-options'), 'nosniff', 'Must include X-Content-Type-Options: nosniff');
  assert.strictEqual(headers.get('x-frame-options'), 'DENY', 'Must include X-Frame-Options: DENY');
  assert.strictEqual(headers.get('referrer-policy'), 'strict-origin-when-cross-origin', 'Must include Referrer-Policy');
  assert.ok(headers.get('strict-transport-security')?.includes('max-age'), 'Must include HSTS');
  assert.strictEqual(headers.get('x-xss-protection'), '0', 'Must include X-XSS-Protection: 0');
  assert.ok(headers.get('content-security-policy')?.includes("default-src 'self'"), 'Must include strict CSP');
  assert.ok(headers.get('permissions-policy')?.includes('camera=()'), 'Must include restrictive Permissions-Policy');
  
  console.log('✓ All 7 OWASP security headers validated');
}

async function testCorsIsolation() {
  console.log('\n[Test 2] Verifying CORS origin validation and isolation...');

  // 1. Allowed origin
  const allowedRes = await fetch(`${AUTH_HTTP_URL}/dev-token`, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'http://localhost:5134',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.strictEqual(allowedRes.status, 200, 'Allowed origin preflight should return 200');
  assert.strictEqual(allowedRes.headers.get('access-control-allow-origin'), 'http://localhost:5134', 'CORS allow header must match origin');

  // 2. Disallowed / Malicious origin
  const rogueRes = await fetch(`${AUTH_HTTP_URL}/dev-token`, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'http://malicious-phishing-site.example.com',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.strictEqual(rogueRes.status, 403, 'Rogue origin preflight should be rejected with 403 Forbidden');
  console.log('✓ CORS origin isolation verified: allowed origins permitted, malicious origins rejected');
}

async function run() {
  await testSecurityHeaders();
  await testCorsIsolation();
  console.log('\n======================================================');
  console.log('ALL SECURITY HEADERS & CORS TESTS PASSED! ✓');
  console.log('======================================================');
}

run().catch((err) => {
  console.error('\n❌ Security headers test failed:', err);
  process.exit(1);
});
