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

const BASE_URL = import.meta.env.DEV ? 'http://localhost:8080' : ''

async function grpcUnary<TReq, TRes>(service: string, method: string, request: TReq): Promise<TRes> {
  const body = JSON.stringify(request)
  const res = await fetch(`${BASE_URL}/${service}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
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
}
