/// <reference types="vite/client" />
// @generated Connect-ES compatible LedgerService client
// Communicates with backend LedgerService (ledgerd / envoy)

import type {
  StoreMessageRequest,
  StoreMessageResponse,
  FetchMessagesRequest,
  FetchMessagesResponse,
  UpdateReceiptRequest,
  UpdateReceiptResponse,
  GetReceiptsRequest,
  GetReceiptsResponse,
  RecordMessageEventRequest,
  RecordMessageEventResponse,
  FetchMessageEventsRequest,
  FetchMessageEventsResponse,
} from './ledger_pb'

const BASE_URL = import.meta.env.VITE_LEDGER_URL || import.meta.env.VITE_AUTH_URL || ''

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

export const LedgerService = {
  storeMessage(req: StoreMessageRequest, token?: string): Promise<StoreMessageResponse> {
    return grpcUnary<StoreMessageRequest, StoreMessageResponse>('chat.v1.LedgerService', 'StoreMessage', req, token)
  },

  fetchMessages(req: FetchMessagesRequest, token?: string): Promise<FetchMessagesResponse> {
    return grpcUnary<FetchMessagesRequest, FetchMessagesResponse>('chat.v1.LedgerService', 'FetchMessages', req, token)
  },

  updateReceipt(req: UpdateReceiptRequest, token?: string): Promise<UpdateReceiptResponse> {
    return grpcUnary<UpdateReceiptRequest, UpdateReceiptResponse>('chat.v1.LedgerService', 'UpdateReceipt', req, token)
  },

  getReceipts(req: GetReceiptsRequest, token?: string): Promise<GetReceiptsResponse> {
    return grpcUnary<GetReceiptsRequest, GetReceiptsResponse>('chat.v1.LedgerService', 'GetReceipts', req, token)
  },

  recordMessageEvent(req: RecordMessageEventRequest, token?: string): Promise<RecordMessageEventResponse> {
    return grpcUnary<RecordMessageEventRequest, RecordMessageEventResponse>('chat.v1.LedgerService', 'RecordMessageEvent', req, token)
  },

  fetchMessageEvents(req: FetchMessageEventsRequest, token?: string): Promise<FetchMessageEventsResponse> {
    return grpcUnary<FetchMessageEventsRequest, FetchMessageEventsResponse>('chat.v1.LedgerService', 'FetchMessageEvents', req, token)
  },
}
