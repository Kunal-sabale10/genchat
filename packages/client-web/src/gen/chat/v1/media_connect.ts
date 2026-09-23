/// <reference types="vite/client" />
// @generated Connect-ES compatible MediaService client
// Communicates with backend MediaService (mediad / envoy)

import type {
  GetUploadUrlRequest,
  GetUploadUrlResponse,
  GetDownloadUrlRequest,
  GetDownloadUrlResponse,
} from './media_pb'

const BASE_URL = import.meta.env.VITE_MEDIA_URL || ''

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

export const MediaService = {
  getUploadUrl(req: GetUploadUrlRequest, token?: string): Promise<GetUploadUrlResponse> {
    return grpcUnary<GetUploadUrlRequest, GetUploadUrlResponse>('chat.v1.MediaService', 'GetUploadUrl', req, token)
  },

  getDownloadUrl(req: GetDownloadUrlRequest, token?: string): Promise<GetDownloadUrlResponse> {
    return grpcUnary<GetDownloadUrlRequest, GetDownloadUrlResponse>('chat.v1.MediaService', 'GetDownloadUrl', req, token)
  },
}
