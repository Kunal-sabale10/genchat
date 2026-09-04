/**
 * E2EE Media Upload
 *
 * Encrypts a file in-browser with AES-256-GCM before upload to MinIO.
 * The wrapped key travels inside the Double Ratchet envelope — the server
 * never sees the plaintext or the symmetric key.
 */

export interface MediaEnvelope {
  /** MinIO object URL (points to ciphertext blob) */
  blobUrl: string
  /** AES-256-GCM key wrapped as base64 (recipient decrypts with their session key) */
  wrappedKeyBase64: string
  /** 12-byte IV as base64 */
  ivBase64: string
  /** Original filename */
  filename: string
  /** MIME type of the original file */
  mimeType: string
  /** File size in bytes (of plaintext) */
  size: number
}

const MEDIA_SERVICE_URL = import.meta.env.DEV
  ? 'http://localhost:8082'
  : ''

/** Generate an ephemeral AES-256-GCM key for one upload */
async function generateMediaKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable so we can export and wrap it
    ['encrypt', 'decrypt']
  )
}

/** Encrypt file bytes with the ephemeral key, return ciphertext + IV */
async function encryptFile(
  key: CryptoKey,
  file: File
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = await file.arrayBuffer()
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  )
  return { ciphertext, iv }
}

/** Export and base64-encode the raw AES key bytes */
async function exportKeyBase64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key)
  return btoa(String.fromCharCode(...new Uint8Array(raw)))
}

/** Upload encrypted blob to MinIO via mediad presigned PUT */
async function uploadBlob(
  ciphertext: ArrayBuffer,
  objectKey: string
): Promise<string> {
  // 1. Get presigned PUT URL from mediad
  const presignRes = await fetch(
    `${MEDIA_SERVICE_URL}/presign?object_key=${encodeURIComponent(objectKey)}`,
    { method: 'GET' }
  )
  if (!presignRes.ok) {
    throw new Error(`[media-upload] presign failed: ${presignRes.status}`)
  }
  const { url: presignedUrl, public_url: publicUrl } = await presignRes.json() as {
    url: string
    public_url: string
  }

  // 2. PUT encrypted blob directly to MinIO (no server middleware)
  const putRes = await fetch(presignedUrl, {
    method: 'PUT',
    body: ciphertext,
    headers: { 'Content-Type': 'application/octet-stream' },
  })
  if (!putRes.ok) {
    throw new Error(`[media-upload] PUT to MinIO failed: ${putRes.status}`)
  }

  return publicUrl
}

/**
 * Main export: encrypt and upload a file, return the MediaEnvelope
 * to be embedded in the outgoing chat message body.
 */
export async function uploadEncryptedMedia(file: File): Promise<MediaEnvelope> {
  const key = await generateMediaKey()
  const { ciphertext, iv } = await encryptFile(key, file)
  const wrappedKeyBase64 = await exportKeyBase64(key)

  // Object key: deterministic UUID-like identifier
  const objectKey = `media/${Date.now()}-${Math.random().toString(36).slice(2)}`
  const blobUrl = await uploadBlob(ciphertext, objectKey)

  return {
    blobUrl,
    wrappedKeyBase64,
    ivBase64: btoa(String.fromCharCode(...iv)),
    filename: file.name,
    mimeType: file.type,
    size: file.size,
  }
}

/**
 * Decrypt a received MediaEnvelope and return the plaintext Blob.
 * Call this when rendering an attachment that the current user received.
 */
export async function decryptMediaBlob(envelope: MediaEnvelope): Promise<Blob> {
  // 1. Re-import the raw AES key
  const rawKey = Uint8Array.from(atob(envelope.wrappedKeyBase64), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  )

  // 2. Fetch encrypted blob from MinIO
  const res = await fetch(envelope.blobUrl)
  if (!res.ok) throw new Error(`[media-upload] fetch blob failed: ${res.status}`)
  const ciphertext = await res.arrayBuffer()

  // 3. Decrypt
  const iv = Uint8Array.from(atob(envelope.ivBase64), (c) => c.charCodeAt(0))
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)

  return new Blob([plaintext], { type: envelope.mimeType })
}
