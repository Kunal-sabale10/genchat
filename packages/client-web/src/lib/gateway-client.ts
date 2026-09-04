export interface GatewayEnvelope {
  type: 'message' | 'ack' | 'presence' | 'heartbeat'
  channelId?: string
  senderId?: string
  clientMsgId?: string
  sequenceNum?: number
  messageType?: number
  ciphertext?: string
}

export type MessageHandler = (envelope: GatewayEnvelope) => void

export class GatewayClient {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectInterval = 2000
  private messageHandlers: Set<MessageHandler> = new Set()
  private pendingAcks: Map<string, (seq: number) => void> = new Map()

  constructor(
    private gatewayUrl: string,
    private getAuthToken: () => string | null
  ) {}

  public connect(): void {
    const token = this.getAuthToken()
    if (!token) {
      console.warn('[Gateway] No auth token available. Deferring connection.')
      return
    }

    const url = `${this.gatewayUrl}?token=${encodeURIComponent(token)}`
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      console.log('[Gateway] Connected to gatewayd')
      this.reconnectAttempts = 0
    }

    this.ws.onmessage = (event) => {
      try {
        const envelope: GatewayEnvelope = JSON.parse(event.data)
        if (envelope.type === 'ack' && envelope.clientMsgId && envelope.sequenceNum !== undefined) {
          const resolver = this.pendingAcks.get(envelope.clientMsgId)
          if (resolver) {
            resolver(envelope.sequenceNum)
            this.pendingAcks.delete(envelope.clientMsgId)
          }
        }
        this.messageHandlers.forEach((handler) => handler(envelope))
      } catch (err) {
        console.error('[Gateway] Failed to parse message frame:', err)
      }
    }

    this.ws.onclose = () => {
      console.warn('[Gateway] Disconnected. Reconnecting...')
      this.scheduleReconnect()
    }

    this.ws.onerror = (err) => {
      console.error('[Gateway] WebSocket error:', err)
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

      if (envelope.clientMsgId) {
        const timeout = setTimeout(() => {
          this.pendingAcks.delete(envelope.clientMsgId!)
          reject(new Error(`Timeout waiting for ACK on ${envelope.clientMsgId}`))
        }, 10000)

        this.pendingAcks.set(envelope.clientMsgId, (seq) => {
          clearTimeout(timeout)
          resolve(seq)
        })
      }

      this.ws.send(JSON.stringify(envelope))
    })
  }

  public disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      setTimeout(() => this.connect(), this.reconnectInterval * this.reconnectAttempts)
    }
  }
}
