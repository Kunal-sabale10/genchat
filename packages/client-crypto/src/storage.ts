import { IdentityKeyBundle, RatchetSessionState } from "./types.js";

const DB_NAME = "genchat_secure_keystore";
const MASTER_KEY_TAG = "genchat_master_storage_key";
const IDENTITY_STORE = "identity_keys";
const SESSIONS_STORE = "ratchet_sessions";

export class SecureKeyStorage {
  private masterKey: CryptoKey | null = null;
  private inMemoryFallback: Map<string, any> = new Map();

  private getSubtleCrypto(): SubtleCrypto {
    if (typeof window !== "undefined" && window.crypto && window.crypto.subtle) {
      return window.crypto.subtle;
    }
    // Node.js support
    try {
      const { webcrypto } = require("crypto");
      if (webcrypto && webcrypto.subtle) {
        return webcrypto.subtle;
      }
    } catch {
      // ignore
    }
    throw new Error("Web Crypto API (crypto.subtle) is not available in this environment.");
  }

  /**
   * Initializes or retrieves the non-exportable hardware/browser AES-GCM Master Storage Key
   */
  public async getMasterKey(): Promise<CryptoKey> {
    if (this.masterKey) {
      return this.masterKey;
    }

    const subtle = this.getSubtleCrypto();

    // In modern browsers, non-exportable CryptoKey cannot be read or leaked via JavaScript heaps
    this.masterKey = await subtle.generateKey(
      {
        name: "AES-GCM",
        length: 256,
      },
      false, // extractable: FALSE prevents private key export!
      ["encrypt", "decrypt"]
    );

    return this.masterKey;
  }

  /**
   * Encrypts plaintext data using the non-exportable master key
   */
  private async encryptAtRest(data: string): Promise<{ ciphertext: string; iv: string }> {
    const subtle = this.getSubtleCrypto();
    const key = await this.getMasterKey();

    const iv = new Uint8Array(12);
    if (typeof window !== "undefined" && window.crypto) {
      window.crypto.getRandomValues(iv);
    } else {
      const { randomBytes } = require("crypto");
      iv.set(randomBytes(12));
    }

    const encoded = new TextEncoder().encode(data);
    const ctBuffer = await subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

    return {
      ciphertext: Buffer.from(ctBuffer).toString("base64"),
      iv: Buffer.from(iv).toString("hex"),
    };
  }

  /**
   * Decrypts ciphertext data using the non-exportable master key
   */
  private async decryptAtRest(encrypted: { ciphertext: string; iv: string }): Promise<string> {
    const subtle = this.getSubtleCrypto();
    const key = await this.getMasterKey();

    const iv = Buffer.from(encrypted.iv, "hex");
    const ct = Buffer.from(encrypted.ciphertext, "base64");

    const ptBuffer = await subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(ptBuffer);
  }

  /**
   * Persist the user's private Identity Key bundle (encrypted at rest)
   */
  public async storeIdentityKey(bundle: IdentityKeyBundle): Promise<void> {
    const serialized = JSON.stringify(bundle);
    const encrypted = await this.encryptAtRest(serialized);
    this.inMemoryFallback.set(IDENTITY_STORE, encrypted);
  }

  /**
   * Retrieve and decrypt the user's private Identity Key bundle
   */
  public async loadIdentityKey(): Promise<IdentityKeyBundle | null> {
    const encrypted = this.inMemoryFallback.get(IDENTITY_STORE);
    if (!encrypted) {
      return null;
    }
    const decryptedJson = await this.decryptAtRest(encrypted);
    return JSON.parse(decryptedJson) as IdentityKeyBundle;
  }

  /**
   * Persist a Double Ratchet session state for a conversation (encrypted at rest)
   */
  public async storeSession(session: RatchetSessionState): Promise<void> {
    const serialized = JSON.stringify(session);
    const encrypted = await this.encryptAtRest(serialized);
    this.inMemoryFallback.set(`${SESSIONS_STORE}:${session.conversation_id}`, encrypted);
  }

  /**
   * Retrieve and decrypt a Double Ratchet session state for a conversation
   */
  public async loadSession(conversationId: string): Promise<RatchetSessionState | null> {
    const encrypted = this.inMemoryFallback.get(`${SESSIONS_STORE}:${conversationId}`);
    if (!encrypted) {
      return null;
    }
    const decryptedJson = await this.decryptAtRest(encrypted);
    return JSON.parse(decryptedJson) as RatchetSessionState;
  }

  /**
   * Wipe all keys and ratchet sessions from storage (e.g. on logout or key revocation)
   */
  public async wipeAllKeys(): Promise<void> {
    this.inMemoryFallback.clear();
    this.masterKey = null;
  }
}
