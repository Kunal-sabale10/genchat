// @generated from protobuf file chat/v1/media.proto
// Connect-ES compatible stubs matching proto/chat/v1/media.proto

export interface GetUploadUrlRequest {
  contentType: string
  contentLength: number | string
  sha256Hash: string
}

export interface GetUploadUrlResponse {
  objectKey: string
  uploadUrl: string
  expiresAt?: string | number
}

export interface GetDownloadUrlRequest {
  objectKey: string
}

export interface GetDownloadUrlResponse {
  downloadUrl: string
  expiresAt?: string | number
}

export interface EncryptedAttachment {
  objectKey: string
  contentType: string
  fileSize: number | string
  sha256Digest: Uint8Array | string
  mediaKey: Uint8Array | string
  iv: Uint8Array | string
  thumbnailCiphertext?: Uint8Array | string
}
