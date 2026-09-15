import assert from 'assert';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';

console.log('=== Test: Feature Flagging & Staged Rollout ===\n');

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
  const alice = await provisionUser('Alice Canary');
  console.log(`✓ Provisioned Alice (${alice.user_id})`);

  // 1. Unauthenticated feature flag fetch
  const unauthRes = await fetch(`${AUTH_HTTP_URL}/features`);
  assert.strictEqual(unauthRes.status, 200, 'Unauthenticated fetch should succeed');
  const unauthData = await unauthRes.json();
  assert.ok(unauthData.features, 'Should return features map');
  assert.strictEqual(typeof unauthData.features.device_linking, 'boolean');
  assert.strictEqual(typeof unauthData.features.group_calling, 'boolean');
  assert.strictEqual(typeof unauthData.features.ai_summary, 'boolean');
  assert.strictEqual(typeof unauthData.features.protobuf_wire, 'boolean');
  console.log('✓ Unauthenticated feature flag defaults received:', unauthData.features);

  // 2. Authenticated feature flag fetch with user cohort evaluation
  const authRes = await fetch(`${AUTH_HTTP_URL}/features`, {
    headers: {
      Authorization: `Bearer ${alice.access_token}`,
    },
  });
  assert.strictEqual(authRes.status, 200, 'Authenticated fetch should succeed');
  const authData = await authRes.json();
  assert.strictEqual(authData.user_id, alice.user_id, 'User ID should match authenticated user');
  assert.strictEqual(authData.features.device_linking, true, 'device_linking should be true');
  assert.strictEqual(authData.features.protobuf_wire, true, 'protobuf_wire should be true');
  console.log(`✓ Authenticated feature flags for Alice (${authData.user_id}) verified.`);

  // 3. Alternative endpoint /api/v1/features
  const v1Res = await fetch(`${AUTH_HTTP_URL}/api/v1/features`, {
    headers: {
      Authorization: `Bearer ${alice.access_token}`,
    },
  });
  assert.strictEqual(v1Res.status, 200);
  const v1Data = await v1Res.json();
  assert.deepStrictEqual(v1Data.features, authData.features);
  console.log('✓ /api/v1/features endpoint identical output verified.');

  console.log('\n=== All Feature Flagging Tests Passed! ===\n');
}

run().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
