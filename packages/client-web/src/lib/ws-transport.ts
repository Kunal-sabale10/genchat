/**
 * WsTransport — authenticated WebSocket client for gatewayd
 *
 * - Connects with JWT token via ?token=<jwt> query param
 * - Auto-reconnects with exponential backoff (1s → 2s → 4s → max 30s)
 * - Sends heartbeat pings every 30s
 * - Queues frames if socket is CONNECTING
 * - Resolves Promise<GatewayAck> on matching client_msg_id ACK
 */

export interface GatewayAck {
  client_msg_id: string
  message_id: string
  sequence_num: number
}

export interface InboundFrame {
  type: 'push' | 'ack' | 'read_receipt' | 'pong'
  [key: string]: unknown
}

type AckResolver = (ack: GatewayAck) => void
type InboundHandler = (frame: InboundFrame) => void

const HEARTBEAT_MS = 30_000
const MAX_BACKOFF_MS = 30_000

export class WsTransport {
  private ws: WebSocket | null = null
  private token: string = ''
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private pendingAcks = new Map<string, AckResolver>()
  private sendQueue: string[] = []
  private inboundHandlers: Set<InboundHandler> = new Set()
  private destroyed = false

  /** Call after login — token is the JWT access token */
  connect(token: string) {
    this.token = token
    this.destroyed = false
    this._connect()
  }

  disconnect() {
    this.destroyed = true
    this._clearTimers()
    this.ws?.close(1000, 'client disconnect')
    this.ws = null
  }

  /** Register a handler for inbound frames (push, ack, read_receipt) */
  onMessage(handler: InboundHandler): () => void {
    this.inboundHandlers.add(handler)
    return () => this.inboundHandlers.delete(handler)
  }

  /** Send a frame and await the gateway ACK */
  send(payload: object): Promise<GatewayAck> {
    return new Promise((resolve, reject) => {
      const frame = JSON.stringify(payload)
      const clientMsgId = (payload as any).client_msg_id as string

      if (clientMsgId) {
        this.pendingAcks.set(clientMsgId, resolve)
      }

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(frame)
      } else {
        // Queue for when connection opens
        this.sendQueue.push(frame)
      }

      // Reject after 15s timeout
      setTimeout(() => {
        if (this.pendingAcks.has(clientMsgId)) {
          this.pendingAcks.delete(clientMsgId)
          reject(new Error(`WsTransport: ACK timeout for ${clientMsgId}`))
        }
      }, 15_000)
    })
  }

  private _connect() {
    if (this.destroyed) return

    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(this.token)}`
    console.info(`[WsTransport] Connecting to ${url} (attempt ${this.reconnectAttempts + 1})`)

    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      console.info('[WsTransport] Connected')
      this.reconnectAttempts = 0
      this._startHeartbeat()
      // Flush queued frames
      while (this.sendQueue.length > 0) {
        const frame = this.sendQueue.shift()!
        ws.send(frame)
      }
    }

    ws.onmessage = async (ev) => {
      let rawData = ev.data
      if (typeof Blob !== 'undefined' && rawData instanceof Blob) {
        rawData = await rawData.text()
      } else if (typeof ArrayBuffer !== 'undefined' && rawData instanceof ArrayBuffer) {
        rawData = new TextDecoder().decode(rawData)
      }

      let frame: InboundFrame
      try {
        frame = JSON.parse(rawData as string) as InboundFrame
      } catch {
        console.warn('[WsTransport] Non-JSON frame received')
        return
      }

      // Resolve pending ACK promise
      if (frame.type === 'ack') {
        const ack = frame as unknown as GatewayAck & { type: string }
        const resolver = this.pendingAcks.get(ack.client_msg_id)
        if (resolver) {
          this.pendingAcks.delete(ack.client_msg_id)
          resolver(ack as GatewayAck)
        }
      }

      // Notify all inbound handlers
      this.inboundHandlers.forEach((h) => h(frame))
    }

    ws.onerror = (ev) => {
      console.warn('[WsTransport] Error', ev)
    }

    ws.onclose = (ev) => {
      console.info(`[WsTransport] Closed (code=${ev.code})`)
      this._clearTimers()
      if (!this.destroyed && ev.code !== 1000) {
        this._scheduleReconnect()
      }
    }
  }

  private _scheduleReconnect() {
    const backoff = Math.min(1000 * Math.pow(2, this.reconnectAttempts), MAX_BACKOFF_MS)
    this.reconnectAttempts++
    console.info(`[WsTransport] Reconnecting in ${backoff}ms`)
    this.reconnectTimer = setTimeout(() => this._connect(), backoff)
  }

  private _startHeartbeat() {
    this._clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ action: 'ping' }))
      }
    }, HEARTBEAT_MS)
  }

  private _clearHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private _clearTimers() {
    this._clearHeartbeat()
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}

// Singleton — one transport per browser tab
export const wsTransport = new WsTransport()
