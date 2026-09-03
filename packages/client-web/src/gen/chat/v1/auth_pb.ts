// @generated from protobuf file chat/v1/auth.proto
// Hand-written Connect-ES compatible stubs matching proto/chat/v1/auth.proto

export interface BeginRegistrationRequest {
  displayName: string
}

export interface BeginRegistrationResponse {
  optionsJson: Uint8Array
  sessionId: string
}

export interface FinishRegistrationRequest {
  sessionId: string
  credentialJson: Uint8Array
  identityKey: Uint8Array
  deviceLabel: string
}

export interface FinishRegistrationResponse {
  userId: string
  deviceId: string
  accessToken: string
  refreshToken: string
}

export interface BeginLoginRequest {
  userId: string
}

export interface BeginLoginResponse {
  optionsJson: Uint8Array
  sessionId: string
}

export interface FinishLoginRequest {
  sessionId: string
  credentialJson: Uint8Array
}

export interface FinishLoginResponse {
  userId: string
  deviceId: string
  accessToken: string
  refreshToken: string
}

export interface RefreshTokenRequest {
  refreshToken: string
}

export interface RefreshTokenResponse {
  accessToken: string
  refreshToken: string
}
