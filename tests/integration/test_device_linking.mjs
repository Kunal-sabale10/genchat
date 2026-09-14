import assert from 'assert';
import { subtle, createHash, randomBytes } from 'crypto';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';

console.log('=== Test 2: Real Multi-Device Key Synchronization & QR Linking ===\n');

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
  const primary = await provisionUser('Alice Primary');
  console.log(`✓ Provisioned Primary Device: ${primary.user_id}, deviceId=${primary.device_id}`);

  // 1. Primary device generates ephemeral ECDH keypair
  const primaryKeyPair = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits', 'deriveKey']
  );
  const primaryPubRaw = Buffer.from(await subtle.exportKey('raw', primaryKeyPair.publicKey));

  // 2. Primary generates 6-digit confirmation code
  const code = '849201';
  const codeHash = createHash('sha256').update(code).digest();

  // 3. Primary initiates device linking session on auth
  const initRes = await fetch(`${AUTH_HTTP_URL}/auth/device-link/initiate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${primary.access_token}`,
    },
    body: JSON.stringify({
      ephemeral_pubkey: primaryPubRaw.toString('base64'),
      auth_code_hash: codeHash.toString('base64'),
    }),
  });
  assert.strictEqual(initRes.status, 200, 'Initiate session should return HTTP 200');
  const { session_id } = await initRes.json();
  console.log(`✓ Initiated linking session: ${session_id}`);

  // 4. Check initial status
  const statusRes1 = await fetch(`${AUTH_HTTP_URL}/auth/device-link/status?session_id=${session_id}`, {
    headers: { Authorization: `Bearer ${primary.access_token}` },
  });
  const status1 = await statusRes1.json();
  assert.strictEqual(status1.status, 'pending');
  assert.strictEqual(status1.has_bundle, false);
  console.log('✓ Verified initial status is pending with no bundle');

  // 5. Secondary device generates ephemeral ECDH keypair
  const secondaryKeyPair = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits', 'deriveKey']
  );
  const secondaryPubRaw = Buffer.from(await subtle.exportKey('raw', secondaryKeyPair.publicKey));

  // 6. Mutual shared secret derivation
  // Primary imports secondary pubkey & derives sharedKey
  const importedSecondaryPub = await subtle.importKey(
    'raw',
    secondaryPubRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const primarySharedKey = await subtle.deriveKey(
    { name: 'ECDH', public: importedSecondaryPub },
    primaryKeyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  // Secondary imports primary pubkey & derives sharedKey
  const importedPrimaryPub = await subtle.importKey(
    'raw',
    primaryPubRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const secondarySharedKey = await subtle.deriveKey(
    { name: 'ECDH', public: importedPrimaryPub },
    secondaryKeyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  // 7. Primary re-encrypts secret MLS state and identity bundle with sharedKey
  const secretTransferPayload = {
    mls_group_tree_states: {
      chan_group_1: 'ratchet_tree_data_epoch_4',
    },
    identity_key_ed25519_priv: 'super_secret_ed25519_priv_hex',
    device_label: 'Alice Secondary Laptop',
  };

  const iv = randomBytes(12);
  const encryptedBundle = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    primarySharedKey,
    new TextEncoder().encode(JSON.stringify(secretTransferPayload))
  );
  const combinedPayload = Buffer.concat([iv, Buffer.from(encryptedBundle)]);

  // 8. Primary calls /auth/device-link/approve
  const newDeviceId = crypto.randomUUID();
  const approveRes = await fetch(`${AUTH_HTTP_URL}/auth/device-link/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${primary.access_token}`,
    },
    body: JSON.stringify({
      session_id,
      new_device_id: newDeviceId,
      encrypted_bundle: combinedPayload.toString('base64'),
      auth_code: code,
    }),
  });
  assert.strictEqual(approveRes.status, 200, 'Approve session should return HTTP 200');
  console.log('✓ Primary approved session and uploaded encrypted transfer bundle');

  // 9. Status check shows approved
  const statusRes2 = await fetch(`${AUTH_HTTP_URL}/auth/device-link/status?session_id=${session_id}`, {
    headers: { Authorization: `Bearer ${primary.access_token}` },
  });
  const status2 = await statusRes2.json();
  assert.strictEqual(status2.status, 'approved');
  assert.strictEqual(status2.has_bundle, true);
  console.log('✓ Verified status transitioned to approved');

  // 10. Secondary calls /auth/device-link/complete
  const completeRes = await fetch(`${AUTH_HTTP_URL}/auth/device-link/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${primary.access_token}`,
    },
    body: JSON.stringify({ session_id, auth_code: code }),
  });
  assert.strictEqual(completeRes.status, 200, 'Complete session should return HTTP 200');
  const completeData = await completeRes.json();
  assert.ok(completeData.status === 'completed' || completeData.status === 'consumed', 'Status must be completed or consumed');
  assert.ok(completeData.encrypted_bundle, 'Response must contain encrypted bundle');
  console.log('✓ Secondary downloaded encrypted bundle');

  // 11. Secondary decrypts bundle with secondarySharedKey
  const downloadedCombined = Buffer.from(completeData.encrypted_bundle, 'base64');
  const downloadedIv = downloadedCombined.subarray(0, 12);
  const downloadedCt = downloadedCombined.subarray(12);

  const decryptedPayload = await subtle.decrypt(
    { name: 'AES-GCM', iv: downloadedIv },
    secondarySharedKey,
    downloadedCt
  );
  const restoredSecrets = JSON.parse(new TextDecoder().decode(decryptedPayload));
  assert.deepStrictEqual(restoredSecrets, secretTransferPayload, 'Decrypted secrets must match original payload');
  console.log('✓ Secondary decrypted bundle with shared ECDH pairing key: secrets verified!');

  console.log('\n=== ALL DEVICE LINKING TESTS PASSED ===\n');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
