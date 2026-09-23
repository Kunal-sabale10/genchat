import React, { createContext, useContext, useMemo, useRef, type ReactNode } from 'react'
import {
  LocalDatabase,
  InboundSyncReconciler,
  OutboxManager,
  Message,
  Channel,
  type MessageStatus,
} from '@genchat/client-db'
import { useAuth } from './auth-context'

export interface DatabaseContextValue {
  db: LocalDatabase
  reconciler: InboundSyncReconciler
  outbox: OutboxManager
  persistInboundMessage: (msg: {
    id: string
    channelId: string
    senderId: string
    text: string
    sequenceNum?: number
    status?: MessageStatus
    mediaId?: string
    createdAt?: Date
  }) => Promise<Message>
  persistOutboundMessage: (msg: {
    id: string
    channelId: string
    senderId: string
    text: string
    clientMsgId: string
    status?: MessageStatus
  }) => Promise<Message>
  getLocalMessages: (channelId: string) => Promise<Message[]>
  getLocalChannels: () => Promise<Channel[]>
  upsertChannel: (channelId: string, name: string, type: 'direct' | 'group', lastMessageAt?: Date) => Promise<Channel>
}

const DatabaseContext = createContext<DatabaseContextValue | null>(null)

export function DatabaseProvider({ children }: { children: ReactNode }) {
  const { crypto } = useAuth()
  const dbRef = useRef<LocalDatabase | null>(null)
  if (!dbRef.current) {
    dbRef.current = new LocalDatabase()
  }
  const db = dbRef.current

  const cryptoDecryptor = useMemo(() => ({
    decryptMessage: (
      sessionPickle: string,
      pickleKeyHex: string,
      messageType: number,
      ciphertextBase64: string
    ) => {
      if (crypto) {
        return crypto.decryptMessage(sessionPickle, pickleKeyHex, messageType, ciphertextBase64)
      }
      return {
        plaintext: new TextEncoder().encode(ciphertextBase64),
        updated_session_pickle: sessionPickle,
      }
    },
  }), [crypto])

  const reconciler = useMemo(() => new InboundSyncReconciler(db, cryptoDecryptor), [db, cryptoDecryptor])

  const cryptoEncryptor = useMemo(() => ({
    encryptMessage: (sessionPickle: string, pickleKeyHex: string, plaintext: string | Uint8Array) => {
      if (crypto) {
        const bytes = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext
        return crypto.encryptMessage(sessionPickle, pickleKeyHex, bytes)
      }
      return {
        message_type: 1,
        ciphertext_base64: typeof plaintext === 'string' ? btoa(plaintext) : btoa(String.fromCharCode(...plaintext)),
        updated_session_pickle: sessionPickle,
      }
    },
  }), [crypto])

  const wsTransportStub = useMemo(() => ({
    send: async (payload: any) => {
      return {
        client_msg_id: payload.client_msg_id || '',
        message_id: payload.message_id || '',
        sequence_num: 1,
      }
    },
  }), [])

  const outbox = useMemo(() => new OutboxManager(db, cryptoEncryptor, wsTransportStub), [db, cryptoEncryptor, wsTransportStub])

  const persistInboundMessage = async (msg: {
    id: string
    channelId: string
    senderId: string
    text: string
    sequenceNum?: number
    status?: MessageStatus
    mediaId?: string
    createdAt?: Date
  }): Promise<Message> => {
    const msgCol = db.get('messages')
    const existing = await msgCol.find(msg.id)
    if (existing) {
      existing.text = msg.text
      if (msg.status) existing.status = msg.status
      if (msg.sequenceNum !== undefined) existing.sequenceNum = msg.sequenceNum
      msgCol.put(existing)
      return existing
    }

    const created = await msgCol.create((record: Message) => {
      record.id = msg.id
      record.channelId = msg.channelId
      record.senderId = msg.senderId
      record.clientMsgId = msg.id
      if (msg.sequenceNum !== undefined) record.sequenceNum = msg.sequenceNum
      record.text = msg.text
      record.status = msg.status || 'delivered'
      record.messageType = msg.mediaId ? 'media' : 'text'
      if (msg.mediaId) record.mediaId = msg.mediaId
      record.createdAt = msg.createdAt || new Date()
    })

    // Update channel unread & last message
    const channelCol = db.get('channels')
    const channel = await channelCol.find(msg.channelId)
    if (channel) {
      channel.lastMessageAt = msg.createdAt || new Date()
      channelCol.put(channel)
    }

    return created
  }

  const persistOutboundMessage = async (msg: {
    id: string
    channelId: string
    senderId: string
    text: string
    clientMsgId: string
    status?: MessageStatus
  }): Promise<Message> => {
    const msgCol = db.get('messages')
    const created = await msgCol.create((record: Message) => {
      record.id = msg.id
      record.channelId = msg.channelId
      record.senderId = msg.senderId
      record.clientMsgId = msg.clientMsgId
      record.text = msg.text
      record.status = msg.status || 'sent'
      record.messageType = 'text'
      record.createdAt = new Date()
    })

    const channelCol = db.get('channels')
    const channel = await channelCol.find(msg.channelId)
    if (channel) {
      channel.lastMessageAt = new Date()
      channelCol.put(channel)
    }

    return created
  }

  const getLocalMessages = async (channelId: string): Promise<Message[]> => {
    const msgCol = db.get('messages')
    const all = await msgCol.query({ channel_id: channelId })
    return all.sort((a, b) => {
      const timeA = a.createdAt ? a.createdAt.getTime() : 0
      const timeB = b.createdAt ? b.createdAt.getTime() : 0
      return timeA - timeB
    })
  }

  const getLocalChannels = async (): Promise<Channel[]> => {
    const channelCol = db.get('channels')
    return channelCol.all()
  }

  const upsertChannel = async (channelId: string, name: string, type: 'direct' | 'group', lastMessageAt?: Date): Promise<Channel> => {
    const channelCol = db.get('channels')
    const existing = await channelCol.find(channelId)
    if (existing) {
      existing.name = name
      existing.channelType = type
      if (lastMessageAt) existing.lastMessageAt = lastMessageAt
      channelCol.put(existing)
      return existing
    }
    return channelCol.create((c: Channel) => {
      c.id = channelId
      c.name = name
      c.channelType = type
      c.unreadCount = 0
      c.createdAt = new Date()
      c.updatedAt = new Date()
      c.lastMessageAt = lastMessageAt || null
    })
  }

  const value: DatabaseContextValue = {
    db,
    reconciler,
    outbox,
    persistInboundMessage,
    persistOutboundMessage,
    getLocalMessages,
    getLocalChannels,
    upsertChannel,
  }

  return (
    <DatabaseContext.Provider value={value}>
      {children}
    </DatabaseContext.Provider>
  )
}

export function useDatabase(): DatabaseContextValue {
  const ctx = useContext(DatabaseContext)
  if (!ctx) {
    throw new Error('useDatabase must be used within a DatabaseProvider')
  }
  return ctx
}
