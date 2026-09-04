export interface EncryptedMediaPayload {
  ciphertextBlob: Blob;
  encryptionKeyHex: string;
  ivHex: string;
  mimeType: string;
  originalSize: number;
}

export class MediaCryptoService {
  /**
   * Generates an ephemeral AES-256-GCM key and encrypts raw file bytes
   */
  public static async encryptFile(file: File): Promise<EncryptedMediaPayload> {
    const key = await window.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const fileBuffer = await file.arrayBuffer();

    const encryptedBuffer = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      fileBuffer
    );

    const exportedRawKey = await window.crypto.subtle.exportKey('raw', key);
    const keyHex = Array.from(new Uint8Array(exportedRawKey))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const ivHex = Array.from(iv)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    return {
      ciphertextBlob: new Blob([encryptedBuffer], { type: 'application/octet-stream' }),
      encryptionKeyHex: keyHex,
      ivHex,
      mimeType: file.type,
      originalSize: file.size,
    };
  }

  /**
   * Decrypts an encrypted blob fetched from MinIO using the ratchet-delivered key
   */
  public static async decryptFile(
    ciphertextBuffer: ArrayBuffer,
    keyHex: string,
    ivHex: string,
    mimeType: string
  ): Promise<string> {
    const keyBytes = new Uint8Array(
      keyHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
    );
    const ivBytes = new Uint8Array(
      ivHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
    );

    const key = await window.crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes },
      key,
      ciphertextBuffer
    );

    const blob = new Blob([decryptedBuffer], { type: mimeType });
    return URL.createObjectURL(blob);
  }
}
