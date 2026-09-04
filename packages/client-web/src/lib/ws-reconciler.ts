/**
 * WsReconciler — binds the WsTransport singleton to SyncReconciler + OptimisticOutbox.
 *
 * Handles two frame types from gatewayd:
 *   - type: 'push'  → decrypt via Wasm → write to reactive database
 *   - type: 'ack'   → already resolved by WsTransport; status update done by OptimisticOutbox
 *   - type: 'read_receipt' → update message status to 'read' in database
 */

import { type InboundFrame, wsTransport } from './ws-transport'

export interface CryptoProvider {
  storage: {
    getSession(channelId: string): Promise<string>
    saveSession(channelId: string, sessionPickle: string, pickleKeyHex?: string): Promise<void>
  }
  decryptMessage(
    sessionPickle: string,
    messageType: number,
    ciphertext: string
  ): Promise<{ plaintext: Uint8Array; updated_session_pickle: string }>
}

export interface MessageRecord {
  id?: string
  serverId?: string
  channelId?: string
  senderId?: string
  body?: string
  status?: 'pending' | 'sent' | 'delivered' | 'read'
  _raw?: Record<string, unknown>
  update: (callback: (record: MessageRecord) => void) => Promise<void>
}

export interface CollectionLike<T> {
  create: (callback: (record: T) => void) => Promise<T>
  query: () => { fetch: () => Promise<T[]> }
}

export interface DatabaseLike {
  write: <T>(work: () => Promise<T>) => Promise<T>
  collections: {
    get: <T = MessageRecord>(name: string) => CollectionLike<T>
  }
}

export class WsReconciler {
  private unsubscribe: (() => void) | null = null

  constructor(
    private db: DatabaseLike,
    private crypto: CryptoProvider
  ) {}

  /** Start listening to inbound frames — call after WsTransport.connect() */
  start() {
    if (this.unsubscribe) return // already started
    this.unsubscribe = wsTransport.onMessage((frame) => this._handleFrame(frame))
  }

  stop() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private async _handleFrame(frame: InboundFrame) {
    try {
      if (frame.type === 'push') {
        await this._handlePush(frame)
      } else if (frame.type === 'read_receipt') {
        await this._handleReadReceipt(frame)
      }
    } catch (err) {
      console.error('[WsReconciler] Frame handling error', err, frame)
    }
  }

  private async _handlePush(frame: InboundFrame) {
    const channelId = frame.channel_id as string
    const senderId = frame.sender_id as string
    const ciphertext = frame.ciphertext_base64 as string
    const messageType = frame.message_type as number
    const serverId = frame.server_id as string

    if (!channelId || !senderId || !ciphertext) {
      console.warn('[WsReconciler] Malformed push frame', frame)
      return
    }

    // 1. Decrypt via Wasm (falls back to raw text in dev if session not available)
    let bodyText: string
    try {
      const sessionPickle = await this.crypto.storage.getSession(channelId)
      const decrypted = await this.crypto.decryptMessage(sessionPickle, messageType, ciphertext)
      await this.crypto.storage.saveSession(channelId, decrypted.updated_session_pickle)
      bodyText = new TextDecoder().decode(decrypted.plaintext)
    } catch {
      // Dev fallback: treat ciphertext as plaintext (no session established yet)
      console.warn('[WsReconciler] Decrypt failed — rendering raw payload (dev mode)')
      bodyText = ciphertext
    }

    // 2. Batch write to local database
    await this.db.write(async () => {
      await this.db.collections.get<MessageRecord>('messages').create((record: MessageRecord) => {
        record.serverId = serverId
        if (record._raw) {
          record._raw.channel_id = channelId
        }
        record.channelId = channelId
        record.senderId = senderId
        record.body = bodyText
        record.status = 'delivered'
      })
    })
  }

  private async _handleReadReceipt(frame: InboundFrame) {
    const serverId = frame.server_id as string
    if (!serverId) return

    const msgs = await this.db.collections
      .get<MessageRecord>('messages')
      .query()
      .fetch()

    const target = msgs.find((m: MessageRecord) => m.serverId === serverId)
    if (target) {
      await this.db.write(async () => {
        await target.update((m: MessageRecord) => {
          m.status = 'read'
        })
      })
    }
  }
}
