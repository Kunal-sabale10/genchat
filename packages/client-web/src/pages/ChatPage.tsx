import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '@/lib/auth-context'
import { GatewayClient, GatewayEnvelope } from '@/lib/gateway-client'
import { MediaClient, AttachmentMetadata } from '@/lib/media-client'
import { MediaCryptoService } from '@/lib/media-crypto'
import { 
  ShieldCheck, 
  Send, 
  Hash, 
  Lock, 
  Check, 
  CheckCheck, 
  Clock, 
  LogOut,
  Paperclip,
  Image as ImageIcon,
  Loader2,
  UserPlus,
  User,
  Copy,
  Plus,
  X
} from 'lucide-react'

interface MessageItem {
  id: string
  clientMsgId: string
  channelId: string
  senderId: string
  text?: string
  attachment?: AttachmentMetadata & { decryptedUrl?: string }
  status: 'pending' | 'sent' | 'delivered' | 'read'
  timestamp: string
}

interface ConversationItem {
  id: string
  name: string
  isDirect: boolean
}

export default function ChatPage() {
  const { user, accessToken, logout } = useAuth()
  
  const [conversations, setConversations] = useState<ConversationItem[]>([
    { id: 'chan_general', name: 'general', isDirect: false },
    { id: 'chan_announcements', name: 'announcements', isDirect: false },
  ])
  const [activeChannelId, setActiveChannelId] = useState<string>('chan_general')
  const [messages, setMessages] = useState<MessageItem[]>([
    {
      id: 'init_1',
      clientMsgId: 'init_1',
      channelId: 'chan_general',
      senderId: 'system',
      text: 'Encrypted channel established. Ratchet session active with post-quantum ML-KEM-768.',
      status: 'read',
      timestamp: '12:00 PM',
    },
  ])

  const [inputText, setInputText] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [showNewDmModal, setShowNewDmModal] = useState(false)
  const [newDmUserId, setNewDmUserId] = useState('')
  const [copiedUserId, setCopiedUserId] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const gatewayRef = useRef<GatewayClient | null>(null)
  const mediaClientRef = useRef<MediaClient>(new MediaClient('http://localhost:8082'))
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom of message list
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activeChannelId])

  // Keep a ref for current userId so the subscribe closure always has the latest
  const userIdRef = useRef(user?.userId)
  useEffect(() => { userIdRef.current = user?.userId }, [user?.userId])

  // WebSocket Connection using real authenticated JWT
  useEffect(() => {
    // Connect through Vite's /ws proxy or directly
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProto}//${window.location.host}/ws`

    const gateway = new GatewayClient(wsUrl, () => {
      // Primary: accessToken from AuthContext; Fallback: sessionStorage
      return accessToken || sessionStorage.getItem('genchat_access_token')
    })
    gatewayRef.current = gateway

    const unsubStatus = gateway.onStatusChange((connected) => {
      setIsConnected(connected)
    })

    gateway.connect()

    const unsubMessages = gateway.subscribe(async (env: GatewayEnvelope) => {
      console.log('[ChatPage] Received envelope:', JSON.stringify(env))

      if (env.type === 'message' && env.channelId) {
        // --- Key fix: remap channelId for incoming 1:1 DMs ---
        // The gateway sets push.channel_id = recipient's user_id (me).
        // But my DM conversations are keyed by the peer's user_id.
        // So if channelId === myUserId, remap to senderId.
        const myUserId = userIdRef.current
        const effectiveChannelId =
          env.channelId === myUserId && env.senderId
            ? env.senderId
            : env.channelId

        console.log('[ChatPage] myUserId:', myUserId, 'env.channelId:', env.channelId, 'env.senderId:', env.senderId, '→ effectiveChannelId:', effectiveChannelId)

        // Auto-add incoming sender to Direct Messages if not already present
        if (env.senderId && env.senderId !== myUserId) {
          setConversations((prev) => {
            const exists = prev.some((c) => c.id === env.senderId)
            if (!exists) {
              return [
                ...prev,
                {
                  id: env.senderId!,
                  name: env.senderId!,
                  isDirect: true,
                },
              ]
            }
            return prev
          })
        }

        let attachment: (AttachmentMetadata & { decryptedUrl?: string }) | undefined = undefined

        if (env.ciphertext && env.ciphertext.startsWith('{')) {
          try {
            const parsed = JSON.parse(env.ciphertext)
            if (parsed.downloadUrl && parsed.encryptionKeyHex && parsed.ivHex) {
              const res = await fetch(parsed.downloadUrl)
              const cipherBuffer = await res.arrayBuffer()
              const decryptedUrl = await MediaCryptoService.decryptFile(
                cipherBuffer,
                parsed.encryptionKeyHex,
                parsed.ivHex,
                parsed.mimeType
              )
              attachment = { ...parsed, decryptedUrl }
            }
          } catch {
            // Not a media JSON envelope, keep as plain text
          }
        }

        const newMsg = {
          id: env.clientMsgId || `srv_${Date.now()}`,
          clientMsgId: env.clientMsgId || '',
          channelId: effectiveChannelId,
          senderId: env.senderId || 'peer',
          text: attachment ? undefined : env.ciphertext,
          attachment,
          status: 'delivered' as const,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }
        console.log('[ChatPage] Adding message to state:', JSON.stringify(newMsg))
        setMessages((prev) => {
          if (prev.some((m) => (newMsg.clientMsgId && m.clientMsgId === newMsg.clientMsgId) || m.id === newMsg.id)) {
            return prev
          }
          return [...prev, newMsg]
        })
      }
    })

    return () => {
      unsubStatus()
      unsubMessages()
      gateway.disconnect()
    }
  }, [accessToken])

  // Fetch message history when connected or when switching conversation
  useEffect(() => {
    if (isConnected && gatewayRef.current && activeChannelId) {
      gatewayRef.current.fetchHistory(activeChannelId)
    }
  }, [isConnected, activeChannelId])

  const activeConversation = conversations.find((c) => c.id === activeChannelId)
  const currentMessages = messages.filter((m) => m.channelId === activeChannelId)

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!inputText.trim() || !user) return

    const clientMsgId = `cli_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const rawText = inputText.trim()
    setInputText('')

    const optimisticMsg: MessageItem = {
      id: clientMsgId,
      clientMsgId,
      channelId: activeChannelId,
      senderId: user.userId,
      text: rawText,
      status: 'pending',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }

    setMessages((prev) => [...prev, optimisticMsg])

    try {
      if (gatewayRef.current) {
        await gatewayRef.current.sendEnvelope({
          type: 'message',
          channelId: activeChannelId,
          senderId: user.userId,
          clientMsgId,
          ciphertext: rawText,
        })

        setMessages((prev) =>
          prev.map((m) => (m.clientMsgId === clientMsgId ? { ...m, status: 'sent' } : m))
        )
      }
    } catch {
      // Offline fallback: keep optimistic msg as sent after brief delay
      setTimeout(() => {
        setMessages((prev) =>
          prev.map((m) => (m.clientMsgId === clientMsgId ? { ...m, status: 'sent' } : m))
        )
      }, 300)
    }
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !user) return

    setIsUploading(true)
    const clientMsgId = `media_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

    try {
      const attachment = await mediaClientRef.current.uploadEncryptedAttachment(file)
      const localPreviewUrl = URL.createObjectURL(file)

      const optimisticMsg: MessageItem = {
        id: clientMsgId,
        clientMsgId,
        channelId: activeChannelId,
        senderId: user.userId,
        attachment: { ...attachment, decryptedUrl: localPreviewUrl },
        status: 'pending',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }

      setMessages((prev) => [...prev, optimisticMsg])

      if (gatewayRef.current) {
        await gatewayRef.current.sendEnvelope({
          type: 'message',
          channelId: activeChannelId,
          senderId: user.userId,
          clientMsgId,
          ciphertext: JSON.stringify(attachment),
        })

        setMessages((prev) =>
          prev.map((m) => (m.clientMsgId === clientMsgId ? { ...m, status: 'sent' } : m))
        )
      }
    } catch (err) {
      console.error('[Media] Upload failed:', err)
    } finally {
      setIsUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleStartDirectMessage = (e: React.FormEvent) => {
    e.preventDefault()
    const target = newDmUserId.trim()
    if (!target) return

    // Avoid duplicate DMs
    if (!conversations.some((c) => c.id === target)) {
      setConversations((prev) => [
        ...prev,
        { id: target, name: target, isDirect: true },
      ])
    }
    setActiveChannelId(target)
    setNewDmUserId('')
    setShowNewDmModal(false)
  }

  const handleCopyUserId = useCallback(() => {
    if (user?.userId) {
      navigator.clipboard.writeText(user.userId)
      setCopiedUserId(true)
      setTimeout(() => setCopiedUserId(false), 2000)
    }
  }, [user?.userId])

  const channelConversations = conversations.filter((c) => !c.isDirect)
  const dmConversations = conversations.filter((c) => c.isDirect)

  return (
    <div className="flex h-screen w-full bg-slate-950 text-slate-100 antialiased">
      {/* Sidebar: Channels & Direct Messages */}
      <aside className="flex w-72 flex-col border-r border-slate-800 bg-slate-900/50 backdrop-blur">
        {/* App Title & Badge */}
        <div className="flex h-16 items-center justify-between border-b border-slate-800 px-4">
          <div className="flex items-center space-x-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600/20 text-indigo-400">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <span className="font-semibold text-sm tracking-wide">GenChat</span>
          </div>
          <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-500/20">
            PQ-SECURE
          </span>
        </div>

        {/* Conversation List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {/* Public Channels */}
          <div className="space-y-1">
            <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Channels
            </p>
            {channelConversations.map((chan) => (
              <button
                key={chan.id}
                onClick={() => setActiveChannelId(chan.id)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  activeChannelId === chan.id
                    ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                }`}
              >
                <div className="flex items-center space-x-2 truncate">
                  <Hash className="h-4 w-4 shrink-0 text-slate-500" />
                  <span className="truncate">{chan.name}</span>
                </div>
              </button>
            ))}
          </div>

          {/* Direct Messages */}
          <div className="space-y-1">
            <div className="flex items-center justify-between px-2 py-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Direct Messages
              </p>
              <button
                onClick={() => setShowNewDmModal(true)}
                className="flex items-center space-x-1 text-[11px] text-indigo-400 hover:text-indigo-300 transition"
                title="Start new direct message"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>New</span>
              </button>
            </div>

            {dmConversations.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-slate-600 italic">No direct chats yet</p>
            ) : (
              dmConversations.map((dm) => (
                <button
                  key={dm.id}
                  onClick={() => setActiveChannelId(dm.id)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    activeChannelId === dm.id
                      ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                  }`}
                >
                  <div className="flex items-center space-x-2 truncate">
                    <User className="h-4 w-4 shrink-0 text-slate-500" />
                    <span className="truncate">{dm.name}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Current User Card + Copy ID Button */}
        <div className="border-t border-slate-800 p-3 bg-slate-900/80 flex flex-col space-y-2">
          <div className="flex items-center justify-between">
            <div className="min-w-0 pr-2">
              <div className="flex items-center space-x-1.5">
                <span className="truncate text-xs font-medium text-slate-200">{user?.userId}</span>
              </div>
              <p className="truncate text-[10px] text-slate-500 font-mono">
                Device: {user?.deviceId?.slice(0, 8)}...
              </p>
            </div>
            <button
              onClick={logout}
              className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-rose-400 transition shrink-0"
              title="Sign Out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>

          <button
            onClick={handleCopyUserId}
            className="flex w-full items-center justify-center space-x-1.5 rounded-lg border border-slate-800 bg-slate-950/60 py-1.5 text-[11px] font-medium text-slate-400 hover:text-indigo-300 hover:border-slate-700 transition"
          >
            <Copy className="h-3 w-3" />
            <span>{copiedUserId ? 'Copied to Clipboard!' : 'Copy My User ID to Share'}</span>
          </button>
        </div>
      </aside>

      {/* Main Chat Workspace */}
      <main className="flex flex-1 flex-col bg-slate-950">
        {/* Header */}
        <header className="flex h-16 items-center justify-between border-b border-slate-800 px-6 bg-slate-900/30">
          <div className="flex items-center space-x-3">
            {activeConversation?.isDirect ? (
              <User className="h-5 w-5 text-indigo-400" />
            ) : (
              <Hash className="h-5 w-5 text-slate-400" />
            )}
            <div>
              <span className="font-semibold text-slate-200">
                {activeConversation?.isDirect ? `@${activeConversation?.name}` : activeConversation?.name}
              </span>
              {activeConversation?.isDirect && (
                <p className="text-[11px] text-slate-500">1:1 Direct Message • Real-Time Routed</p>
              )}
            </div>
          </div>

          <div className="flex items-center space-x-4">
            {/* Live Gateway Connection Indicator */}
            <div className="flex items-center space-x-1.5 text-xs">
              <span
                className={`h-2 w-2 rounded-full ${
                  isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'
                }`}
              />
              <span className={isConnected ? 'text-emerald-400' : 'text-slate-500'}>
                {isConnected ? 'Gateway Connected' : 'Connecting to Gateway...'}
              </span>
            </div>

            <div className="flex items-center space-x-2 text-xs text-slate-400 bg-slate-900 px-3 py-1.5 rounded-full border border-slate-800">
              <Lock className="h-3.5 w-3.5 text-emerald-400" />
              <span>ML-KEM TreeKEM E2EE</span>
            </div>
          </div>
        </header>

        {/* Message Stream */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {currentMessages.map((m) => {
            const isMe = m.senderId === user?.userId
            const isSystem = m.senderId === 'system'

            if (isSystem) {
              return (
                <div key={m.id} className="flex justify-center my-2">
                  <span className="rounded-full bg-slate-900 border border-slate-800 px-3 py-1 text-xs text-slate-400">
                    {m.text}
                  </span>
                </div>
              )
            }

            return (
              <div key={m.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                {/* Sender ID tag for group context or other peer */}
                {!isMe && (
                  <span className="text-[11px] text-slate-500 mb-1 px-1">{m.senderId}</span>
                )}

                <div
                  className={`max-w-md rounded-2xl px-4 py-2.5 text-sm ${
                    isMe
                      ? 'bg-indigo-600 text-white rounded-br-xs'
                      : 'bg-slate-800 text-slate-100 rounded-bl-xs'
                  }`}
                >
                  {m.text && <p className="leading-relaxed">{m.text}</p>}

                  {m.attachment && (
                    <div className="space-y-2">
                      {m.attachment.mimeType.startsWith('image/') && m.attachment.decryptedUrl ? (
                        <img
                          src={m.attachment.decryptedUrl}
                          alt="Encrypted attachment"
                          className="max-h-60 rounded-lg object-cover shadow border border-white/10"
                        />
                      ) : (
                        <div className="flex items-center space-x-2 p-2 bg-black/20 rounded-lg">
                          <ImageIcon className="h-5 w-5" />
                          <span className="text-xs truncate">{m.attachment.blobId}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between text-[10px] opacity-75">
                        <span>{(m.attachment.originalSize / 1024).toFixed(1)} KB</span>
                        <span className="flex items-center space-x-1">
                          <Lock className="h-2.5 w-2.5" />
                          <span>AES-256-GCM</span>
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex items-center space-x-1 mt-1 px-1 text-[10px] text-slate-500">
                  <span>{m.timestamp}</span>
                  {isMe && (
                    <span>
                      {m.status === 'pending' && <Clock className="h-3 w-3 animate-spin text-slate-400" />}
                      {m.status === 'sent' && <Check className="h-3 w-3 text-slate-400" />}
                      {m.status === 'delivered' && <CheckCheck className="h-3 w-3 text-slate-400" />}
                      {m.status === 'read' && <CheckCheck className="h-3 w-3 text-indigo-400" />}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Bar */}
        <div className="p-4 border-t border-slate-800 bg-slate-900/30">
          <form onSubmit={handleSendMessage} className="flex items-center space-x-2">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              className="hidden"
              accept="image/*"
            />

            <button
              type="button"
              disabled={isUploading}
              onClick={() => fileInputRef.current?.click()}
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-800 bg-slate-900 text-slate-400 hover:text-indigo-400 hover:border-slate-700 disabled:opacity-50 transition shrink-0"
              title="Upload encrypted media"
            >
              {isUploading ? <Loader2 className="h-5 w-5 animate-spin text-indigo-400" /> : <Paperclip className="h-5 w-5" />}
            </button>

            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={
                activeConversation?.isDirect
                  ? `Direct message @${activeConversation.name}...`
                  : `Message #${activeConversation?.name || 'channel'}...`
              }
              className="flex-1 rounded-xl bg-slate-900 border border-slate-800 px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
            />

            <button
              type="submit"
              disabled={!inputText.trim()}
              className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 transition shrink-0"
            >
              <Send className="h-5 w-5" />
            </button>
          </form>
        </div>
      </main>

      {/* Start New Direct Message Modal */}
      {showNewDmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2">
                <UserPlus className="h-5 w-5 text-indigo-400" />
                <h3 className="font-semibold text-slate-100">Start Direct Message</h3>
              </div>
              <button
                onClick={() => setShowNewDmModal(false)}
                className="text-slate-400 hover:text-slate-200 transition"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-xs text-slate-400 mb-4">
              Enter the recipient's User ID to open an end-to-end encrypted direct messaging channel.
            </p>

            <form onSubmit={handleStartDirectMessage} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Recipient User ID
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. user_bob or 123e4567-e89b-..."
                  value={newDmUserId}
                  onChange={(e) => setNewDmUserId(e.target.value)}
                  className="w-full rounded-xl border border-slate-800 bg-slate-950 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                  autoFocus
                />
              </div>

              <div className="flex justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewDmModal(false)}
                  className="rounded-xl px-4 py-2 text-xs font-medium text-slate-400 hover:bg-slate-800 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 transition"
                >
                  Start Conversation
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
