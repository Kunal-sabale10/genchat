/**
 * Post-Quantum Key Generation Ceremony
 *
 * Triggered after successful WebAuthn registration.
 * Generates ML-KEM-768 + X25519 keypairs, signs them with Ed25519,
 * stores the secret IdentityKeyBundle locally (encrypted via WebCrypto),
 * and returns the 32-byte Ed25519 public identity key for upload to authd.
 */

/** Mirrors @genchat/client-crypto IdentityKeyBundle */
interface IdentityKeyBundle {
  identity_key_ed25519_pub_hex: string
  identity_key_ed25519_priv_hex: string
  identity_key_x25519_pub_hex: string
  identity_key_x25519_priv_hex: string
  signed_pre_key: unknown
  pq_pre_key: unknown
  one_time_pre_keys: unknown[]
}

/** Mirrors @genchat/client-crypto PublicPreKeyBundle */
interface PublicPreKeyBundle {
  identity_key_hex: string
  identity_key_x25519_hex: string
  signed_pre_key_id: number
  signed_pre_key_public_hex: string
  signed_pre_key_signature_hex: string
  pq_pre_key_id: number
  pq_pre_key_public_hex: string
  pq_pre_key_signature_hex: string
  one_time_pre_keys: Array<{ key_id: number; public_key_hex: string }>
}

export interface KeyCeremonyResult {
  /** 32-byte Ed25519 public identity key (sent to authd during FinishRegistration) */
  identityKeyBytes: Uint8Array
  /** Full public PreKey bundle (to be uploaded via UploadPreKeys RPC in Phase 8) */
  publicBundle: PublicPreKeyBundle
}

/**
 * Performs the local key generation ceremony.
 *
 * In production, `crypto` is the initialized GenChatCrypto instance with Wasm loaded.
 * For now, we provide a standalone function that can be called with any crypto provider.
 */
export async function performKeyCeremony(
  crypto: {
    generatePqxdhKeys: (count: number) => { identityBundle: IdentityKeyBundle; publicBundle: PublicPreKeyBundle }
    storage: {
      storeIdentityKey: (bundle: IdentityKeyBundle) => Promise<void>
    }
  },
  oneTimeKeysCount: number = 20
): Promise<KeyCeremonyResult> {
  // 1. Generate ML-KEM-768 + X25519 + Ed25519 key material via Rust Wasm
  const { identityBundle, publicBundle } = crypto.generatePqxdhKeys(oneTimeKeysCount)

  // 2. Store the secret IdentityKeyBundle locally (encrypted at rest via WebCrypto AES-GCM)
  await crypto.storage.storeIdentityKey(identityBundle)

  // 3. Extract the 32-byte Ed25519 public identity key for the server
  const identityKeyBytes = hexToBytes(identityBundle.identity_key_ed25519_pub_hex)

  return { identityKeyBytes, publicBundle }
}

/** Convert a hex string to Uint8Array */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
  }
  return bytes
}
