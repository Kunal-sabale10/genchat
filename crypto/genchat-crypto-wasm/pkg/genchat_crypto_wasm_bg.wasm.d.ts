/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const create_ratchet_account: (a: number, b: number) => [number, number, number, number];
export const decrypt_message: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
export const encrypt_message: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
export const generate_pqxdh_keys: (a: number) => [number, number, number];
export const init_panic_hook: () => void;
export const initiate_pqxdh_handshake: (a: any, b: any) => [number, number, number];
export const mls_create_group: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
export const mls_generate_key_package: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
export const mls_group_add_member: (a: number, b: number, c: number, d: number) => [number, number, number];
export const mls_group_apply_commit: (a: number, b: number, c: number, d: number) => [number, number, number];
export const mls_group_decrypt_message: (a: number, b: number, c: number, d: number) => [number, number, number];
export const mls_group_encrypt_message: (a: number, b: number, c: number, d: number) => [number, number, number];
export const mls_group_from_welcome: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
export const mls_group_remove_member: (a: number, b: number, c: number, d: number) => [number, number, number];
export const receive_pqxdh_handshake: (a: any, b: any) => [number, number, number, number];
export const sframe_decrypt: (a: bigint, b: number, c: number, d: number, e: number) => [number, number, number, number];
export const sframe_encrypt: (a: bigint, b: number, c: number, d: number, e: number) => [number, number, number, number];
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_start: () => void;
