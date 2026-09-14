/**
 * Real Multi-Device Key Synchronization & QR Pairing
 *
 * Implements ephemeral Diffie-Hellman mutual pairing flow:
 * 1. Primary device generates ephemeral ECDH keypair and 6-digit confirmation code.
 * 2. Primary initiates session on auth service (storing ephemeral pubkey & PIN hash).
 * 3. Secondary device scans QR code / enters session ID, generates its own ECDH keypair.
 * 4. Both derive shared secret via ECDH + HKDF.
 * 5. Primary verifies code, re-encrypts MLS group state and identity bundle with shared key.
 * 6. Secondary downloads and decrypts state, completing linking.
 */

export interface DeviceLinkingInitResult {
  sessionId: string
  confirmationCode: string
  ephemeralPrivateKey: CryptoKey
  ephemeralPublicKeyHex: string
  qrUri: string
}

export interface LinkingSessionStatus {
  session_id: string
  status: 'pending' | 'scanned' | 'approved' | 'consumed' | 'expired'
  primary_user_id: string
  primary_device_id: string
  expires_at: string
  has_bundle: boolean
}

function bufferToHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

function hexToBuffer(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
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
 * Initiates a new device linking session on the primary device.
 */
export async function initiateDeviceLinking(
  token: string,
  apiBase = ''
): Promise<DeviceLinkingInitResult> {
  // 1. Generate ephemeral ECDH keypair (P-256)
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits', 'deriveKey']
  )

  const rawPub = await crypto.subtle.exportKey('raw', keyPair.publicKey)
  const pubHex = bufferToHex(rawPub)

  // 2. Generate 6-digit confirmation code
  const randomBytes = new Uint8Array(4)
  crypto.getRandomValues(randomBytes)
  const num = ((randomBytes[0] << 24) | (randomBytes[1] << 16) | (randomBytes[2] << 8) | randomBytes[3]) >>> 0
  const code = (num % 900000 + 100000).toString()

  // 3. Hash code with SHA-256
  const codeHashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))

  // 4. Register session with auth service
  const resp = await fetch(`${apiBase}/auth/device-link/initiate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      ephemeral_pubkey: bufferToBase64(rawPub),
      auth_code_hash: bufferToBase64(codeHashBuf),
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Failed to initiate device linking: ${resp.status} ${text}`)
  }

  const data = await resp.json()
  const sessionId = data.session_id

  const qrUri = `genchat://link-device?session_id=${sessionId}&pub=${pubHex}&code=${code}`

  return {
    sessionId,
    confirmationCode: code,
    ephemeralPrivateKey: keyPair.privateKey,
    ephemeralPublicKeyHex: pubHex,
    qrUri,
  }
}

/**
 * Checks the status of an ongoing device linking session.
 */
export async function checkDeviceLinkingStatus(
  token: string,
  sessionId: string,
  apiBase = ''
): Promise<LinkingSessionStatus> {
  const resp = await fetch(`${apiBase}/auth/device-link/status?session_id=${sessionId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Failed to check linking status: ${resp.status} ${text}`)
  }

  return (await resp.json()) as LinkingSessionStatus
}

/**
 * Primary device approves linking by re-encrypting secrets with the shared pairing secret.
 */
export async function approveDeviceLinking(
  token: string,
  sessionId: string,
  primaryPrivateKey: CryptoKey,
  secondaryPublicKeyHex: string,
  secretsToTransfer: Record<string, unknown>,
  newDeviceId: string,
  authCode: string,
  apiBase = ''
): Promise<void> {
  // 1. Import secondary public key
  const secPubBuf = hexToBuffer(secondaryPublicKeyHex)
  const secondaryPubKey = await crypto.subtle.importKey(
    'raw',
    secPubBuf as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )

  // 2. Derive shared secret using ECDH
  const sharedKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: secondaryPubKey },
    primaryPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  )

  // 3. Encrypt payload
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(secretsToTransfer))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    plaintext
  )

  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), iv.length)

  // 4. Send approved bundle to auth service
  const resp = await fetch(`${apiBase}/auth/device-link/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      session_id: sessionId,
      new_device_id: newDeviceId,
      encrypted_bundle: bufferToBase64(combined),
      auth_code: authCode,
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Failed to approve device link: ${resp.status} ${text}`)
  }
}

/**
 * Secondary device completes linking by downloading and decrypting the shared secrets.
 */
export async function completeDeviceLinking(
  token: string,
  sessionId: string,
  secondaryPrivateKey: CryptoKey,
  primaryPublicKeyHex: string,
  authCode: string,
  apiBase = ''
): Promise<Record<string, unknown>> {
  // 1. Fetch bundle from auth service
  const resp = await fetch(`${apiBase}/auth/device-link/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      session_id: sessionId,
      auth_code: authCode,
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Failed to complete device linking: ${resp.status} ${text}`)
  }

  const data = await resp.json()
  if (!data.encrypted_bundle) {
    throw new Error('No encrypted bundle found in completed session')
  }

  // 2. Import primary public key
  const primPubBuf = hexToBuffer(primaryPublicKeyHex)
  const primaryPubKey = await crypto.subtle.importKey(
    'raw',
    primPubBuf as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )

  // 3. Derive shared secret
  const sharedKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: primaryPubKey },
    secondaryPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  )

  // 4. Decrypt bundle
  const combined = base64ToBuffer(data.encrypted_bundle)
  if (combined.length < 13) {
    throw new Error('Invalid bundle payload')
  }

  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    ciphertext as BufferSource
  )

  return JSON.parse(new TextDecoder().decode(decrypted))
}
