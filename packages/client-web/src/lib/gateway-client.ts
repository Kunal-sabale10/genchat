export interface GatewayEnvelope {
  type: 'message' | 'ack' | 'presence' | 'heartbeat' | 'push' | 'error' | 'pong' | 'typing' | 'read_receipt' | 'group_commit' | 'ephemeral_setting' | 'reaction'
  channelId?: string
  senderId?: string
  clientMsgId?: string
  sequenceNum?: number
  messageType?: number
  ciphertext?: string
  ephemeralTtlSec?: number
  replyToMessageId?: string
}


export interface TypingEvent {
  channelId: string
  userId: string
  isTyping: boolean
}

export interface ReadReceiptEvent {
  channelId: string
  userId: string
  serverId: string
  sequenceNum: number
  receiptType?: 'delivered' | 'read'
}

export interface EphemeralSettingEvent {
  channelId: string
  ephemeralTtlSec: number
  updatedBy: string
  updatedAt: number
}

export interface ReactionEvent {
  channelId: string
  targetId: string
  senderId: string
  emoji: string
  op: 'add' | 'remove'
  serverTime?: number
}

export interface CallSignalEvent {
  signalType:
    | 'offer'
    | 'answer'
    | 'ice_candidate'
    | 'hangup'
    | 'reject'
    | 'peer_offline'
    | 'group_join'
    | 'group_leave'
    | 'group_ping'
  callId: string
  channelId?: string
  senderId?: string
  targetUserId?: string
  callType?: 'audio' | 'video'
  sdp?: string
  candidate?: any
  serverTime?: number
}

export type MessageHandler = (envelope: GatewayEnvelope) => void
export type StatusHandler = (connected: boolean) => void
export type TypingHandler = (event: TypingEvent) => void
export type ReadReceiptHandler = (event: ReadReceiptEvent) => void
export type EphemeralSettingHandler = (event: EphemeralSettingEvent) => void
export type ReactionHandler = (event: ReactionEvent) => void
export type CallSignalHandler = (event: CallSignalEvent) => void

export class GatewayClient {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectInterval = 2000
  private messageHandlers: Set<MessageHandler> = new Set()
  private statusHandlers: Set<StatusHandler> = new Set()
  private typingHandlers: Set<TypingHandler> = new Set()
  private readReceiptHandlers: Set<ReadReceiptHandler> = new Set()
  private ephemeralSettingHandlers: Set<EphemeralSettingHandler> = new Set()
  private reactionHandlers: Set<ReactionHandler> = new Set()
  private callSignalHandlers: Set<CallSignalHandler> = new Set()
  private pendingAcks: Map<string, (seq: number) => void> = new Map()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private isExplicitDisconnect = false

  constructor(
    private gatewayUrl: string,
    private getAuthToken: () => string | null
  ) {}

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  public onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler)
    handler(this.isConnected())
    return () => this.statusHandlers.delete(handler)
  }

  private setStatus(connected: boolean) {
    this.statusHandlers.forEach((handler) => handler(connected))
  }

  public connect(): void {
    this.isExplicitDisconnect = false
    const token = this.getAuthToken()
    if (!token) {
      console.warn('[Gateway] No auth token available. Deferring connection.')
      this.setStatus(false)
      return
    }

    const url = `${this.gatewayUrl}?token=${encodeURIComponent(token)}`
    console.log('[Gateway] Connecting to:', url.replace(/token=([^&]{6})[^&]+/, 'token=$1...'))

    try {
      this.ws = new WebSocket(url)
    } catch (err) {
      console.error('[Gateway] Failed to create WebSocket:', err)
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      console.log('[Gateway] Connected to gatewayd')
      this.reconnectAttempts = 0
      this.setStatus(true)
      this.startHeartbeat()
    }

    this.ws.onmessage = async (event) => {
      try {
        let text: string
        if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
          text = await event.data.text()
        } else if (typeof ArrayBuffer !== 'undefined' && event.data instanceof ArrayBuffer) {
          text = new TextDecoder().decode(event.data)
        } else {
          text = String(event.data)
        }

        console.log('[Gateway] Raw frame received:', text)
        const raw = JSON.parse(text)

        // 1. Handle ACK from gatewayd
        if (raw.type === 'ack') {
          const clientMsgId = raw.client_msg_id || raw.clientMsgId
          const seq = raw.sequence_num ?? raw.sequenceNum ?? 0
          console.log('[Gateway] ACK for:', clientMsgId, 'seq:', seq)
          if (clientMsgId) {
            const resolver = this.pendingAcks.get(clientMsgId)
            if (resolver) {
              resolver(seq)
              this.pendingAcks.delete(clientMsgId)
            }
          }
        }

        // 2. Handle typing notifications
        if (raw.type === 'typing') {
          this.typingHandlers.forEach((h) =>
            h({
              channelId: raw.channel_id,
              userId: raw.user_id,
              isTyping: !!raw.is_typing,
            })
          )
          return
        }

        // 3. Handle read & delivery receipts
        if (raw.type === 'read_receipt' || raw.type === 'receipt') {
          const rType = raw.receipt_type || (raw.type === 'read_receipt' ? 'read' : 'delivered')
          this.readReceiptHandlers.forEach((h) =>
            h({
              channelId: raw.channel_id,
              userId: raw.user_id,
              serverId: raw.server_id || raw.message_id,
              sequenceNum: raw.sequence_num ?? 0,
              receiptType: rType,
            })
          )
          return
        }


        // 4. Handle server errors
        if (raw.type === 'error') {
          console.warn('[Gateway] Server error frame:', raw.code, raw.message)
          return
        }

        // 5. Handle WebRTC call signaling
        if (raw.type === 'call_signal') {
          console.log('[Gateway] Received call_signal:', raw.signal_type, 'from:', raw.sender_id, 'call:', raw.call_id, 'chan:', raw.channel_id)
          this.callSignalHandlers.forEach((h) =>
            h({
              signalType: raw.signal_type,
              callId: raw.call_id,
              channelId: raw.channel_id,
              senderId: raw.sender_id,
              targetUserId: raw.target_user_id,
              callType: raw.call_type || 'video',
              sdp: raw.sdp,
              candidate: raw.candidate,
              serverTime: raw.server_time,
            })
          )
          return
        }

        // 5b. Handle Ephemeral Setting update
        if (raw.type === 'ephemeral_setting') {
          console.log('[Gateway] Received ephemeral_setting for', raw.channel_id, 'ttl:', raw.ephemeral_ttl_sec)
          this.ephemeralSettingHandlers.forEach((h) =>
            h({
              channelId: raw.channel_id || raw.channelId,
              ephemeralTtlSec: Number(raw.ephemeral_ttl_sec ?? raw.ephemeralTtlSec ?? 0),
              updatedBy: raw.updated_by || raw.updatedBy,
              updatedAt: raw.updated_at || raw.updatedAt || Date.now(),
            })
          )
          return
        }

        // 5c. Handle Reaction update
        if (raw.type === 'reaction') {
          console.log('[Gateway] Received reaction for', raw.target_id, 'emoji:', raw.emoji, 'by:', raw.sender_id)
          this.reactionHandlers.forEach((h) =>
            h({
              channelId: raw.channel_id || raw.channelId,
              targetId: raw.target_id || raw.targetId,
              senderId: raw.sender_id || raw.senderId,
              emoji: raw.emoji,
              op: raw.op || 'add',
              serverTime: raw.server_time || raw.serverTime || Date.now(),
            })
          )
          return
        }

        // 3b. Handle group_commit frame
        if (raw.type === 'group_commit') {

          const commitEnvelope: GatewayEnvelope = {
            type: 'group_commit',
            channelId: raw.channel_id || raw.channelId,
            senderId: raw.sender_id || raw.senderId,
            sequenceNum: raw.epoch,
            ciphertext: raw.commit_data || raw.commitData,
          }
          this.messageHandlers.forEach((handler) => handler(commitEnvelope))
          return
        }

        // 4. Handle history response
        if (raw.type === 'history' && Array.isArray(raw.messages)) {

          console.log(`[Gateway] Received history for ${raw.channel_id}: ${raw.messages.length} messages`)
          // Scylla messages are ordered DESC by time; reverse so oldest is first
          const chronological = [...raw.messages].reverse()
          for (const m of chronological) {
            let decodedCiphertext = m.ciphertext_base64 || ''
            try {
              decodedCiphertext = atob(m.ciphertext_base64)
            } catch {
              // Leave as-is
            }
            const histEnvelope: GatewayEnvelope = {
              type: 'message',
              channelId: raw.channel_id,
              senderId: m.sender_id,
              clientMsgId: m.client_msg_id || m.server_id,
              sequenceNum: m.sequence_num,
              ciphertext: decodedCiphertext,
              ephemeralTtlSec: m.ephemeral_ttl_sec != null ? Number(m.ephemeral_ttl_sec) : undefined,
              replyToMessageId: m.reply_to_message_id || m.replyToMessageId,
            }
            this.messageHandlers.forEach((handler) => handler(histEnvelope))
          }
          return
        }

        // 3. Normalize push frame from gatewayd
        let envelope: GatewayEnvelope
        if (raw.type === 'push') {
          let decodedCiphertext = raw.ciphertext_base64 || ''
          try {
            decodedCiphertext = atob(raw.ciphertext_base64)
          } catch {
            // Leave as-is if not base64
          }

          envelope = {
            type: 'message',
            channelId: raw.channel_id,
            senderId: raw.sender_id,
            clientMsgId: raw.server_id,
            sequenceNum: raw.server_time,
            messageType: raw.message_type,
            ciphertext: decodedCiphertext,
            ephemeralTtlSec: raw.ephemeral_ttl_sec != null ? Number(raw.ephemeral_ttl_sec) : undefined,
            replyToMessageId: raw.reply_to_message_id || raw.replyToMessageId,
          }
          console.log('[Gateway] Normalized push → envelope:', JSON.stringify(envelope))
        } else {
          envelope = {
            type: raw.type || 'message',
            channelId: raw.channel_id || raw.channelId,
            senderId: raw.sender_id || raw.senderId,
            clientMsgId: raw.client_msg_id || raw.clientMsgId || raw.server_id,
            sequenceNum: raw.sequence_num ?? raw.sequenceNum,
            messageType: raw.message_type ?? raw.messageType,
            ciphertext: raw.ciphertext_base64 || raw.ciphertext,
            ephemeralTtlSec: raw.ephemeral_ttl_sec != null ? Number(raw.ephemeral_ttl_sec) : undefined,
            replyToMessageId: raw.reply_to_message_id || raw.replyToMessageId,
          }
        }

        console.log('[Gateway] Dispatching to', this.messageHandlers.size, 'handler(s)')
        this.messageHandlers.forEach((handler) => handler(envelope))
      } catch (err) {
        console.error('[Gateway] Failed to parse message frame:', err)
      }
    }

    this.ws.onclose = (ev) => {
      console.warn(`[Gateway] Disconnected (code=${ev.code}). Reconnecting...`)
      this.setStatus(false)
      this.stopHeartbeat()
      if (!this.isExplicitDisconnect) {
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = (err) => {
      console.error('[Gateway] WebSocket error:', err)
      this.setStatus(false)
    }
  }

  public subscribe(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  public sendGroupCommit(channelId: string, epoch: number, commitDataBase64: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[Gateway] Cannot send group commit: WebSocket not open')
      return
    }
    this.ws.send(JSON.stringify({
      action: 'group_commit',
      channel_id: channelId,
      epoch,
      commit_data: commitDataBase64,
    }))
  }

  public sendRaw(payload: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[Gateway] Cannot send raw frame: WebSocket not open')
      return
    }
    this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload))
  }


  public async sendEnvelope(envelope: GatewayEnvelope): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Gateway connection is not open'))
      }

      const clientMsgId = envelope.clientMsgId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

      const timeout = setTimeout(() => {
        this.pendingAcks.delete(clientMsgId)
        reject(new Error(`Timeout waiting for ACK on ${clientMsgId}`))
      }, 10000)

      this.pendingAcks.set(clientMsgId, (seq) => {
        clearTimeout(timeout)
        resolve(seq)
      })

      // Convert payload into gatewayd InboundFrame format
      const rawPayload = envelope.ciphertext || ''
      let b64 = ''
      try {
        b64 = btoa(unescape(encodeURIComponent(rawPayload)))
      } catch {
        b64 = btoa(rawPayload)
      }

      const wireFrame: any = {
        action: 'send_message',
        channel_id: envelope.channelId,
        client_msg_id: clientMsgId,
        ciphertext_base64: b64,
        message_type: envelope.messageType || 1,
      }
      if (envelope.ephemeralTtlSec) {
        wireFrame.ephemeral_ttl_sec = envelope.ephemeralTtlSec
      }
      if (envelope.replyToMessageId) {
        wireFrame.reply_to_message_id = envelope.replyToMessageId
      }

      this.ws.send(JSON.stringify(wireFrame))
    })
  }

  public fetchHistory(channelId: string, limit = 50): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    console.log(`[Gateway] Requesting history for channel: ${channelId}`)
    this.ws.send(JSON.stringify({
      action: 'fetch_history',
      channel_id: channelId,
      limit,
    }))
  }

  public onReaction(handler: ReactionHandler): () => void {
    this.reactionHandlers.add(handler)
    return () => this.reactionHandlers.delete(handler)
  }

  public sendReaction(channelId: string, targetId: string, emoji: string, op: 'add' | 'remove' = 'add'): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[Gateway] Cannot send reaction, WebSocket not open')
      return
    }
    const frame = {
      action: 'reaction',
      channel_id: channelId,
      target_id: targetId,
      emoji,
      op,
    }
    console.log('[Gateway] Dispatched reaction:', emoji, 'on:', targetId, 'op:', op)
    this.ws.send(JSON.stringify(frame))
  }

  public onTyping(handler: TypingHandler): () => void {
    this.typingHandlers.add(handler)
    return () => this.typingHandlers.delete(handler)
  }

  public onReadReceipt(handler: ReadReceiptHandler): () => void {
    this.readReceiptHandlers.add(handler)
    return () => this.readReceiptHandlers.delete(handler)
  }

  public sendTyping(channelId: string, isTyping: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      action: 'typing',
      channel_id: channelId,
      is_typing: isTyping,
    }))
  }

  public sendReadReceipt(channelId: string, serverId: string, sequenceNum: number = 0): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      action: 'read_receipt',
      channel_id: channelId,
      server_id: serverId,
      sequence_num: sequenceNum,
    }))
  }

  public sendDeliveryReceipt(channelId: string, serverId: string, sequenceNum: number = 0): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      action: 'ack_receipt',
      receipt_type: 'delivered',
      channel_id: channelId,
      server_id: serverId,
      message_id: serverId,
      sequence_num: sequenceNum,
    }))
  }


  public onEphemeralSetting(handler: EphemeralSettingHandler): () => void {
    this.ephemeralSettingHandlers.add(handler)
    return () => this.ephemeralSettingHandlers.delete(handler)
  }

  public sendEphemeralSetting(channelId: string, ephemeralTtlSec: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      action: 'ephemeral_setting',
      channel_id: channelId,
      ephemeral_ttl_sec: ephemeralTtlSec,
    }))
  }

  public onCallSignal(handler: CallSignalHandler): () => void {
    this.callSignalHandlers.add(handler)
    return () => this.callSignalHandlers.delete(handler)
  }

  public sendCallSignal(event: CallSignalEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[Gateway] Cannot send call signal, WebSocket not open')
      return
    }
    const frame = {
      action: 'call_signal',
      signal_type: event.signalType,
      call_id: event.callId,
      channel_id: event.channelId,
      target_user_id: event.targetUserId,
      call_type: event.callType || 'video',
      sdp: event.sdp,
      candidate: event.candidate,
    }
    console.log('[Gateway] Dispatched call_signal:', event.signalType, 'target:', event.targetUserId, 'channel:', event.channelId)
    this.ws.send(JSON.stringify(frame))
  }

  public disconnect(): void {
    this.isExplicitDisconnect = true
    this.stopHeartbeat()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.setStatus(false)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ action: 'ping' }))
      }
    }, 30000)
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      const delay = Math.min(this.reconnectInterval * Math.pow(1.5, this.reconnectAttempts - 1), 30000)
      console.log(`[Gateway] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})...`)
      setTimeout(() => this.connect(), delay)
    }
  }
}
