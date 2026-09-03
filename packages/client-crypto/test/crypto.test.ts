import assert from "node:assert";
import { test } from "node:test";
import { SecureKeyStorage } from "../src/storage.js";
import { IdentityKeyBundle } from "../src/types.js";

test("SecureKeyStorage encrypts and retrieves IdentityKeyBundle with non-exportable master key", async () => {
  const storage = new SecureKeyStorage();

  const masterKey = await storage.getMasterKey();
  assert.strictEqual(masterKey.extractable, false, "Master key MUST be non-extractable!");

  const mockIdentity: IdentityKeyBundle = {
    identity_key_ed25519_pub_hex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    identity_key_ed25519_priv_hex: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    identity_key_x25519_pub_hex: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    identity_key_x25519_priv_hex: "112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00",
    signed_pre_key: {
      key_id: 1,
      public_key_hex: "1234",
      private_key_hex: "5678",
      signature_hex: "abcd",
    },
    pq_pre_key: {
      key_id: 1,
      public_key_hex: "9999",
      decapsulation_key_hex: "8888",
      signature_hex: "7777",
    },
    one_time_pre_keys: [],
  };

  await storage.storeIdentityKey(mockIdentity);

  const retrieved = await storage.loadIdentityKey();
  assert.ok(retrieved, "Retrieved identity must not be null");
  assert.strictEqual(retrieved.identity_key_ed25519_pub_hex, mockIdentity.identity_key_ed25519_pub_hex);
  assert.strictEqual(retrieved.identity_key_ed25519_priv_hex, mockIdentity.identity_key_ed25519_priv_hex);

  await storage.wipeAllKeys();
  const afterWipe = await storage.loadIdentityKey();
  assert.strictEqual(afterWipe, null, "After wipeAllKeys, storage must be empty");
});
