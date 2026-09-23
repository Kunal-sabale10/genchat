/// <reference types="vite/client" />
// @generated Connect-ES compatible KeyService client
// Communicates with backend KeyService (authd / envoy)

import type {
  UploadPreKeyBundleRequest,
  UploadPreKeyBundleResponse,
  FetchPreKeyBundleRequest,
  FetchPreKeyBundleResponse,
  GetKeyCountRequest,
  GetKeyCountResponse,
  UploadOneTimeKeysRequest,
  UploadOneTimeKeysResponse,
  UploadMlsKeyPackageRequest,
  UploadMlsKeyPackageResponse,
  FetchMlsKeyPackageRequest,
  FetchMlsKeyPackageResponse,
} from './keys_pb'

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
    throw new Error(`gRPC call ${service}/${method} failed (${res.status}): ${errorText}`)
  }
  return res.json() as Promise<TRes>
}

export const KeyService = {
  uploadPreKeyBundle(req: UploadPreKeyBundleRequest, token?: string): Promise<UploadPreKeyBundleResponse> {
    return grpcUnary<UploadPreKeyBundleRequest, UploadPreKeyBundleResponse>('chat.v1.KeyService', 'UploadPreKeyBundle', req, token)
  },

  fetchPreKeyBundle(req: FetchPreKeyBundleRequest, token?: string): Promise<FetchPreKeyBundleResponse> {
    return grpcUnary<FetchPreKeyBundleRequest, FetchPreKeyBundleResponse>('chat.v1.KeyService', 'FetchPreKeyBundle', req, token)
  },

  getKeyCount(req: GetKeyCountRequest, token?: string): Promise<GetKeyCountResponse> {
    return grpcUnary<GetKeyCountRequest, GetKeyCountResponse>('chat.v1.KeyService', 'GetKeyCount', req, token)
  },

  uploadOneTimeKeys(req: UploadOneTimeKeysRequest, token?: string): Promise<UploadOneTimeKeysResponse> {
    return grpcUnary<UploadOneTimeKeysRequest, UploadOneTimeKeysResponse>('chat.v1.KeyService', 'UploadOneTimeKeys', req, token)
  },

  uploadMlsKeyPackage(req: UploadMlsKeyPackageRequest, token?: string): Promise<UploadMlsKeyPackageResponse> {
    return grpcUnary<UploadMlsKeyPackageRequest, UploadMlsKeyPackageResponse>('chat.v1.KeyService', 'UploadMlsKeyPackage', req, token)
  },

  fetchMlsKeyPackage(req: FetchMlsKeyPackageRequest, token?: string): Promise<FetchMlsKeyPackageResponse> {
    return grpcUnary<FetchMlsKeyPackageRequest, FetchMlsKeyPackageResponse>('chat.v1.KeyService', 'FetchMlsKeyPackage', req, token)
  },
}
