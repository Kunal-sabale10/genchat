import assert from 'assert';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';

console.log('=== Test 5: GDPR Data Export & Right-to-Erasure ===\n');

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
  const charlie = await provisionUser('Charlie GDPR');
  const targetPeer = await provisionUser('Peer To Block');
  console.log(`✓ Provisioned Charlie (${charlie.user_id}) and Peer (${targetPeer.user_id})`);

  // 1. Charlie saves a key backup
  const backupRes = await fetch(`${AUTH_HTTP_URL}/auth/backup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${charlie.access_token}`,
    },
    body: JSON.stringify({
      backup_ciphertext: Buffer.from('encrypted_backup_charlie').toString('base64'),
      kdf_salt: Buffer.from('salt_32_bytes_charlie_00000000000').toString('base64'),
      kdf_algorithm: 'pbkdf2_aes256gcm',
      kdf_params: { iterations: 600000 },
      bundle_version: 1,
    }),
  });
  assert.strictEqual(backupRes.status, 200);
  console.log('✓ Charlie created a key backup');

  // 2. Charlie blocks targetPeer
  const blockRes = await fetch(`${AUTH_HTTP_URL}/users/block`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${charlie.access_token}`,
    },
    body: JSON.stringify({ blocked_user_id: targetPeer.user_id }),
  });
  assert.strictEqual(blockRes.status, 200);
  console.log('✓ Charlie blocked a peer');

  // 3. GDPR Data Export: GET /users/export
  const exportRes = await fetch(`${AUTH_HTTP_URL}/users/export`, {
    headers: { Authorization: `Bearer ${charlie.access_token}` },
  });
  assert.strictEqual(exportRes.status, 200, 'Export must return HTTP 200');
  const exportData = await exportRes.json();

  assert.strictEqual(exportData.user_id, charlie.user_id);
  assert.strictEqual(exportData.display_name, 'Charlie GDPR');
  assert.strictEqual(exportData.has_key_backup, true, 'Export must reflect key backup existence');
  assert.ok(Array.isArray(exportData.devices), 'Export must list devices');
  assert.ok(exportData.devices.length >= 1, 'Export must include primary device');
  assert.ok(exportData.blocked_users.includes(targetPeer.user_id), 'Export must list blocked users');
  assert.ok(exportData.exported_at, 'Export must include timestamp');
  console.log('✓ Exported comprehensive GDPR user bundle successfully verified:');
  console.log(`  - user_id: ${exportData.user_id}`);
  console.log(`  - devices: ${exportData.devices.length}`);
  console.log(`  - has_key_backup: ${exportData.has_key_backup}`);
  console.log(`  - blocked_users: ${exportData.blocked_users.length}`);

  // 4. GDPR Right-to-Erasure: DELETE /users/me
  console.log('Executing cascade account erasure (DELETE /users/me)...');
  const eraseRes = await fetch(`${AUTH_HTTP_URL}/users/me`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${charlie.access_token}` },
  });
  assert.strictEqual(eraseRes.status, 200, 'Erasure should return HTTP 200');
  const eraseData = await eraseRes.json();
  assert.strictEqual(eraseData.status, 'erased');
  console.log('✓ Cascade account erasure completed successfully');

  // 5. Verify Charlie records and backup are deleted
  const getBackupAfterErase = await fetch(`${AUTH_HTTP_URL}/auth/backup`, {
    headers: { Authorization: `Bearer ${charlie.access_token}` },
  });
  // Should either return 401 (token invalidated/user gone) or 404 (backup gone)
  assert.ok(
    getBackupAfterErase.status === 401 || getBackupAfterErase.status === 404,
    `Expected 401 or 404 after erasure, got ${getBackupAfterErase.status}`
  );
  console.log(`✓ Access after erasure blocked as expected (HTTP ${getBackupAfterErase.status})`);

  console.log('\n=== ALL GDPR EXPORT & ERASURE TESTS PASSED ===\n');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
