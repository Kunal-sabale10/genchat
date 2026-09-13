/**
 * WasmCrypto — WebAssembly Cryptographic Engine Loader & Bridge
 *
 * Provides Post-Quantum XDH (ML-KEM-768 + X25519) and RFC 9420 MLS TreeKEM
 * primitives to the GenChat web client.
 */

// @ts-ignore
import initWasm, * as wasm from '../../../../crypto/genchat-crypto-wasm/pkg/genchat_crypto_wasm.js'
// @ts-ignore
import wasmUrl from '../../../../crypto/genchat-crypto-wasm/pkg/genchat_crypto_wasm_bg.wasm?url'

export interface WasmOneTimePreKey {
  key_id: number
  public_key_hex: string
  private_key_hex: string
}

export interface WasmOneTimePublicKey {
  key_id: number
  public_key_hex: string
}

export interface WasmSignedPreKey {
  key_id: number
  public_key_hex: string
  private_key_hex: string
  signature_hex: string
}

export interface WasmPqPreKey {
  key_id: number
  public_key_hex: string
  decapsulation_key_hex: string
  signature_hex: string
}

export interface WasmIdentityBundle {
  identity_key_ed25519_pub_hex: string
  identity_key_ed25519_priv_hex: string
  identity_key_x25519_pub_hex: string
  identity_key_x25519_priv_hex: string
  signed_pre_key: WasmSignedPreKey
  pq_pre_key: WasmPqPreKey
  one_time_pre_keys: WasmOneTimePreKey[]
}

export interface WasmPublicPreKeyBundle {
  identity_key_hex: string
  identity_key_x25519_hex: string
  signed_pre_key_id: number
  signed_pre_key_public_hex: string
  signed_pre_key_signature_hex: string
  pq_pre_key_id: number
  pq_pre_key_public_hex: string
  pq_pre_key_signature_hex: string
  one_time_pre_keys: WasmOneTimePublicKey[]
}

export interface WasmPqxdhInitMessage {
  sender_identity_key_hex: string
  sender_identity_key_x25519_hex: string
  ephemeral_key_hex: string
  pq_ciphertext_hex: string
  used_signed_pre_key_id: number
  used_pq_pre_key_id: number
  used_one_time_key_id?: number
}

export interface WasmHandshakeInitResult {
  shared_secret_hex: string
  init_message: WasmPqxdhInitMessage
}

export interface WasmMlsKeyPackageResult {
  user_id: string
  device_id: string
  key_package_json: string
  hpke_private_key_hex: string
}

export interface WasmMlsAddMemberResult {
  welcome_json: string
  commit_json: string
  updated_group_state: string
}

export interface WasmMlsJoinResult {
  updated_group_state: string
  epoch: number
}

export interface WasmMlsEncryptResult {
  ciphertext_json: string
  updated_group_state: string
}

export interface WasmMlsDecryptResult {
  plaintext: number[] | Uint8Array
  sender_leaf_index: number
}

let wasmInitPromise: Promise<void> | null = null

export async function ensureWasmInitialized(): Promise<void> {
  if (wasmInitPromise) {
    return wasmInitPromise
  }

  wasmInitPromise = (async () => {
    try {
      if (typeof window !== 'undefined') {
        // Browser environment with Vite
        await initWasm(wasmUrl)
      } else {
        // Node / test environment fallback
        await initWasm()
      }
    } catch (err) {
      console.error('[WasmCrypto] Failed to initialize WebAssembly core:', err)
      wasmInitPromise = null
      throw err
    }
  })()

  return wasmInitPromise
}

export class WasmCrypto {
  /**
   * 1. Generate full PQXDH key bundles (Identity, Signed Pre-Key, ML-KEM-768 Pre-Key, and OTKs)
   */
  public static async generatePqxdhKeys(count: number = 25): Promise<{
    identity_bundle: WasmIdentityBundle
    public_bundle: WasmPublicPreKeyBundle
  }> {
    await ensureWasmInitialized()
    return wasm.generate_pqxdh_keys(count)
  }

  /**
   * 2. Initiate PQXDH Handshake with Bob's public PreKeyBundle (Alice -> Bob)
   */
  public static async initiatePqxdhHandshake(
    aliceIdentity: WasmIdentityBundle,
    bobPublicBundle: WasmPublicPreKeyBundle
  ): Promise<WasmHandshakeInitResult> {
    await ensureWasmInitialized()
    return wasm.initiate_pqxdh_handshake(aliceIdentity, bobPublicBundle)
  }

  /**
   * 3. Receive PQXDH Handshake from Alice's Init Message (Bob <- Alice)
   */
  public static async receivePqxdhHandshake(
    bobIdentity: WasmIdentityBundle,
    aliceInitMessage: WasmPqxdhInitMessage
  ): Promise<string> {
    await ensureWasmInitialized()
    return wasm.receive_pqxdh_handshake(bobIdentity, aliceInitMessage)
  }

  /**
   * 4. Generate an MLS KeyPackage for publishing group readiness
   */
  public static async mlsGenerateKeyPackage(
    userId: string,
    deviceId: string,
    identityPrivHex: string
  ): Promise<WasmMlsKeyPackageResult> {
    await ensureWasmInitialized()
    return wasm.mls_generate_key_package(userId, deviceId, identityPrivHex)
  }

  /**
   * 5. Create a new MLS group (Creator is Leaf 0)
   */
  public static async mlsCreateGroup(
    groupId: string,
    userId: string,
    deviceId: string,
    identityPrivHex: string,
    hpkePrivHex: string
  ): Promise<string> {
    await ensureWasmInitialized()
    return wasm.mls_create_group(groupId, userId, deviceId, identityPrivHex, hpkePrivHex)
  }

  /**
   * 6. Add a member to the group from their published KeyPackage (returns Welcome & Commit)
   */
  public static async mlsGroupAddMember(
    groupStateJson: string,
    keyPackageJson: string
  ): Promise<WasmMlsAddMemberResult> {
    await ensureWasmInitialized()
    return wasm.mls_group_add_member(groupStateJson, keyPackageJson)
  }

  /**
   * 7. Join a group from a received MlsWelcome envelope
   */
  public static async mlsGroupFromWelcome(
    welcomeJson: string,
    identityPrivHex: string,
    hpkePrivHex: string
  ): Promise<WasmMlsJoinResult> {
    await ensureWasmInitialized()
    return wasm.mls_group_from_welcome(welcomeJson, identityPrivHex, hpkePrivHex)
  }

  /**
   * 8. Apply an incoming MlsCommit to advance group epoch
   */
  public static async mlsGroupApplyCommit(
    groupStateJson: string,
    commitJson: string
  ): Promise<WasmMlsJoinResult> {
    await ensureWasmInitialized()
    return wasm.mls_group_apply_commit(groupStateJson, commitJson)
  }

  /**
   * 9. Remove a member from the group (re-keying epoch and generating commit)
   */
  public static async mlsGroupRemoveMember(
    groupStateJson: string,
    userId: string
  ): Promise<{ commit_json: string; updated_group_state: string; epoch: number }> {
    await ensureWasmInitialized()
    return wasm.mls_group_remove_member(groupStateJson, userId)
  }

  /**
   * 10. Encrypt application message using group's current epoch secret
   */
  public static async mlsGroupEncryptMessage(
    groupStateJson: string,
    plaintext: Uint8Array
  ): Promise<WasmMlsEncryptResult> {
    await ensureWasmInitialized()
    return wasm.mls_group_encrypt_message(groupStateJson, plaintext)
  }

  /**
   * 11. Decrypt application message using group's current epoch secret
   */
  public static async mlsGroupDecryptMessage(
    groupStateJson: string,
    ciphertextJson: string
  ): Promise<WasmMlsDecryptResult> {
    await ensureWasmInitialized()
    return wasm.mls_group_decrypt_message(groupStateJson, ciphertextJson)
  }
}
