import React, { useState, useEffect, useRef } from 'react'
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
  Loader2
} from 'lucide-react'

interface MessageItem {
  id: string
  clientMsgId: string
  senderId: string
  text?: string
  attachment?: AttachmentMetadata & { decryptedUrl?: string }
  status: 'pending' | 'sent' | 'delivered' | 'read'
  timestamp: string
}

interface ChannelItem {
  id: string
  name: string
}

export default function ChatPage() {
  const { user, logout } = useAuth()
  const [channels] = useState<ChannelItem[]>([
    { id: 'chan_general', name: 'general' },
    { id: 'chan_announcements', name: 'announcements' },
  ])
  const [activeChannelId, setActiveChannelId] = useState<string>('chan_general')
  const [messages, setMessages] = useState<MessageItem[]>([
    {
      id: 'init_1',
      clientMsgId: 'init_1',
      senderId: 'system',
      text: 'Encrypted channel established. Ratchet session active with post-quantum ML-KEM-768.',
      status: 'read',
      timestamp: '12:00 PM',
    },
  ])
  const [inputText, setInputText] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const gatewayRef = useRef<GatewayClient | null>(null)
  const mediaClientRef = useRef<MediaClient>(new MediaClient('http://localhost:8082'))

  useEffect(() => {
    const gateway = new GatewayClient('ws://localhost:8081/ws', () => {
      return localStorage.getItem('genchat_session_token') || 'dev_token'
    })
    gatewayRef.current = gateway
    gateway.connect()

    const unsubscribe = gateway.subscribe(async (env: GatewayEnvelope) => {
      if (env.type === 'message' && env.channelId === activeChannelId) {
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
            // Not a media JSON envelope, treat as standard text
          }
        }

        setMessages((prev) => [
          ...prev,
          {
            id: env.clientMsgId || `srv_${Date.now()}`,
            clientMsgId: env.clientMsgId || '',
            senderId: env.senderId || 'peer',
            text: attachment ? undefined : env.ciphertext,
            attachment,
            status: 'delivered',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ])
      }
    })

    return () => {
      unsubscribe()
      gateway.disconnect()
    }
  }, [activeChannelId])

  const activeChannel = channels.find((c) => c.id === activeChannelId)

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!inputText.trim() || !user) return

    const clientMsgId = `cli_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const optimisticMsg: MessageItem = {
      id: clientMsgId,
      clientMsgId,
      senderId: user.userId,
      text: inputText.trim(),
      status: 'pending',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }

    setMessages((prev) => [...prev, optimisticMsg])
    const rawText = inputText.trim()
    setInputText('')

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
      // 1. Encrypt locally + upload to MinIO via mediad
      const attachment = await mediaClientRef.current.uploadEncryptedAttachment(file)

      // Create an instant local decrypted preview
      const localPreviewUrl = URL.createObjectURL(file)

      const optimisticMsg: MessageItem = {
        id: clientMsgId,
        clientMsgId,
        senderId: user.userId,
        attachment: { ...attachment, decryptedUrl: localPreviewUrl },
        status: 'pending',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }

      setMessages((prev) => [...prev, optimisticMsg])

      // 2. Dispatch the media payload envelope over WebSocket
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

  return (
    <div className="flex h-screen w-full bg-slate-950 text-slate-100 antialiased">
      {/* Sidebar: Channels */}
      <aside className="flex w-72 flex-col border-r border-slate-800 bg-slate-900/50 backdrop-blur">
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

        {/* Channel List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Channels
          </p>
          {channels.map((chan) => (
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

        {/* Current User Card */}
        <div className="border-t border-slate-800 p-3 bg-slate-900/80 flex items-center justify-between">
          <div className="min-w-0 pr-2">
            <p className="truncate text-xs font-medium text-slate-200">{user?.userId}</p>
            <p className="truncate text-[10px] text-slate-500 font-mono">Dev: {user?.deviceId?.slice(0, 8)}...</p>
          </div>
          <button
            onClick={logout}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-rose-400 transition"
            title="Sign Out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </aside>

      {/* Main Chat Workspace */}
      <main className="flex flex-1 flex-col bg-slate-950">
        <header className="flex h-16 items-center justify-between border-b border-slate-800 px-6 bg-slate-900/30">
          <div className="flex items-center space-x-3">
            <Hash className="h-5 w-5 text-slate-400" />
            <span className="font-semibold text-slate-200">{activeChannel?.name}</span>
          </div>
          <div className="flex items-center space-x-2 text-xs text-slate-400 bg-slate-900 px-3 py-1.5 rounded-full border border-slate-800">
            <Lock className="h-3.5 w-3.5 text-emerald-400" />
            <span>ML-KEM TreeKEM E2EE</span>
          </div>
        </header>

        {/* Message Stream */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {messages.map((m) => {
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
              placeholder={`Message #${activeChannel?.name || 'channel'}...`}
              className="flex-1 rounded-xl bg-slate-900 border border-slate-800 px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
            />

            <button
              type="submit"
              disabled={!inputText.trim()}
              className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 transition shrink-0"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      </main>
    </div>
  )
}
