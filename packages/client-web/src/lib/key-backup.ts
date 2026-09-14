/**
 * Zero-Knowledge Encrypted Key and Account Backup & Recovery
 *
 * Implements Signal-style client-side zero-knowledge encrypted backups:
 * 1. Derives an AES-256-GCM encryption key from a user-provided passphrase/PIN using PBKDF2-SHA256 (600,000 iterations).
 * 2. Encrypts the client identity bundle and device secrets into AES-256-GCM ciphertext.
 * 3. Uploads the ciphertext, salt, and KDF metadata to /auth/backup.
 * The server never sees the passphrase or plaintext keys.
 */

export interface BackupPayload {
  user_id?: string
  backup_ciphertext: string // Base64
  kdf_salt: string // Base64
  kdf_algorithm: string // 'pbkdf2_aes256gcm'
  kdf_params: {
    iterations: number
    hash: string
    keyLength: number
  }
  bundle_version: number
  updated_at?: string
}

export interface StoredIdentityBundle {
  identity_key_ed25519_pub_hex: string
  identity_key_ed25519_priv_hex: string
  identity_key_x25519_pub_hex?: string
  identity_key_x25519_priv_hex?: string
  signed_pre_key?: unknown
  pq_pre_key?: unknown
  account_data?: Record<string, unknown>
}

function bufferToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToBuffer(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * Derives an AES-256-GCM key from a passphrase and salt using PBKDF2.
 */
export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations = 600000
): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  )

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Encrypts an identity key bundle into a backup payload.
 */
export async function createEncryptedBackup(
  bundle: StoredIdentityBundle,
  passphrase: string
): Promise<BackupPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const key = await deriveKeyFromPassphrase(passphrase, salt)
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle))

  const ciphertextWithTag = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    plaintext
  )

  // Prepend 12-byte IV to ciphertext
  const combined = new Uint8Array(iv.byteLength + ciphertextWithTag.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertextWithTag), iv.byteLength)

  return {
    backup_ciphertext: bufferToBase64(combined),
    kdf_salt: bufferToBase64(salt),
    kdf_algorithm: 'pbkdf2_aes256gcm',
    kdf_params: {
      iterations: 600000,
      hash: 'SHA-256',
      keyLength: 256,
    },
    bundle_version: 1,
  }
}

/**
 * Decrypts a backup payload with the user's passphrase.
 */
export async function restoreEncryptedBackup(
  payload: BackupPayload,
  passphrase: string
): Promise<StoredIdentityBundle> {
  const salt = base64ToBuffer(payload.kdf_salt)
  const combined = base64ToBuffer(payload.backup_ciphertext)

  if (combined.byteLength < 13) {
    throw new Error('Invalid backup payload: ciphertext too short')
  }

  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)

  const iterations = payload.kdf_params?.iterations || 600000
  const key = await deriveKeyFromPassphrase(passphrase, salt, iterations)

  let decrypted: ArrayBuffer
  try {
    decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
      },
      key,
      ciphertext as BufferSource
    )
  } catch {
    throw new Error('Incorrect passphrase or corrupted backup ciphertext')
  }

  const jsonStr = new TextDecoder().decode(decrypted)
  return JSON.parse(jsonStr) as StoredIdentityBundle
}

/**
 * Uploads encrypted backup to the auth service.
 */
export async function uploadKeyBackup(
  token: string,
  payload: BackupPayload,
  apiBase = ''
): Promise<void> {
  const resp = await fetch(`${apiBase}/auth/backup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Failed to upload key backup: ${resp.status} ${text}`)
  }
}

/**
 * Fetches encrypted backup from the auth service.
 */
export async function fetchKeyBackup(
  token: string,
  apiBase = ''
): Promise<BackupPayload | null> {
  const resp = await fetch(`${apiBase}/auth/backup`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (resp.status === 404) {
    return null
  }

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Failed to fetch key backup: ${resp.status} ${text}`)
  }

  return (await resp.json()) as BackupPayload
}

/**
 * Deletes key backup from the auth service.
 */
export async function deleteKeyBackup(token: string, apiBase = ''): Promise<void> {
  const resp = await fetch(`${apiBase}/auth/backup`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Failed to delete key backup: ${resp.status} ${text}`)
  }
}
