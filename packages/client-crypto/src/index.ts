export * from './crypto';
export * from './storage';
export * from './types';

import initWasm from './crypto';
export async function initializeCryptoCore() {
  await initWasm();
  console.log('[GenChat Crypto] Rust/WASM core initialized successfully.');
}
