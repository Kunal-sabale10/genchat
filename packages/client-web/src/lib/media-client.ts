import { MediaCryptoService } from './media-crypto';

export interface PresignedUploadResponse {
  upload_url: string;
  blob_id: string;
  download_url: string;
}

export interface AttachmentMetadata {
  blobId: string;
  downloadUrl: string;
  encryptionKeyHex: string;
  ivHex: string;
  mimeType: string;
  originalSize: number;
}

export class MediaClient {
  constructor(private mediadBaseUrl: string = 'http://localhost:8082') {}

  public async uploadEncryptedAttachment(file: File): Promise<AttachmentMetadata> {
    // 1. Client-side encrypt
    const encrypted = await MediaCryptoService.encryptFile(file);

    // 2. Request presigned URL from mediad
    const res = await fetch(`${this.mediadBaseUrl}/v1/media/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'application/octet-stream',
        byte_size: encrypted.ciphertextBlob.size,
      }),
    });

    if (!res.ok) {
      throw new Error(`mediad upload-url request failed: ${res.statusText}`);
    }

    const presigned: PresignedUploadResponse = await res.json();

    // 3. Directly PUT the ciphertext blob to MinIO
    const uploadRes = await fetch(presigned.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encrypted.ciphertextBlob,
    });

    if (!uploadRes.ok) {
      throw new Error(`MinIO upload failed: ${uploadRes.statusText}`);
    }

    return {
      blobId: presigned.blob_id,
      downloadUrl: presigned.download_url,
      encryptionKeyHex: encrypted.encryptionKeyHex,
      ivHex: encrypted.ivHex,
      mimeType: encrypted.mimeType,
      originalSize: encrypted.originalSize,
    };
  }
}
