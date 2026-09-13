/* tslint:disable */
/* eslint-disable */

/**
 * 4. Create new Ratchet Account
 */
export function create_ratchet_account(pickle_key_hex: string): string;

/**
 * 6. Decrypt message using Double Ratchet session state
 */
export function decrypt_message(session_pickle: string, pickle_key_hex: string, message_type: number, ciphertext_base64: string): any;

/**
 * 5. Encrypt message using Double Ratchet session state
 */
export function encrypt_message(session_pickle: string, pickle_key_hex: string, plaintext: Uint8Array): any;

/**
 * 1. Generate full local PQXDH key bundles (Identity, Signed Pre-Key, Post-Quantum ML-KEM Pre-Key, One-Time Keys)
 */
export function generate_pqxdh_keys(one_time_keys_count: number): any;

export function init_panic_hook(): void;

/**
 * 2. Initiate PQXDH Handshake (Alice -> Bob)
 */
export function initiate_pqxdh_handshake(alice_identity_bundle: any, bob_public_bundle: any): any;

/**
 * 10. Create a new MLS group (creator is leaf 0)
 */
export function mls_create_group(group_id: string, user_id: string, device_id: string, identity_priv_hex: string, hpke_priv_hex: string): string;

/**
 * 9. Generate an MLS KeyPackage for advertising group readiness
 */
export function mls_generate_key_package(user_id: string, device_id: string, identity_priv_hex: string): any;

/**
 * 11. Add a member to the group from their published KeyPackage
 */
export function mls_group_add_member(group_state_json: string, key_package_json: string): any;

/**
 * 13. Apply an incoming MlsCommit from an existing member to advance epoch
 */
export function mls_group_apply_commit(group_state_json: string, commit_json: string): any;

/**
 * 16. Decrypt an application message using the group's current epoch application secret
 */
export function mls_group_decrypt_message(group_state_json: string, ciphertext_json: string): any;

/**
 * 15. Encrypt an application message using the group's current epoch application secret
 */
export function mls_group_encrypt_message(group_state_json: string, plaintext: Uint8Array): any;

/**
 * 12. Join a group from a received MlsWelcome envelope
 */
export function mls_group_from_welcome(welcome_json: string, identity_priv_hex: string, hpke_priv_hex: string): any;

/**
 * 14. Remove a member from the group (re-keying epoch and generating MlsCommit)
 */
export function mls_group_remove_member(group_state_json: string, user_id: string): any;

/**
 * 3. Receive PQXDH Handshake (Bob <- Alice)
 */
export function receive_pqxdh_handshake(bob_identity_bundle: any, alice_init_message: any): string;

/**
 * 8. SFrame WebRTC media frame decryption
 */
export function sframe_decrypt(participant_key_id: bigint, base_secret_hex: string, encrypted_frame: Uint8Array): Uint8Array;

/**
 * 7. SFrame WebRTC media frame encryption
 */
export function sframe_encrypt(participant_key_id: bigint, base_secret_hex: string, frame_payload: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly create_ratchet_account: (a: number, b: number) => [number, number, number, number];
    readonly decrypt_message: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly encrypt_message: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly generate_pqxdh_keys: (a: number) => [number, number, number];
    readonly init_panic_hook: () => void;
    readonly initiate_pqxdh_handshake: (a: any, b: any) => [number, number, number];
    readonly mls_create_group: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly mls_generate_key_package: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly mls_group_add_member: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly mls_group_apply_commit: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly mls_group_decrypt_message: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly mls_group_encrypt_message: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly mls_group_from_welcome: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly mls_group_remove_member: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly receive_pqxdh_handshake: (a: any, b: any) => [number, number, number, number];
    readonly sframe_decrypt: (a: bigint, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly sframe_encrypt: (a: bigint, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
