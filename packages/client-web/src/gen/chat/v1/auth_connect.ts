/// <reference types="vite/client" />
// @generated Connect-ES compatible AuthService client
// Wraps gRPC-Web calls to Envoy -> authd

import type {
  BeginRegistrationRequest,
  BeginRegistrationResponse,
  FinishRegistrationRequest,
  FinishRegistrationResponse,
  BeginLoginRequest,
  BeginLoginResponse,
  FinishLoginRequest,
  FinishLoginResponse,
  RefreshTokenRequest,
  RefreshTokenResponse,
} from './auth_pb'

export interface UserSummary {
  userId: string
  displayName: string
  avatarUrl?: string
  createdAt: string
  isSelf: boolean
}

export interface ListUsersResponse {
  users: UserSummary[]
}

export interface UserProfileResponse {
  userId: string
  displayName: string
  avatarUrl: string
  createdAt: string
}

export interface UpdateProfileRequest {
  displayName?: string
  avatarUrl?: string
}

const BASE_URL = import.meta.env.VITE_AUTH_URL || ''

async function grpcUnary<TReq, TRes>(service: string, method: string, request: TReq, token?: string): Promise<TRes> {
  const body = JSON.stringify(request)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const res = await fetch(`${BASE_URL}/${service}/${method}`, {
    method: 'POST',
    headers,
    body,
  })
  if (!res.ok) {
    const errorText = await res.text()
    throw new Error(`gRPC error (${res.status}): ${errorText}`)
  }
  return (await res.json()) as TRes
}

export const AuthService = {
  beginRegistration(req: BeginRegistrationRequest): Promise<BeginRegistrationResponse> {
    return grpcUnary('chat.v1.AuthService', 'BeginRegistration', req)
  },
  finishRegistration(req: FinishRegistrationRequest): Promise<FinishRegistrationResponse> {
    return grpcUnary('chat.v1.AuthService', 'FinishRegistration', req)
  },
  beginLogin(req: BeginLoginRequest): Promise<BeginLoginResponse> {
    return grpcUnary('chat.v1.AuthService', 'BeginLogin', req)
  },
  finishLogin(req: FinishLoginRequest): Promise<FinishLoginResponse> {
    return grpcUnary('chat.v1.AuthService', 'FinishLogin', req)
  },
  refreshToken(req: RefreshTokenRequest): Promise<RefreshTokenResponse> {
    return grpcUnary('chat.v1.AuthService', 'RefreshToken', req)
  },
  listUsers(token?: string): Promise<ListUsersResponse> {
    return grpcUnary('chat.v1.AuthService', 'ListUsers', {}, token)
  },
  getProfile(token: string): Promise<UserProfileResponse> {
    return grpcUnary('chat.v1.AuthService', 'GetProfile', {}, token)
  },
  updateProfile(req: UpdateProfileRequest, token: string): Promise<UserProfileResponse> {
    return grpcUnary('chat.v1.AuthService', 'UpdateProfile', req, token)
  },
}

