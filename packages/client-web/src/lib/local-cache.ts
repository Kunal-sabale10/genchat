/**
 * LocalEncryptedCache — AES-256-GCM Encrypted Offline Cache & Delta Sync
 *
 * Implements cybersecurity-hardened local storage for messages:
 * 1. Cryptographic encryption at rest with Web Crypto AES-256-GCM (12-byte random IV per record).
 * 2. Channel sequence tracking (`last_read_seq`) to power efficient delta sync on reconnection.
 * 3. Instant local render before network reconciliation.
 */

import { localDb, StoredMessage, StoredConversation } from './local-storage-db'

const ENCRYPTION_KEY_STORAGE = 'genchat_at_rest_key'

export class LocalEncryptedCache {
  private static cryptoKey: CryptoKey | null = null

  /**
   * Initializes or retrieves the ephemeral client encryption-at-rest key.
   */
  private static async getOrCreateKey(): Promise<CryptoKey> {
    if (this.cryptoKey) return this.cryptoKey

    let rawKeyB64 = sessionStorage.getItem(ENCRYPTION_KEY_STORAGE)
    let rawKey: Uint8Array

    if (!rawKeyB64) {
      rawKey = new Uint8Array(32)
      window.crypto.getRandomValues(rawKey)
      let b64 = ''
      for (let i = 0; i < rawKey.length; i++) {
        b64 += String.fromCharCode(rawKey[i])
      }
      rawKeyB64 = btoa(b64)
      sessionStorage.setItem(ENCRYPTION_KEY_STORAGE, rawKeyB64)
    } else {
      const binStr = atob(rawKeyB64)
      rawKey = new Uint8Array(binStr.length)
      for (let i = 0; i < binStr.length; i++) {
        rawKey[i] = binStr.charCodeAt(i)
      }
    }

    this.cryptoKey = await window.crypto.subtle.importKey(
      'raw',
      rawKey.buffer as ArrayBuffer,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    )
    return this.cryptoKey
  }

  /**
   * Encrypts message text using AES-256-GCM with a fresh 12-byte IV.
   */
  public static async encryptText(plaintext: string): Promise<{ ciphertextB64: string; ivB64: string }> {
    const key = await this.getOrCreateKey()
    const iv = new Uint8Array(12)
    window.crypto.getRandomValues(iv)

    const encoded = new TextEncoder().encode(plaintext)
    const cipherBuffer = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoded
    )

    const cipherBytes = new Uint8Array(cipherBuffer)
    let cStr = ''
    for (let i = 0; i < cipherBytes.length; i++) cStr += String.fromCharCode(cipherBytes[i])

    let ivStr = ''
    for (let i = 0; i < iv.length; i++) ivStr += String.fromCharCode(iv[i])

    return {
      ciphertextB64: btoa(cStr),
      ivB64: btoa(ivStr),
    }
  }

  /**
   * Decrypts encrypted message text using AES-256-GCM.
   */
  public static async decryptText(ciphertextB64: string, ivB64: string): Promise<string> {
    try {
      const key = await this.getOrCreateKey()
      const cBin = atob(ciphertextB64)
      const cipherBytes = new Uint8Array(cBin.length)
      for (let i = 0; i < cBin.length; i++) cipherBytes[i] = cBin.charCodeAt(i)

      const ivBin = atob(ivB64)
      const iv = new Uint8Array(ivBin.length)
      for (let i = 0; i < ivBin.length; i++) iv[i] = ivBin.charCodeAt(i)

      const plainBuffer = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        cipherBytes
      )
      return new TextDecoder().decode(plainBuffer)
    } catch {
      return ciphertextB64
    }
  }

  /**
   * Saves a message into IndexedDB with its text encrypted at rest.
   */
  public static async saveMessage(msg: StoredMessage): Promise<void> {
    let encryptedText = msg.text
    if (msg.text) {
      try {
        const { ciphertextB64, ivB64 } = await this.encryptText(msg.text)
        encryptedText = `ENC_GCM:${ivB64}:${ciphertextB64}`
      } catch {
        encryptedText = msg.text
      }
    }

    await localDb.saveMessage({
      ...msg,
      text: encryptedText,
    })
  }

  /**
   * Loads messages for a channel and decrypts them.
   */
  public static async loadMessages(channelId: string): Promise<StoredMessage[]> {
    const rawList = await localDb.getMessagesByChannel(channelId)
    const decrypted: StoredMessage[] = []

    for (const m of rawList) {
      if (m.text && m.text.startsWith('ENC_GCM:')) {
        const parts = m.text.split(':')
        if (parts.length === 3) {
          const plain = await this.decryptText(parts[2], parts[1])
          decrypted.push({ ...m, text: plain })
          continue
        }
      }
      decrypted.push(m)
    }

    return decrypted
  }

  /**
   * Tracks the latest durable sequence number per channel for delta synchronization.
   */
  public static getLastReadSeq(channelId: string): number {
    try {
      const val = localStorage.getItem(`genchat_last_seq_${channelId}`)
      return val ? parseInt(val, 10) : 0
    } catch {
      return 0
    }
  }

  public static setLastReadSeq(channelId: string, seq: number): void {
    try {
      const current = this.getLastReadSeq(channelId)
      if (seq > current) {
        localStorage.setItem(`genchat_last_seq_${channelId}`, seq.toString())
      }
    } catch {
      // Storage unavailable
    }
  }
}
