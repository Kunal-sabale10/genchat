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
      const all = this.getLocalStorageMessages()
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
            list.sort((a, b) => a.createdAt - b.createdAt)
            resolve(list)
          }
          req.onerror = () => resolve(this.getLocalStorageMessages(channelId))
        } catch {
          resolve(this.getLocalStorageMessages(channelId))
        }
      })
    }

    return this.getLocalStorageMessages(channelId)
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
        return raw ? JSON.parse(raw) : []
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
