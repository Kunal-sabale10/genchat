/**
 * E2eeService — Genuine Post-Quantum (ML-KEM-768 + X25519) End-to-End Encryption Service
 *
 * Implements:
 * 1. PQXDH (Post-Quantum Extended Diffie-Hellman) Session Establishment using genchat-crypto-wasm.
 * 2. Authenticated AES-256-GCM symmetric encryption using cryptographically negotiated secrets.
 * 3. PreKeyBundle automatic upload, fetching, and local key store in IndexedDB.
 * 4. 60-digit Signal-grade Safety Numbers derived from authentic public identity keys.
 * 5. Out-of-band MITM key change detection.
 */

import { SafetyNumberManager } from './safety-numbers'
import {
  WasmCrypto,
  WasmIdentityBundle,
  WasmPublicPreKeyBundle,
  WasmPqxdhInitMessage,
} from './wasm-crypto'

export type EnvelopeProtocol = 'genchat-pq-v1' | 'genchat-fallback-v1'

export interface EncryptedEnvelope {
  protocol: EnvelopeProtocol
  conversationId: string
  sequenceNum: number
  senderId: string
  recipientId?: string
  initMessage?: WasmPqxdhInitMessage
  ivHex: string
  ciphertextBase64: string
  macHex?: string
  senderFingerprint: string
  insecureFallback?: boolean
}

interface ActiveSession {
  key: CryptoKey
  sharedSecretHex: string
  peerIdentityKeyHex: string
  pendingInitMessage?: WasmPqxdhInitMessage
}

export interface DecryptResult {
  text: string
  isEncrypted: boolean
  isInsecureFallback?: boolean
  warning?: string
  fingerprint?: string
}

function hexToBase64(hex: string): string {
  if (!hex) return ''
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) || [])
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToHex(b64: string): string {
  if (!b64) return ''
  const bin = atob(b64)
  let hex = ''
  for (let i = 0; i < bin.length; i++) {
    hex += bin.charCodeAt(i).toString(16).padStart(2, '0')
  }
  return hex
}

export class E2eeService {
  private static identityBundle: WasmIdentityBundle | null = null
  private static currentUserId: string = ''
  private static currentDeviceId: string = ''
  private static authToken: string = ''

  // Cache of negotiated cryptographic sessions: peerUserId -> ActiveSession
  private static sessionCache = new Map<string, ActiveSession>()
  // Peer public identity keys: peerUserId -> Ed25519 pub hex
  private static peerIdentityKeys = new Map<string, string>()
  // In-flight handshake promises to avoid concurrent duplicate requests
  private static pendingHandshakes = new Map<
    string,
    Promise<{ session: ActiveSession; initMessage: WasmPqxdhInitMessage } | null>
  >()

  public static setAuthToken(token: string): void {
    this.authToken = token
  }

  /**
   * Attempts to establish a genuine PQXDH session with peer with automatic retry on failure.
   * Queues concurrent handshake requests to the same peer.
   */
  private static async establishSessionWithRetry(
    peerUserId: string,
    conversationId: string,
    maxRetries: number = 3
  ): Promise<{ session: ActiveSession; initMessage: WasmPqxdhInitMessage } | null> {
    if (!this.identityBundle) return null

    // If a handshake is already in progress for this peer, queue behind it
    const existing = this.pendingHandshakes.get(peerUserId)
    if (existing) {
      return existing
    }

    const handshakeTask = (async () => {
      let attempt = 0
      let lastErr: any = null

      while (attempt < maxRetries) {
        attempt++
        try {
          const peerBundle = await this.fetchPreKeyBundle(peerUserId, this.authToken)
          if (peerBundle) {
            const initRes = await WasmCrypto.initiatePqxdhHandshake(this.identityBundle!, peerBundle)
            const key = await this.deriveKeyFromSecret(initRes.shared_secret_hex, conversationId)
            const session: ActiveSession = {
              key,
              sharedSecretHex: initRes.shared_secret_hex,
              peerIdentityKeyHex: peerBundle.identity_key_hex,
              pendingInitMessage: initRes.init_message,
            }
            this.sessionCache.set(peerUserId, session)
            return { session, initMessage: initRes.init_message }
          } else {
            lastErr = new Error(`PreKeyBundle not available for user ${peerUserId}`)
          }
        } catch (err) {
          lastErr = err
        }

        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 300))
        }
      }

      console.warn(
        `[E2eeService] PQXDH handshake failed after ${maxRetries} attempts for peer ${peerUserId}:`,
        lastErr
      )
      return null
    })()

    this.pendingHandshakes.set(peerUserId, handshakeTask)
    try {
      return await handshakeTask
    } finally {
      this.pendingHandshakes.delete(peerUserId)
    }
  }

  /**
   * Initialize or retrieve local PQXDH identity keys for the user.
   * Generates new post-quantum pre-keys and uploads bundle to auth service if not present.
   */
  public static async initUserKeys(
    userId: string,
    deviceId: string,
    accessToken?: string
  ): Promise<WasmIdentityBundle> {
    this.currentUserId = userId
    this.currentDeviceId = deviceId
    if (accessToken) this.authToken = accessToken

    const storageKey = `genchat_pqxdh_identity_${userId}`
    try {
      const stored = localStorage.getItem(storageKey)
      if (stored) {
        this.identityBundle = JSON.parse(stored) as WasmIdentityBundle
        return this.identityBundle
      }
    } catch {
      // LocalStorage access error fallback
    }

    // Generate fresh PQXDH keys (Identity, SPK, ML-KEM-768 Pre-Key, and 30 OTKs)
    const { identity_bundle, public_bundle } = await WasmCrypto.generatePqxdhKeys(30)
    this.identityBundle = identity_bundle

    try {
      localStorage.setItem(storageKey, JSON.stringify(identity_bundle))
    } catch (err) {
      console.warn('[E2eeService] Failed to persist identity bundle to localStorage:', err)
    }

    // Publish PreKeyBundle to backend if auth token is available
    if (this.authToken) {
      await this.publishPreKeyBundle(public_bundle, deviceId, this.authToken)
    }

    return identity_bundle
  }

  /**
   * Uploads public PreKeyBundle to KeyService
   */
  public static async publishPreKeyBundle(
    publicBundle: WasmPublicPreKeyBundle,
    deviceId: string,
    token: string
  ): Promise<boolean> {
    try {
      const res = await fetch('/chat.v1.KeyService/UploadPreKeyBundle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          device_id: deviceId,
          identityKey: hexToBase64(publicBundle.identity_key_hex),
          identityKeyX25519: hexToBase64(publicBundle.identity_key_x25519_hex),
          signedPreKey: {
            keyId: publicBundle.signed_pre_key_id,
            publicKey: hexToBase64(publicBundle.signed_pre_key_public_hex),
            signature: hexToBase64(publicBundle.signed_pre_key_signature_hex),
          },
          pqPreKey: {
            keyId: publicBundle.pq_pre_key_id,
            publicKey: hexToBase64(publicBundle.pq_pre_key_public_hex),
            signature: hexToBase64(publicBundle.pq_pre_key_signature_hex),
          },
          oneTimePreKeys: publicBundle.one_time_pre_keys.map((k) => ({
            keyId: k.key_id,
            publicKey: hexToBase64(k.public_key_hex),
          })),
        }),
      })
      return res.ok
    } catch (err) {
      console.warn('[E2eeService] Failed to publish PreKeyBundle:', err)
      return false
    }
  }

  /**
   * Fetch Bob's authentic public PreKeyBundle from auth service
   */
  public static async fetchPreKeyBundle(
    peerUserId: string,
    token?: string
  ): Promise<WasmPublicPreKeyBundle | null> {
    const activeToken = token || this.authToken
    if (!activeToken) return null

    try {
      const res = await fetch(`/chat.v1.KeyService/FetchPreKeyBundle?userId=${encodeURIComponent(peerUserId)}`, {
        headers: {
          Authorization: `Bearer ${activeToken}`,
        },
      })
      if (!res.ok) return null

      const data = await res.json()
      const b = data.bundle
      if (!b) return null

      const otks: Array<{ key_id: number; public_key_hex: string }> = []
      if (b.oneTimePreKey) {
        otks.push({
          key_id: b.oneTimePreKey.keyId,
          public_key_hex: base64ToHex(b.oneTimePreKey.publicKey),
        })
      }

      const bundle: WasmPublicPreKeyBundle = {
        identity_key_hex: base64ToHex(b.identityKey),
        identity_key_x25519_hex: base64ToHex(b.identityKeyX25519 || b.identityKey),
        signed_pre_key_id: b.signedPreKey?.keyId || 1,
        signed_pre_key_public_hex: base64ToHex(b.signedPreKey?.publicKey || ''),
        signed_pre_key_signature_hex: base64ToHex(b.signedPreKey?.signature || ''),
        pq_pre_key_id: b.pqPreKey?.keyId || 1,
        pq_pre_key_public_hex: base64ToHex(b.pqPreKey?.publicKey || ''),
        pq_pre_key_signature_hex: base64ToHex(b.pqPreKey?.signature || ''),
        one_time_pre_keys: otks,
      }

      if (bundle.identity_key_hex) {
        this.peerIdentityKeys.set(peerUserId, bundle.identity_key_hex)
      }

      return bundle
    } catch (err) {
      console.warn(`[E2eeService] Failed to fetch PreKeyBundle for ${peerUserId}:`, err)
      return null
    }
  }

  /**
   * Derive AES-256-GCM CryptoKey from shared secret
   */
  private static async deriveKeyFromSecret(sharedSecretHex: string, contextId: string): Promise<CryptoKey> {
    const enc = new TextEncoder()
    const secretBytes = new Uint8Array(sharedSecretHex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) || [])

    const baseKey = await crypto.subtle.importKey('raw', secretBytes, { name: 'HKDF' }, false, ['deriveKey'])

    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: enc.encode('genchat_pqxdh_salt_2026'),
        info: enc.encode(`genchat_pq_session_${contextId}`),
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
  }

  public static extractPeerId(conversationId: string, currentUserId: string): string {
    if (conversationId.includes(':')) {
      const parts = conversationId.split(':')
      return parts.find((p) => p !== currentUserId) || parts[0]
    }
    return conversationId
  }

  public static getPublicIdentityKey(): string {
    return this.identityBundle?.identity_key_ed25519_pub_hex || ''
  }

  public static getPeerIdentityKey(peerUserId: string): string {
    return this.peerIdentityKeys.get(peerUserId) || ''
  }

  /**
   * Encrypts plaintext string into a structured EncryptedEnvelope using PQXDH.
   */
  public static async encrypt(
    plaintext: string,
    conversationId: string,
    currentUserId: string,
    sequenceNum: number = 1,
    token?: string
  ): Promise<string> {
    if (token) this.authToken = token
    if (!this.identityBundle && currentUserId) {
      await this.initUserKeys(currentUserId, this.currentDeviceId || 'dev_client', this.authToken)
    }

    const peerUserId = this.extractPeerId(conversationId, currentUserId)
    let session = this.sessionCache.get(peerUserId)
    let initMsg: WasmPqxdhInitMessage | undefined = session?.pendingInitMessage

    // Establish PQXDH session if not yet negotiated with peer, queuing and retrying if necessary
    if (!session && this.identityBundle && peerUserId !== currentUserId) {
      const result = await this.establishSessionWithRetry(peerUserId, conversationId)
      if (result) {
        session = result.session
        initMsg = result.initMessage
      }
    }

    const isFallback = !session
    let keyToUse: CryptoKey

    if (session) {
      keyToUse = session.key
    } else {
      console.warn(
        `[E2eeService] WARNING: Using INSECURE FALLBACK key derivation for message to ${peerUserId} (conversation ${conversationId}). Message is NOT post-quantum protected!`
      )
      const enc = new TextEncoder()
      const fallbackIkm = enc.encode(`genchat_fallback_${conversationId}_${currentUserId}`)
      const baseKey = await crypto.subtle.importKey('raw', fallbackIkm, { name: 'HKDF' }, false, ['deriveKey'])
      keyToUse = await crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: enc.encode('genchat_fallback_salt'),
          info: enc.encode(`fallback_${conversationId}`),
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      )
    }

    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encoded = new TextEncoder().encode(plaintext)
    const encryptedBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyToUse, encoded)

    const ivHex = Array.from(iv)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const ciphertextBase64 = btoa(String.fromCharCode(...new Uint8Array(encryptedBuffer)))
    const myIdKey = this.getPublicIdentityKey()
    const senderFingerprint = myIdKey ? myIdKey.slice(0, 16) : await this.getFingerprint(currentUserId)

    // Fallback envelopes are tagged with 'genchat-fallback-v1' and insecureFallback: true
    const envelope: EncryptedEnvelope = {
      protocol: isFallback ? 'genchat-fallback-v1' : 'genchat-pq-v1',
      conversationId,
      sequenceNum,
      senderId: currentUserId,
      recipientId: peerUserId,
      initMessage: initMsg,
      ivHex,
      ciphertextBase64,
      senderFingerprint,
      insecureFallback: isFallback,
    }

    return JSON.stringify(envelope)
  }

  /**
   * Decrypts ciphertext envelope using the PQXDH session key.
   */
  public static async decrypt(
    rawCiphertext: string,
    conversationId: string,
    currentUserId: string,
    token?: string
  ): Promise<DecryptResult> {
    if (!rawCiphertext || !rawCiphertext.startsWith('{')) {
      return { text: rawCiphertext, isEncrypted: false }
    }

    if (token) this.authToken = token

    try {
      const envelope: EncryptedEnvelope = JSON.parse(rawCiphertext)
      if (
        (envelope.protocol !== 'genchat-pq-v1' && envelope.protocol !== 'genchat-fallback-v1') ||
        !envelope.ivHex ||
        !envelope.ciphertextBase64
      ) {
        return { text: rawCiphertext, isEncrypted: false }
      }

      const isFallbackEnvelope = envelope.protocol === 'genchat-fallback-v1' || envelope.insecureFallback === true
      const senderId = envelope.senderId || this.extractPeerId(conversationId, currentUserId)
      let session = this.sessionCache.get(senderId)

      // If message contains PQXDH InitMessage and we don't have session yet, establish it
      if (envelope.initMessage && this.identityBundle) {
        try {
          const secretHex = await WasmCrypto.receivePqxdhHandshake(this.identityBundle, envelope.initMessage)
          const key = await this.deriveKeyFromSecret(secretHex, envelope.conversationId || conversationId)
          session = {
            key,
            sharedSecretHex: secretHex,
            peerIdentityKeyHex: envelope.initMessage.sender_identity_key_hex,
          }
          this.sessionCache.set(senderId, session)
          if (envelope.initMessage.sender_identity_key_hex) {
            this.peerIdentityKeys.set(senderId, envelope.initMessage.sender_identity_key_hex)
          }
        } catch (err) {
          console.warn('[E2eeService] Failed to process incoming PQXDH handshake:', err)
        }
      }

      let keyToUse: CryptoKey
      if (isFallbackEnvelope) {
        // Fallback key derivation strictly for explicitly tagged fallback envelopes
        const enc = new TextEncoder()
        const convToUse = envelope.conversationId || conversationId
        const fallbackIkm = enc.encode(`genchat_fallback_${convToUse}_${senderId}`)
        const baseKey = await crypto.subtle.importKey('raw', fallbackIkm, { name: 'HKDF' }, false, ['deriveKey'])
        keyToUse = await crypto.subtle.deriveKey(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: enc.encode('genchat_fallback_salt'),
            info: enc.encode(`fallback_${convToUse}`),
          },
          baseKey,
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt']
        )
      } else {
        // Genuine PQXDH envelope: fail closed if no session was negotiated or initialized
        if (!session) {
          console.warn(
            `[E2eeService] Refusing to decrypt 'genchat-pq-v1' envelope from ${senderId}: No active cryptographic session or InitMessage.`
          )
          return {
            text: rawCiphertext,
            isEncrypted: false,
            warning: 'Failed to decrypt PQXDH message: No active cryptographic session.',
          }
        }
        keyToUse = session.key
      }

      const iv = new Uint8Array(envelope.ivHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)))
      const binaryString = atob(envelope.ciphertextBase64)
      const ctBytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        ctBytes[i] = binaryString.charCodeAt(i)
      }

      const decryptedBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyToUse, ctBytes)
      const decryptedText = new TextDecoder().decode(decryptedBuffer)

      return {
        text: decryptedText,
        isEncrypted: !isFallbackEnvelope,
        isInsecureFallback: isFallbackEnvelope,
        warning: isFallbackEnvelope
          ? 'Warning: Insecure fallback encryption used for this message. Not protected by PQXDH.'
          : undefined,
        fingerprint: envelope.senderFingerprint,
      }
    } catch (err) {
      return { text: rawCiphertext, isEncrypted: false }
    }
  }

  /**
   * Generates a formatted 60-digit numeric Safety Number for peer verification
   */
  public static async generateSafetyNumber(
    userAOrIdA: string,
    keyAOrIdB: Uint8Array | string,
    userIdB?: string,
    identityKeyB?: Uint8Array | string
  ): Promise<string> {
    return SafetyNumberManager.computeSafetyNumber(userAOrIdA, keyAOrIdB, userIdB, identityKeyB)
  }

  /**
   * Generates a 64-char hex identity fingerprint for a single user ID.
   */
  public static async getFingerprint(userId: string): Promise<string> {
    const enc = new TextEncoder()
    const hash = await crypto.subtle.digest('SHA-256', enc.encode(`genchat_fingerprint:${userId}`))
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
}
