// @generated from protobuf file chat/v1/ledger.proto
// Connect-ES compatible stubs matching proto/chat/v1/ledger.proto

export interface StoreMessageRequest {
  conversationId: string
  senderId: string
  clientMsgId: string
  encryptedPayload: Uint8Array | string
  senderRatchetKey?: Uint8Array | string
  messageIndex?: number
  ephemeralTtlSec?: number | string
}

export interface StoredMessageResponse {
  conversationId: string
  messageId: string
  sequenceNum: number | string
  senderId: string
  clientMsgId: string
  encryptedPayload: Uint8Array | string
  senderRatchetKey?: Uint8Array | string
  messageIndex?: number
  createdAt?: string | number
  ephemeralTtlSec?: number | string
}

export interface StoreMessageResponse {
  message: StoredMessageResponse
  deduplicated: boolean
}

export interface FetchMessagesRequest {
  conversationId: string
  bucket?: string
  limit?: number
  beforeMessageId?: string
}

export interface FetchMessagesResponse {
  messages: StoredMessageResponse[]
}

export interface UpdateReceiptRequest {
  conversationId: string
  userId: string
  receiptType: string
  messageId: string
  sequenceNum: number | string
}

export interface UpdateReceiptResponse {
  success: boolean
}

export interface ReceiptItem {
  userId: string
  deliveredMessageId?: string
  deliveredSeq?: number | string
  readMessageId?: string
  readSeq?: number | string
  updatedAt?: string | number
}

export interface GetReceiptsRequest {
  conversationId: string
  messageIds: string[]
}

export interface GetReceiptsResponse {
  receipts: Record<string, ReceiptItem>
}

export interface MessageEventItem {
  eventType: string
  payload?: Uint8Array | string
  actorId?: string
  createdAt?: string | number
}

export interface RecordMessageEventRequest {
  conversationId: string
  messageId: string
  eventType: string
  payload?: Uint8Array | string
  actorId?: string
}

export interface RecordMessageEventResponse {
  success: boolean
}

export interface FetchMessageEventsRequest {
  conversationId: string
  messageId: string
}

export interface FetchMessageEventsResponse {
  events: MessageEventItem[]
}
