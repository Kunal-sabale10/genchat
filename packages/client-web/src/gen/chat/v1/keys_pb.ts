// @generated from protobuf file chat/v1/keys.proto
// Connect-ES compatible stubs matching proto/chat/v1/keys.proto

export interface SignedPreKey {
  keyId: number
  publicKey: Uint8Array | string
  signature: Uint8Array | string
}

export interface PqPreKey {
  keyId: number
  publicKey: Uint8Array | string
  signature: Uint8Array | string
}

export interface OneTimePreKey {
  keyId: number
  publicKey: Uint8Array | string
}

export interface PreKeyBundle {
  identityKey: Uint8Array | string
  signedPreKey: SignedPreKey
  pqPreKey: PqPreKey
  oneTimePreKey?: OneTimePreKey
}

export interface UploadPreKeyBundleRequest {
  deviceId: string
  signedPreKey: SignedPreKey
  pqPreKey: PqPreKey
  oneTimePreKeys: OneTimePreKey[]
}

export interface UploadPreKeyBundleResponse {}

export interface FetchPreKeyBundleRequest {
  userId: string
  deviceId?: string
}

export interface FetchPreKeyBundleResponse {
  bundle?: PreKeyBundle
}

export interface GetKeyCountRequest {
  deviceId: string
}

export interface GetKeyCountResponse {
  count: number
}

export interface UploadOneTimeKeysRequest {
  deviceId: string
  oneTimePreKeys: OneTimePreKey[]
}

export interface UploadOneTimeKeysResponse {}

export interface UploadMlsKeyPackageRequest {
  keyPackage: Uint8Array | string
}

export interface UploadMlsKeyPackageResponse {}

export interface FetchMlsKeyPackageRequest {
  userId: string
}

export interface FetchMlsKeyPackageResponse {
  keyPackage: Uint8Array | string
}
