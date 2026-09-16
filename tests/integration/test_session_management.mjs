import assert from 'assert';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';

console.log('=== Test: Active Session Management & Remote Revocation Security ===\n');

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
  const aliceId = crypto.randomUUID();
  const aliceDev1 = crypto.randomUUID();
  const aliceDev2 = crypto.randomUUID();

  const bobId = crypto.randomUUID();
  const bobDev1 = crypto.randomUUID();

  const alice1 = await provisionUser('Alice Primary', aliceId, aliceDev1);
  const alice2 = await provisionUser('Alice Laptop', aliceId, aliceDev2);
  const bob = await provisionUser('Bob Hacker', bobId, bobDev1);

  // 1. Unauthenticated query must fail with 401
  console.log('[Step 1] Verifying unauthenticated query is rejected...');
  const unauthRes = await fetch(`${AUTH_HTTP_URL}/api/v1/sessions`);
  assert.strictEqual(unauthRes.status, 401, 'Unauthenticated query must return 401');
  console.log('✓ Unauthenticated request rejected with HTTP 401');

  // 2. Query Alice active sessions
  console.log('[Step 2] Listing Alice active sessions...');
  const listRes = await fetch(`${AUTH_HTTP_URL}/api/v1/sessions`, {
    headers: { Authorization: `Bearer ${alice1.access_token}` },
  });
  assert.strictEqual(listRes.status, 200, 'Listing sessions must return 200');
  const data = await listRes.json();
  assert.ok(Array.isArray(data.sessions), 'Response must contain sessions array');
  assert.ok(data.sessions.length >= 2, 'Alice must have at least 2 active sessions');

  const sess1 = data.sessions.find((s) => s.device_id === aliceDev1);
  const sess2 = data.sessions.find((s) => s.device_id === aliceDev2);
  assert.ok(sess1, 'Session 1 must exist');
  assert.ok(sess2, 'Session 2 must exist');
  assert.strictEqual(sess1.is_current, true, 'Alice Dev 1 must be marked current');
  assert.strictEqual(sess2.is_current, false, 'Alice Dev 2 must not be marked current');
  console.log('✓ Active sessions listed with accurate is_current status');

  // 3. Prevent cross-user session revocation (Bob cannot revoke Alice session)
  console.log('[Step 3] Verifying Bob cannot revoke Alice session...');
  const hackRes = await fetch(`${AUTH_HTTP_URL}/api/v1/sessions/${sess2.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${bob.access_token}` },
  });
  // Should succeed silently (0 rows updated) without affecting Alice
  const checkAliceRes = await fetch(`${AUTH_HTTP_URL}/api/v1/sessions`, {
    headers: { Authorization: `Bearer ${alice1.access_token}` },
  });
  const checkAliceData = await checkAliceRes.json();
  const stillActive = checkAliceData.sessions.find((s) => s.id === sess2.id);
  assert.ok(stillActive, 'Alice session must remain active after unauthorized revocation attempt');
  console.log('✓ Cross-user session revocation isolated and defeated');

  // 4. Alice revokes Device 2 session via POST fallback
  console.log('[Step 4] Alice revoking Device 2 session via POST /api/v1/sessions/revoke...');
  const revokePostRes = await fetch(`${AUTH_HTTP_URL}/api/v1/sessions/revoke`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alice1.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session_id: sess2.id }),
  });
  assert.strictEqual(revokePostRes.status, 200, 'Revoke POST must return 200');
  const revokePostData = await revokePostRes.json();
  assert.strictEqual(revokePostData.status, 'revoked');

  // 5. Verify Alice Device 2 session is gone
  const finalListRes = await fetch(`${AUTH_HTTP_URL}/api/v1/sessions`, {
    headers: { Authorization: `Bearer ${alice1.access_token}` },
  });
  const finalData = await finalListRes.json();
  const gone = finalData.sessions.find((s) => s.id === sess2.id);
  assert.ok(!gone, 'Revoked session must no longer be present');
  console.log('✓ Session revoked and removed from active list');

  console.log('\n======================================================');
  console.log('ALL SESSION MANAGEMENT TESTS PASSED! ✓');
  console.log('======================================================');
}

run().catch((err) => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
