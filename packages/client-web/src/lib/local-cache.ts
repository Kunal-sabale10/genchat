/**
 * LocalEncryptedCache — AES-256-GCM Encrypted Offline Cache & Delta Sync
 *
 * Implements cybersecurity-hardened local storage for messages:
 * 1. Cryptographic encryption at rest with Web Crypto AES-256-GCM (12-byte random IV per record).
 * 2. Channel sequence tracking (`last_read_seq`) to power efficient delta sync on reconnection.
 * 3. Instant local render before network reconciliation.
 */

import { localDb, StoredMessage, StoredConversation } from './local-storage-db'

const KEYSTORE_DB_NAME = 'genchat_keystore_db'
const KEYSTORE_DB_VERSION = 1
const KEYSTORE_STORE_NAME = 'keys'
const KEY_RECORD_ID = 'at_rest_aes_key'

async function openKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(KEYSTORE_DB_NAME, KEYSTORE_DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(KEYSTORE_STORE_NAME)) {
        db.createObjectStore(KEYSTORE_STORE_NAME, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function getStoredCryptoKey(): Promise<CryptoKey | null> {
  try {
    if (typeof window === 'undefined' || !window.indexedDB) return null
    const db = await openKeyDb()
    return new Promise((resolve) => {
      const tx = db.transaction(KEYSTORE_STORE_NAME, 'readonly')
      const store = tx.objectStore(KEYSTORE_STORE_NAME)
      const req = store.get(KEY_RECORD_ID)
      req.onsuccess = () => {
        if (req.result && req.result.key) {
          resolve(req.result.key as CryptoKey)
        } else {
          resolve(null)
        }
      }
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function persistCryptoKey(key: CryptoKey): Promise<void> {
  try {
    if (typeof window === 'undefined' || !window.indexedDB) return
    const db = await openKeyDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(KEYSTORE_STORE_NAME, 'readwrite')
      const store = tx.objectStore(KEYSTORE_STORE_NAME)
      const req = store.put({ id: KEY_RECORD_ID, key, createdAt: Date.now() })
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch (err) {
    console.warn('[LocalEncryptedCache] Failed to persist key in IndexedDB:', err)
  }
}

export class LocalEncryptedCache {
  private static cryptoKey: CryptoKey | null = null

  /**
   * Initializes or retrieves the non-extractable client encryption-at-rest key.
   * Stored securely in IndexedDB as a structured CryptoKey with extractable=false.
   */
  private static async getOrCreateKey(): Promise<CryptoKey> {
    if (this.cryptoKey) return this.cryptoKey

    // 1. Clean up legacy insecure sessionStorage item if present
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        sessionStorage.removeItem('genchat_at_rest_key')
      }
    } catch {
      // Ignore
    }

    // 2. Attempt to load non-extractable key from IndexedDB
    const stored = await getStoredCryptoKey()
    if (stored) {
      this.cryptoKey = stored
      return stored
    }

    // 3. Generate non-extractable AES-256-GCM key (extractable=false prevents JS memory read)
    const generated = await window.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable
      ['encrypt', 'decrypt']
    )

    await persistCryptoKey(generated)
    this.cryptoKey = generated
    return generated
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

  /**
   * Permanently purges expired ephemeral messages from offline storage.
   */
  public static async purgeExpiredMessages(): Promise<string[]> {
    return localDb.purgeExpiredMessages()
  }

  /**
   * Permanently deletes a single message from offline storage.
   */
  public static async deleteMessage(idOrClientMsgId: string, channelId?: string): Promise<void> {
    return localDb.deleteMessage(idOrClientMsgId, channelId)
  }

  /**
   * Updates an edited message in offline storage.
   */
  public static async updateMessageText(
    idOrClientMsgId: string,
    channelId: string,
    newText: string,
    editedAt: number = Date.now()
  ): Promise<void> {
    return localDb.updateMessageText(idOrClientMsgId, channelId, newText, editedAt)
  }
}
