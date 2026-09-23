import { GenChatCrypto, SecureKeyStorage } from '@genchat/client-crypto'
import { ensureWasmInitialized } from './wasm-crypto'
// @ts-ignore
import * as wasmModule from '../../../../crypto/genchat-crypto-wasm/pkg/genchat_crypto_wasm.js'

let cryptoInstance: GenChatCrypto | null = null
let keyStorageInstance: SecureKeyStorage | null = null

/**
 * Returns the initialized GenChatCrypto instance with WASM core hooked
 */
export async function getCryptoCore(): Promise<GenChatCrypto> {
  if (cryptoInstance) {
    return cryptoInstance
  }

  await ensureWasmInitialized()

  if (!keyStorageInstance) {
    keyStorageInstance = new SecureKeyStorage()
  }

  cryptoInstance = new GenChatCrypto(wasmModule as any, keyStorageInstance)
  return cryptoInstance
}

/**
 * Returns the SecureKeyStorage instance
 */
export function getKeyStorage(): SecureKeyStorage {
  if (!keyStorageInstance) {
    keyStorageInstance = new SecureKeyStorage()
  }
  return keyStorageInstance
}
