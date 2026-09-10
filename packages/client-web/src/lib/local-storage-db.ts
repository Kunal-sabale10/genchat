/**
 * LocalStorageDb — Offline-First IndexedDB Store with Zero-Knowledge Search
 *
 * Persists messages, conversations, and drafts locally.
 * Executes client-side full-text search with highlight snippets.
 */

export interface StoredMessage {
  id: string
  clientMsgId: string
  channelId: string
  senderId: string
  text?: string
  attachment?: any
  status: 'pending' | 'sent' | 'delivered' | 'read'
  timestamp: string
  createdAt: number
  ephemeralTtlSec?: number
  expiresAt?: number
}

export interface StoredConversation {
  id: string
  name: string
  isDirect: boolean
  lastMessage?: string
  unreadCount?: number
}

export interface SearchSnippetResult {
  message: StoredMessage
  score: number
  snippets: string[]
}

const DB_NAME = 'genchat_offline_db'
const DB_VERSION = 1
const STORE_MESSAGES = 'messages'
const STORE_CONVERSATIONS = 'conversations'

export class LocalStorageDb {
  private dbPromise: Promise<IDBDatabase | null>

  constructor() {
    this.dbPromise = this.initIndexedDb()
  }

  private initIndexedDb(): Promise<IDBDatabase | null> {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return Promise.resolve(null)
    }

    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION)

        req.onupgradeneeded = (e) => {
          const db = (e.target as IDBOpenDBRequest).result
          if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
            const msgStore = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' })
            msgStore.createIndex('channelId', 'channelId', { unique: false })
            msgStore.createIndex('clientMsgId', 'clientMsgId', { unique: false })
            msgStore.createIndex('createdAt', 'createdAt', { unique: false })
          }
          if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
            db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'id' })
          }
        }

        req.onsuccess = () => resolve(req.result)
        req.onerror = () => {
          console.warn('[LocalStorageDb] IndexedDB failed to open; using localStorage fallback')
          resolve(null)
        }
      } catch (err) {
        console.warn('[LocalStorageDb] IndexedDB error', err)
        resolve(null)
      }
    })
  }

  // --- Messages API ---

  public async saveMessage(msg: StoredMessage): Promise<void> {
    const db = await this.dbPromise
    if (db) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MESSAGES, 'readwrite')
        const store = tx.objectStore(STORE_MESSAGES)
        store.put(msg)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    }

    // Fallback: localStorage
    try {
      const all = this.getLocalStorageMessages(msg.channelId)
      const idx = all.findIndex((m) => m.id === msg.id || (msg.clientMsgId && m.clientMsgId === msg.clientMsgId))
      if (idx >= 0) all[idx] = msg
      else all.push(msg)
      localStorage.setItem(`genchat_msgs_${msg.channelId}`, JSON.stringify(all))
    } catch {
      // Quota exceeded or private browsing
    }
  }

  public async saveMessages(msgs: StoredMessage[]): Promise<void> {
    const db = await this.dbPromise
    if (db && msgs.length > 0) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MESSAGES, 'readwrite')
        const store = tx.objectStore(STORE_MESSAGES)
        for (const m of msgs) {
          store.put(m)
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    }

    for (const m of msgs) {
      await this.saveMessage(m)
    }
  }

  public async getMessagesByChannel(channelId: string): Promise<StoredMessage[]> {
    const now = Date.now()
    const db = await this.dbPromise
    if (db) {
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_MESSAGES, 'readonly')
          const store = tx.objectStore(STORE_MESSAGES)
          const index = store.index('channelId')
          const req = index.getAll(channelId)
          req.onsuccess = () => {
            const list: StoredMessage[] = req.result || []
            const valid = list.filter((m) => !m.expiresAt || m.expiresAt > now)
            valid.sort((a, b) => a.createdAt - b.createdAt)
            resolve(valid)
          }
          req.onerror = () => resolve(this.getLocalStorageMessages(channelId))
        } catch {
          resolve(this.getLocalStorageMessages(channelId))
        }
      })
    }

    return this.getLocalStorageMessages(channelId)
  }

  /**
   * Permanently deletes a single message from IndexedDB and localStorage fallback.
   */
  public async deleteMessage(idOrClientMsgId: string, channelId?: string): Promise<void> {
    const db = await this.dbPromise
    if (db) {
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(STORE_MESSAGES, 'readwrite')
          const store = tx.objectStore(STORE_MESSAGES)
          store.delete(idOrClientMsgId)
          tx.oncomplete = () => resolve()
          tx.onerror = () => resolve()
        } catch {
          resolve()
        }
      })
    }

    try {
      const purgeFromKey = (key: string) => {
        const raw = localStorage.getItem(key)
        if (raw) {
          const msgs: StoredMessage[] = JSON.parse(raw)
          const remaining = msgs.filter((m) => m.id !== idOrClientMsgId && m.clientMsgId !== idOrClientMsgId)
          if (remaining.length !== msgs.length) {
            localStorage.setItem(key, JSON.stringify(remaining))
          }
        }
      }

      if (channelId) {
        purgeFromKey(`genchat_msgs_${channelId}`)
      } else {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (key && key.startsWith('genchat_msgs_')) {
            purgeFromKey(key)
          }
        }
      }
    } catch {
      // ignore
    }
  }

  /**
   * Permanently purges expired ephemeral messages from IndexedDB and localStorage.
   * Returns list of purged message IDs.
   */
  public async purgeExpiredMessages(): Promise<string[]> {
    const now = Date.now()
    const purgedIds: string[] = []

    const db = await this.dbPromise
    if (db) {
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(STORE_MESSAGES, 'readwrite')
          const store = tx.objectStore(STORE_MESSAGES)
          const cursorReq = store.openCursor()

          cursorReq.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result
            if (cursor) {
              const msg: StoredMessage = cursor.value
              if (msg.expiresAt && msg.expiresAt <= now) {
                purgedIds.push(msg.id || msg.clientMsgId)
                cursor.delete()
              }
              cursor.continue()
            } else {
              resolve()
            }
          }
          cursorReq.onerror = () => resolve()
        } catch {
          resolve()
        }
      })
    }

    // Also purge localStorage fallback
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith('genchat_msgs_')) {
          const raw = localStorage.getItem(key)
          if (raw) {
            const msgs: StoredMessage[] = JSON.parse(raw)
            const remaining = msgs.filter((m) => {
              if (m.expiresAt && m.expiresAt <= now) {
                const id = m.id || m.clientMsgId
                if (!purgedIds.includes(id)) {
                  purgedIds.push(id)
                }
                return false
              }
              return true
            })
            if (remaining.length !== msgs.length) {
              localStorage.setItem(key, JSON.stringify(remaining))
            }
          }
        }
      }
    } catch {
      // ignore
    }

    return purgedIds
  }

  public async updateMessageStatus(clientMsgIdOrId: string, status: StoredMessage['status']): Promise<void> {
    const db = await this.dbPromise
    if (db) {
      const tx = db.transaction(STORE_MESSAGES, 'readwrite')
      const store = tx.objectStore(STORE_MESSAGES)
      const req = store.get(clientMsgIdOrId)
      req.onsuccess = () => {
        if (req.result) {
          const updated = { ...req.result, status }
          store.put(updated)
        }
      }
    }
  }

  // --- Conversations API ---

  public async saveConversations(conversations: StoredConversation[]): Promise<void> {
    const db = await this.dbPromise
    if (db) {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readwrite')
      const store = tx.objectStore(STORE_CONVERSATIONS)
      for (const c of conversations) {
        store.put(c)
      }
      return
    }
    localStorage.setItem('genchat_cached_conversations', JSON.stringify(conversations))
  }

  public async getConversations(): Promise<StoredConversation[]> {
    const db = await this.dbPromise
    if (db) {
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_CONVERSATIONS, 'readonly')
          const store = tx.objectStore(STORE_CONVERSATIONS)
          const req = store.getAll()
          req.onsuccess = () => resolve(req.result || [])
          req.onerror = () => resolve(this.getLocalStorageConversations())
        } catch {
          resolve(this.getLocalStorageConversations())
        }
      })
    }
    return this.getLocalStorageConversations()
  }

  // --- Zero-Knowledge Full-Text Search ---

  public async search(query: string, channelId?: string): Promise<SearchSnippetResult[]> {
    const terms = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0)

    if (terms.length === 0) return []

    // Fetch messages to search through
    let pool: StoredMessage[] = []
    const db = await this.dbPromise

    if (db) {
      pool = await new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_MESSAGES, 'readonly')
          const store = tx.objectStore(STORE_MESSAGES)
          const req = channelId ? store.index('channelId').getAll(channelId) : store.getAll()
          req.onsuccess = () => resolve(req.result || [])
          req.onerror = () => resolve([])
        } catch {
          resolve([])
        }
      })
    } else {
      pool = this.getLocalStorageMessages(channelId)
    }

    const now = Date.now()
    pool = pool.filter((m) => !m.expiresAt || m.expiresAt > now)

    const results: SearchSnippetResult[] = []

    for (const msg of pool) {
      const text = msg.text || ''
      if (!text) continue
      const lower = text.toLowerCase()

      let matchesAll = true
      let score = 0
      const snippets: string[] = []

      for (const term of terms) {
        const isPrefix = term.endsWith('*')
        const cleanTerm = isPrefix ? term.slice(0, -1) : term
        const idx = lower.indexOf(cleanTerm)

        if (idx === -1) {
          matchesAll = false
          break
        }

        const isWordBoundary = idx === 0 || /\s|[.,!?;:]/.test(lower[idx - 1])
        score += isWordBoundary ? 10 : 5

        const snippetStart = Math.max(0, idx - 25)
        const snippetEnd = Math.min(text.length, idx + cleanTerm.length + 25)
        snippets.push('...' + text.slice(snippetStart, snippetEnd) + '...')
      }

      if (matchesAll) {
        results.push({ message: msg, score, snippets })
      }
    }

    // Sort by relevance score DESC, then by date DESC
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.message.createdAt - a.message.createdAt
    })

    return results.slice(0, 30)
  }

  // --- Helpers ---

  private getLocalStorageMessages(channelId?: string): StoredMessage[] {
    try {
      if (channelId) {
        const raw = localStorage.getItem(`genchat_msgs_${channelId}`)
        if (!raw) return []
        const msgs: StoredMessage[] = JSON.parse(raw)
        const now = Date.now()
        return msgs.filter((m) => !m.expiresAt || m.expiresAt > now)
      }
      return []
    } catch {
      return []
    }
  }

  private getLocalStorageConversations(): StoredConversation[] {
    try {
      const raw = localStorage.getItem('genchat_cached_conversations')
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  }
}

export const localDb = new LocalStorageDb()
