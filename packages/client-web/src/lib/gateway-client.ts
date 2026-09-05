export interface GatewayEnvelope {
  type: 'message' | 'ack' | 'presence' | 'heartbeat' | 'push' | 'error' | 'pong' | 'typing' | 'read_receipt'
  channelId?: string
  senderId?: string
  clientMsgId?: string
  sequenceNum?: number
  messageType?: number
  ciphertext?: string
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
}

export type MessageHandler = (envelope: GatewayEnvelope) => void
export type StatusHandler = (connected: boolean) => void
export type TypingHandler = (event: TypingEvent) => void
export type ReadReceiptHandler = (event: ReadReceiptEvent) => void

export class GatewayClient {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectInterval = 2000
  private messageHandlers: Set<MessageHandler> = new Set()
  private statusHandlers: Set<StatusHandler> = new Set()
  private typingHandlers: Set<TypingHandler> = new Set()
  private readReceiptHandlers: Set<ReadReceiptHandler> = new Set()
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

        // 3. Handle read receipts
        if (raw.type === 'read_receipt') {
          this.readReceiptHandlers.forEach((h) =>
            h({
              channelId: raw.channel_id,
              userId: raw.user_id,
              serverId: raw.server_id,
              sequenceNum: raw.sequence_num ?? 0,
            })
          )
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

      const wireFrame = {
        action: 'send_message',
        channel_id: envelope.channelId,
        client_msg_id: clientMsgId,
        ciphertext_base64: b64,
        message_type: envelope.messageType || 1,
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
