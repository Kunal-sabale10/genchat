import {
  IdentityKeyBundle,
  PublicPreKeyBundle,
  PqxdhInitMessage,
  HandshakeInitResult,
  EncryptedMessagePayload,
  DecryptedMessagePayload,
} from "./types.js";

// Interface for WebAssembly module functions
interface WasmExports {
  generate_pqxdh_keys(count: number): { identity_bundle: IdentityKeyBundle; public_bundle: PublicPreKeyBundle };
  initiate_pqxdh_handshake(alice: any, bob: any): HandshakeInitResult;
  receive_pqxdh_handshake(bob: any, initMsg: any): string;
  create_ratchet_account(pickleKeyHex: string): string;
  encrypt_message(sessionPickle: string, pickleKeyHex: string, plaintext: Uint8Array): EncryptedMessagePayload;
  decrypt_message(sessionPickle: string, pickleKeyHex: string, messageType: number, ciphertextBase64: string): DecryptedMessagePayload;
  sframe_encrypt(participantKeyId: bigint, baseSecretHex: string, framePayload: Uint8Array): Uint8Array;
  sframe_decrypt(participantKeyId: bigint, baseSecretHex: string, encryptedFrame: Uint8Array): Uint8Array;
}

export class GenChatCrypto {
  private wasm: WasmExports | null = null;

  constructor(wasmModule?: WasmExports) {
    if (wasmModule) {
      this.wasm = wasmModule;
    }
  }

  /**
   * Set or initialize the WebAssembly module instance
   */
  public setWasm(wasm: WasmExports): void {
    this.wasm = wasm;
  }

  private ensureWasm(): WasmExports {
    if (!this.wasm) {
      throw new Error(
        "GenChatCrypto WebAssembly core not initialized. Call init() or pass Wasm exports to constructor."
      );
    }
    return this.wasm;
  }

  /**
   * 1. Generate local PQXDH key bundle (Identity, Signed Pre-Key, Post-Quantum ML-KEM-768 Pre-Key, and OTKs)
   */
  public generatePqxdhKeys(oneTimeKeysCount: number = 20): {
    identityBundle: IdentityKeyBundle;
    publicBundle: PublicPreKeyBundle;
  } {
    const wasm = this.ensureWasm();
    const res = wasm.generate_pqxdh_keys(oneTimeKeysCount);
    return {
      identityBundle: res.identity_bundle,
      publicBundle: res.public_bundle,
    };
  }

  /**
   * 2. Initiate PQXDH Handshake with Bob's public PreKeyBundle (Alice -> Bob)
   */
  public initiatePqxdhHandshake(
    aliceIdentity: IdentityKeyBundle,
    bobPublicBundle: PublicPreKeyBundle
  ): HandshakeInitResult {
    const wasm = this.ensureWasm();
    return wasm.initiate_pqxdh_handshake(aliceIdentity, bobPublicBundle);
  }

  /**
   * 3. Process incoming PQXDH Handshake (Bob <- Alice)
   */
  public receivePqxdhHandshake(
    bobIdentity: IdentityKeyBundle,
    aliceInitMsg: PqxdhInitMessage
  ): string {
    const wasm = this.ensureWasm();
    return wasm.receive_pqxdh_handshake(bobIdentity, aliceInitMsg);
  }

  /**
   * 4. Encrypt message payload using Double Ratchet session state
   */
  public encryptMessage(
    sessionPickle: string,
    pickleKeyHex: string,
    plaintext: string | Uint8Array
  ): EncryptedMessagePayload {
    const wasm = this.ensureWasm();
    const bytes = typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext;
    return wasm.encrypt_message(sessionPickle, pickleKeyHex, bytes);
  }

  /**
   * 5. Decrypt message payload using Double Ratchet session state
   */
  public decryptMessage(
    sessionPickle: string,
    pickleKeyHex: string,
    messageType: number,
    ciphertextBase64: string
  ): DecryptedMessagePayload {
    const wasm = this.ensureWasm();
    return wasm.decrypt_message(sessionPickle, pickleKeyHex, messageType, ciphertextBase64);
  }

  /**
   * 6. WebRTC Insertable Streams SFrame frame encryption
   */
  public sframeEncrypt(
    participantKeyId: bigint,
    baseSecretHex: string,
    framePayload: Uint8Array
  ): Uint8Array {
    const wasm = this.ensureWasm();
    return wasm.sframe_encrypt(participantKeyId, baseSecretHex, framePayload);
  }

  /**
   * 7. WebRTC Insertable Streams SFrame frame decryption
   */
  public sframeDecrypt(
    participantKeyId: bigint,
    baseSecretHex: string,
    encryptedFrame: Uint8Array
  ): Uint8Array {
    const wasm = this.ensureWasm();
    return wasm.sframe_decrypt(participantKeyId, baseSecretHex, encryptedFrame);
  }
}
