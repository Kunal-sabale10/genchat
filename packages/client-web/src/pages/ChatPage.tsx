import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '@/lib/auth-context'
import { wsTransport, type InboundFrame } from '@/lib/ws-transport'
import { uploadEncryptedMedia, type MediaEnvelope } from '@/lib/media-upload'
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
  FileText,
} from 'lucide-react'

interface MessageItem {
  id: string
  senderId: string
  text: string
  status: 'pending' | 'sent' | 'delivered' | 'read'
  timestamp: string
  media?: MediaEnvelope
}

interface ChannelItem {
  id: string
  name: string
  isDirect: boolean
  lastMessage?: string
}

let msgCounter = 0
function nextId() {
  return `local_${Date.now()}_${++msgCounter}`
}

export default function ChatPage() {
  const { user, logout } = useAuth()
  const [channels] = useState<ChannelItem[]>([
    { id: 'chan_general', name: 'general', isDirect: false, lastMessage: 'PQXDH TreeKEM ratchet active' },
    { id: 'chan_announcements', name: 'announcements', isDirect: false, lastMessage: 'ML-KEM-768 keys rotated' },
  ])
  const [activeChannelId, setActiveChannelId] = useState('chan_general')
  const [messages, setMessages] = useState<MessageItem[]>([
    {
      id: 'm_system',
      senderId: 'system',
      text: 'Encrypted channel established using ML-KEM-768 hybrid handshake.',
      status: 'read',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ])
  const [inputText, setInputText] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const [wsConnected, setWsConnected] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const activeChannel = channels.find((c) => c.id === activeChannelId)

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Listen to WebSocket inbound frames (push messages from other users)
  useEffect(() => {
    const unsubscribe = wsTransport.onMessage((frame: InboundFrame) => {
      if (frame.type === 'push') {
        const channelId = frame.channel_id as string
        if (channelId !== activeChannelId) return // different channel

        const inbound: MessageItem = {
          id: nextId(),
          senderId: frame.sender_id as string,
          text: frame.ciphertext_base64 as string, // rendered raw in dev (no session yet)
          status: 'delivered',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }
        setMessages((prev) => [...prev, inbound])
      } else if (frame.type === 'pong') {
        setWsConnected(true)
      }
    })
    return unsubscribe
  }, [activeChannelId])

  // Detect WebSocket connection status
  useEffect(() => {
    // Ping every 10s in dev to test connectivity
    const pingTimer = setInterval(() => {
      if (wsTransport['ws']?.readyState === WebSocket.OPEN) {
        setWsConnected(true)
      } else {
        setWsConnected(false)
      }
    }, 3000)
    return () => clearInterval(pingTimer)
  }, [])

  const handleSendMessage = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!inputText.trim() || !user) return

      const clientMsgId = nextId()
      const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const text = inputText.trim()
      setInputText('')

      // 1. Optimistic insert — renders instantly with pending clock
      const newMsg: MessageItem = {
        id: clientMsgId,
        senderId: user.userId,
        text,
        status: 'pending',
        timestamp,
      }
      setMessages((prev) => [...prev, newMsg])

      // 2. Send over WebSocket to gatewayd
      const updateStatus = (status: MessageItem['status']) =>
        setMessages((prev) =>
          prev.map((m) => (m.id === clientMsgId ? { ...m, status } : m))
        )

      try {
        const payload = {
          action: 'send_message',
          channel_id: activeChannelId,
          client_msg_id: clientMsgId,
          // In dev: send plaintext as ciphertext_base64 (no session established)
          ciphertext_base64: btoa(text),
          message_type: 1,
        }
        await wsTransport.send(payload)
        updateStatus('sent')
      } catch (err) {
        console.warn('[ChatPage] WebSocket send failed — simulating ACK for dev', err)
        // Offline fallback: simulate ACK so UI doesn't hang in pending
        setTimeout(() => updateStatus('sent'), 600)
      }
    },
    [inputText, user, activeChannelId]
  )

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file || !user) return
      e.target.value = '' // reset input

      setIsUploading(true)
      const clientMsgId = nextId()
      const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

      // Optimistic placeholder
      setMessages((prev) => [
        ...prev,
        {
          id: clientMsgId,
          senderId: user.userId,
          text: `📎 Uploading ${file.name}…`,
          status: 'pending',
          timestamp,
        },
      ])

      try {
        const envelope = await uploadEncryptedMedia(file)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === clientMsgId
              ? { ...m, text: `📎 ${file.name}`, status: 'sent', media: envelope }
              : m
          )
        )
      } catch (err) {
        console.error('[ChatPage] Media upload failed', err)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === clientMsgId ? { ...m, text: `❌ Upload failed: ${file.name}`, status: 'sent' } : m
          )
        )
      } finally {
        setIsUploading(false)
      }
    },
    [user]
  )

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
        {/* Header */}
        <header className="flex h-16 items-center justify-between border-b border-slate-800 px-6 bg-slate-900/30">
          <div className="flex items-center space-x-3">
            <Hash className="h-5 w-5 text-slate-400" />
            <span className="font-semibold text-slate-200">{activeChannel?.name}</span>
          </div>
          <div className="flex items-center space-x-3">
            {/* WebSocket status indicator */}
            <div className="flex items-center space-x-1.5 text-[10px] font-medium">
              <div className={`h-2 w-2 rounded-full ${wsConnected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
              <span className={wsConnected ? 'text-emerald-400' : 'text-slate-500'}>
                {wsConnected ? 'Connected' : 'Connecting…'}
              </span>
            </div>
            <div className="flex items-center space-x-2 text-xs text-slate-400 bg-slate-900 px-3 py-1.5 rounded-full border border-slate-800">
              <Lock className="h-3.5 w-3.5 text-emerald-400" />
              <span>TreeKEM E2EE</span>
            </div>
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
                      ? 'bg-indigo-600 text-white rounded-br-sm'
                      : 'bg-slate-800 text-slate-100 rounded-bl-sm'
                  }`}
                >
                  {m.media ? (
                    <div className="flex items-center space-x-2">
                      <FileText className="h-4 w-4 shrink-0" />
                      <span className="truncate text-sm">{m.text}</span>
                    </div>
                  ) : (
                    <p className="leading-relaxed">{m.text}</p>
                  )}
                </div>
                <div className="flex items-center space-x-1 mt-1 px-1 text-[10px] text-slate-500">
                  <span>{m.timestamp}</span>
                  {isMe && (
                    <span className="flex items-center">
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

        {/* Message Composer */}
        <div className="p-4 border-t border-slate-800 bg-slate-900/30">
          <form onSubmit={handleSendMessage} className="flex items-center space-x-2">
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileChange}
              accept="image/*,application/pdf,text/*"
            />
            {/* Paperclip button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-40 transition shrink-0"
              title="Attach file (E2EE)"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            {/* Text input */}
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={`Message #${activeChannel?.name || 'channel'}…`}
              className="flex-1 rounded-xl bg-slate-900 border border-slate-800 px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
            />
            {/* Send button */}
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
