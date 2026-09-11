import { MediaCryptoService } from './media-crypto';

export interface PresignedUploadResponse {
  upload_url: string;
  blob_id?: string;
  object_key?: string;
  download_url?: string;
}

export interface AttachmentMetadata {
  blobId: string;
  downloadUrl: string;
  encryptionKeyHex: string;
  ivHex: string;
  mimeType: string;
  originalSize: number;
  fileName?: string;
  caption?: string;
  isVoiceNote?: boolean;
  durationSec?: number;
  waveform?: number[];
}

export interface UploadAttachmentOptions {
  caption?: string;
  fileName?: string;
  isVoiceNote?: boolean;
  durationSec?: number;
  waveform?: number[];
}

export class MediaClient {
  constructor(private mediadBaseUrl: string = '/media') {}

  private getEndpoint(action: 'upload' | 'download'): string {
    const base = this.mediadBaseUrl.replace(/\/+$/, '');
    if (base.endsWith('/media')) {
      return `${base}/${action}`;
    }
    return `${base}/media/${action}`;
  }

  public async uploadEncryptedAttachment(
    file: File | Blob,
    optionsOrCaption?: UploadAttachmentOptions | string
  ): Promise<AttachmentMetadata> {
    const options: UploadAttachmentOptions =
      typeof optionsOrCaption === 'string'
        ? { caption: optionsOrCaption }
        : optionsOrCaption || {};

    // 1. Client-side encrypt using WebCrypto AES-256-GCM
    const encrypted = await MediaCryptoService.encryptFile(file);

    // 2. Request presigned upload URL from mediad
    const uploadEndpoint = this.getEndpoint('upload');
    const res = await fetch(uploadEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'application/octet-stream',
        content_length: encrypted.ciphertextBlob.size,
        byte_size: encrypted.ciphertextBlob.size,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => res.statusText);
      throw new Error(`Media upload request failed (${res.status}): ${errorText}`);
    }

    const presigned: PresignedUploadResponse = await res.json();
    const blobId = presigned.blob_id || presigned.object_key || '';

    // 3. Directly PUT the ciphertext blob to MinIO using the presigned URL
    const uploadRes = await fetch(presigned.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encrypted.ciphertextBlob,
    });

    if (!uploadRes.ok) {
      throw new Error(`MinIO upload failed (${uploadRes.status}): ${uploadRes.statusText}`);
    }

    // 4. Ensure we have a valid download URL
    let downloadUrl = presigned.download_url;
    if (!downloadUrl && blobId) {
      downloadUrl = await this.getDownloadUrl(blobId);
    }

    const resolvedFileName =
      options.fileName ||
      (file instanceof File ? file.name : options.isVoiceNote ? 'Voice message.webm' : 'attachment');

    return {
      blobId,
      downloadUrl: downloadUrl || '',
      encryptionKeyHex: encrypted.encryptionKeyHex,
      ivHex: encrypted.ivHex,
      mimeType: encrypted.mimeType || file.type || 'application/octet-stream',
      originalSize: encrypted.originalSize,
      fileName: resolvedFileName,
      caption: options.caption,
      isVoiceNote: options.isVoiceNote,
      durationSec: options.durationSec,
      waveform: options.waveform,
    };
  }

  /**
   * Generates or refreshes a presigned download URL for an existing blobId/objectKey
   */
  public async getDownloadUrl(blobId: string): Promise<string> {
    const downloadEndpoint = this.getEndpoint('download');
    const res = await fetch(`${downloadEndpoint}?object_key=${encodeURIComponent(blobId)}`);
    if (!res.ok) {
      throw new Error(`Failed to get download URL (${res.status}): ${res.statusText}`);
    }
    const data = await res.json();
    return data.download_url || '';
  }

  /**
   * Uploads an unencrypted image avatar directly to MinIO for public profile display.
   * Returns the accessible download/view URL.
   */
  public async uploadAvatar(file: File | Blob): Promise<string> {
    const uploadEndpoint = this.getEndpoint('upload');
    const contentType = file.type || 'image/png';
    const res = await fetch(uploadEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: contentType,
        content_length: file.size,
        byte_size: file.size,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => res.statusText);
      throw new Error(`Avatar upload request failed (${res.status}): ${errorText}`);
    }

    const presigned: PresignedUploadResponse = await res.json();
    const blobId = presigned.blob_id || presigned.object_key || '';

    // Upload image raw bytes directly to MinIO presigned URL
    const uploadRes = await fetch(presigned.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: file,
    });

    if (!uploadRes.ok) {
      throw new Error(`MinIO avatar upload failed (${uploadRes.status}): ${uploadRes.statusText}`);
    }

    let downloadUrl = presigned.download_url;
    if (!downloadUrl && blobId) {
      downloadUrl = await this.getDownloadUrl(blobId);
    }

    return downloadUrl || presigned.upload_url.split('?')[0];
  }
}
