/**
 * Post-Quantum Key Generation Ceremony
 *
 * Triggered after successful WebAuthn registration.
 * Generates ML-KEM-768 + X25519 keypairs, signs them with Ed25519,
 * stores the secret IdentityKeyBundle locally (encrypted via WebCrypto),
 * and returns the 32-byte Ed25519 public identity key for upload to authd.
 */

import type { IdentityKeyBundle, PublicPreKeyBundle, GenChatCrypto } from '@genchat/client-crypto'

export interface KeyCeremonyResult {
  /** 32-byte Ed25519 public identity key (sent to authd during FinishRegistration) */
  identityKeyBytes: Uint8Array
  /** Full public PreKey bundle (to be uploaded via UploadPreKeys RPC) */
  publicBundle: PublicPreKeyBundle
}

/**
 * Performs the local key generation ceremony.
 * Generates ML-KEM-768 + X25519 keypairs, signs them with Ed25519,
 * stores the secret IdentityKeyBundle locally (encrypted via WebCrypto AES-GCM),
 * and returns the 32-byte Ed25519 public identity key for upload to authd.
 */
export async function performKeyCeremony(
  crypto: GenChatCrypto,
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
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}
