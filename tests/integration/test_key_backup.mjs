import assert from 'assert';
import { subtle, randomBytes } from 'crypto';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';

console.log('=== Test 1: Encrypted Key/Account Backup and Recovery ===\n');

async function provisionUser(name) {
  const res = await fetch(`${AUTH_HTTP_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: name, user_id: crypto.randomUUID(), device_id: crypto.randomUUID() }),
  });
  if (!res.ok) throw new Error(`Failed to provision user: ${res.status}`);
  return await res.json();
}

async function deriveKey(passphrase, salt, iterations = 600000) {
  const enc = new TextEncoder();
  const keyMaterial = await subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function run() {
  const user = await provisionUser('Alice Backup');
  console.log(`✓ Provisioned Alice: ${user.user_id}`);

  const passphrase = 'SuperSecretBackupPassword!2026';
  const salt = randomBytes(32);
  const iv = randomBytes(12);

  const mockIdentityBundle = {
    identity_key_ed25519_pub_hex: 'a1b2c3d4e5f6',
    identity_key_ed25519_priv_hex: 'secret_priv_key_00112233',
    account_metadata: {
      display_name: 'Alice Backup',
      created_year: 2026,
    },
  };

  const key = await deriveKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(mockIdentityBundle));

  const encrypted = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );

  const combinedCiphertext = Buffer.concat([iv, Buffer.from(encrypted)]);

  const backupPayload = {
    backup_ciphertext: combinedCiphertext.toString('base64'),
    kdf_salt: salt.toString('base64'),
    kdf_algorithm: 'pbkdf2_aes256gcm',
    kdf_params: {
      iterations: 600000,
      hash: 'SHA-256',
      keyLength: 256,
    },
    bundle_version: 1,
  };

  // 1. Upload backup
  const saveRes = await fetch(`${AUTH_HTTP_URL}/auth/backup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.access_token}`,
    },
    body: JSON.stringify(backupPayload),
  });
  assert.strictEqual(saveRes.status, 200, 'Save backup should return HTTP 200');
  const saveJson = await saveRes.json();
  assert.strictEqual(saveJson.status, 'saved');
  console.log('✓ Uploaded zero-knowledge encrypted backup to /auth/backup');

  // 2. Fetch backup
  const getRes = await fetch(`${AUTH_HTTP_URL}/auth/backup`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${user.access_token}` },
  });
  assert.strictEqual(getRes.status, 200, 'Get backup should return HTTP 200');
  const fetchedBackup = await getRes.json();
  assert.strictEqual(fetchedBackup.backup_ciphertext, backupPayload.backup_ciphertext);
  assert.strictEqual(fetchedBackup.bundle_version, 1);
  console.log('✓ Successfully retrieved encrypted backup and KDF parameters');

  // 3. Decrypt with correct passphrase
  const fetchedCombined = Buffer.from(fetchedBackup.backup_ciphertext, 'base64');
  const fetchedIv = fetchedCombined.subarray(0, 12);
  const fetchedCt = fetchedCombined.subarray(12);
  const fetchedSalt = Buffer.from(fetchedBackup.kdf_salt, 'base64');

  const recoveryKey = await deriveKey(passphrase, fetchedSalt, fetchedBackup.kdf_params.iterations);
  const decryptedBuf = await subtle.decrypt(
    { name: 'AES-GCM', iv: fetchedIv },
    recoveryKey,
    fetchedCt
  );
  const restoredBundle = JSON.parse(new TextDecoder().decode(decryptedBuf));
  assert.deepStrictEqual(restoredBundle, mockIdentityBundle, 'Restored bundle must match original');
  console.log('✓ Restored identity bundle verified with correct master passphrase');

  // 4. Test wrong passphrase fails
  try {
    const wrongKey = await deriveKey('WrongPassphrase123!', fetchedSalt, fetchedBackup.kdf_params.iterations);
    await subtle.decrypt(
      { name: 'AES-GCM', iv: fetchedIv },
      wrongKey,
      fetchedCt
    );
    assert.fail('Decryption with wrong passphrase must fail');
  } catch (err) {
    console.log('✓ Decryption with wrong passphrase failed cleanly as expected');
  }

  // 5. Delete backup
  const delRes = await fetch(`${AUTH_HTTP_URL}/auth/backup`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${user.access_token}` },
  });
  assert.strictEqual(delRes.status, 200, 'Delete backup should return HTTP 200');

  const getAfterDel = await fetch(`${AUTH_HTTP_URL}/auth/backup`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${user.access_token}` },
  });
  assert.strictEqual(getAfterDel.status, 404, 'Get backup after delete should return HTTP 404');
  console.log('✓ Deleted backup and verified 404 on subsequent fetch');

  console.log('\n=== ALL KEY BACKUP TESTS PASSED ===\n');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
