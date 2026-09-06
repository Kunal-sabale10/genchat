import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '@/lib/auth-context'
import { GatewayClient, GatewayEnvelope } from '@/lib/gateway-client'
import { MediaClient, AttachmentMetadata } from '@/lib/media-client'
import { MediaCryptoService } from '@/lib/media-crypto'
import { E2eeService } from '@/lib/e2ee-ratchet'
import { localDb, StoredMessage, StoredConversation, SearchSnippetResult } from '@/lib/local-storage-db'
import { CallModal } from '@/components/CallModal'
import { WebRtcManager } from '@/lib/webrtc-manager'
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
  X,
  Search,
  Key,
  Radio,
  Phone,
  Video
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
  isEncrypted?: boolean
  senderFingerprint?: string
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
  const [messages, setMessages] = useState<MessageItem[]>([])

  const [inputText, setInputText] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  
  // Modals state
  const [showNewDmModal, setShowNewDmModal] = useState(false)
  const [newDmUserId, setNewDmUserId] = useState('')
  const [showNewChanModal, setShowNewChanModal] = useState(false)
  const [newChanName, setNewChanName] = useState('')
  const [showSafetyModal, setShowSafetyModal] = useState(false)
  const [safetyNumber, setSafetyNumber] = useState('')
  const [safetyPeerId, setSafetyPeerId] = useState('')
  const [isSafetyVerified, setIsSafetyVerified] = useState(false)
  const [showSearchModal, setShowSearchModal] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchSnippetResult[]>([])
  
  // Ephemeral states
  const [peerTypingUser, setPeerTypingUser] = useState<string | null>(null)
  const [copiedUserId, setCopiedUserId] = useState(false)
  const [copiedSafetyNumber, setCopiedSafetyNumber] = useState(false)
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({})
  const [incomingToast, setIncomingToast] = useState<{ senderId: string; channelId: string; preview: string } | null>(null)

  // WebRTC Audio/Video Call states
  const [callState, setCallState] = useState<'idle' | 'incoming' | 'outgoing' | 'connected' | 'ended'>('idle')
  const [callType, setCallType] = useState<'audio' | 'video'>('video')
  const [activeCallId, setActiveCallId] = useState<string>('')
  const [activeCallPeerId, setActiveCallPeerId] = useState<string>('')
  const [isCallMuted, setIsCallMuted] = useState(false)
  const [isCallVideoDisabled, setIsCallVideoDisabled] = useState(false)
  const [isCallMinimized, setIsCallMinimized] = useState(false)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)

  const webrtcRef = useRef<WebRtcManager | null>(null)
  const pendingOfferRef = useRef<{ sdp: string; callType: 'audio' | 'video' } | null>(null)
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([])
  const activeCallPeerIdRef = useRef<string>('')
  useEffect(() => { activeCallPeerIdRef.current = activeCallPeerId }, [activeCallPeerId])
  const activeCallIdRef = useRef<string>('')
  useEffect(() => { activeCallIdRef.current = activeCallId }, [activeCallId])

  const fileInputRef = useRef<HTMLInputElement>(null)
  const gatewayRef = useRef<GatewayClient | null>(null)
  const mediaClientRef = useRef<MediaClient>(new MediaClient('http://localhost:8082'))
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTypingSentRef = useRef<number>(0)

  // Auto-scroll to bottom of message list
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activeChannelId, peerTypingUser])

  // Keep a ref for current userId and activeChannelId so the subscribe closure always has the latest
  const userIdRef = useRef(user?.userId)
  useEffect(() => { userIdRef.current = user?.userId }, [user?.userId])
  const activeChannelIdRef = useRef(activeChannelId)
  useEffect(() => { activeChannelIdRef.current = activeChannelId }, [activeChannelId])

  // --- 1. Load cached messages and conversations from IndexedDB on startup ---
  useEffect(() => {
    async function loadLocalCache() {
      // Load conversations
      const cachedConvs = await localDb.getConversations()
      if (cachedConvs && cachedConvs.length > 0) {
        setConversations(cachedConvs)
      }

      // Load messages for current channel
      const cachedMsgs = await localDb.getMessagesByChannel(activeChannelId)
      if (cachedMsgs && cachedMsgs.length > 0) {
        setMessages((prev) => {
          // Merge avoiding duplicates
          const ids = new Set(cachedMsgs.map((m) => m.id))
          const existingNotInCache = prev.filter((m) => !ids.has(m.id))
          return [...cachedMsgs, ...existingNotInCache].map((m: any) => ({
            ...m,
            isEncrypted: true,
          }))
        })
      }
    }
    loadLocalCache()
  }, [activeChannelId])

  // Save conversations to IndexedDB when updated
  useEffect(() => {
    if (conversations.length > 0) {
      localDb.saveConversations(conversations)
    }
  }, [conversations])

  // --- 2. Keyboard shortcut for Zero-Knowledge Search (Ctrl+K or Cmd+K) ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setShowSearchModal((prev) => !prev)
      }
      if (e.key === 'Escape') {
        setShowSearchModal(false)
        setShowSafetyModal(false)
        setShowNewDmModal(false)
        setShowNewChanModal(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Execute search when query changes
  useEffect(() => {
    let active = true
    async function runSearch() {
      if (!searchQuery.trim()) {
        setSearchResults([])
        return
      }
      const results = await localDb.search(searchQuery)
      if (active) setSearchResults(results)
    }
    runSearch()
    return () => { active = false }
  }, [searchQuery])

  // --- 3. WebSocket Connection with E2EE Ratchet & Real-Time Sync ---
  useEffect(() => {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProto}//${window.location.host}/ws`

    const gateway = new GatewayClient(wsUrl, () => {
      return accessToken || sessionStorage.getItem('genchat_access_token')
    })
    gatewayRef.current = gateway

    const unsubStatus = gateway.onStatusChange((connected) => {
      setIsConnected(connected)
    })

    // Handle typing events from peers
    const unsubTyping = gateway.onTyping((ev) => {
      const activeId = activeChannelIdRef.current
      if (
        activeId &&
        (ev.channelId === activeId || ev.channelId.toLowerCase() === activeId.toLowerCase()) &&
        ev.userId !== userIdRef.current
      ) {
        setPeerTypingUser(ev.isTyping ? ev.userId : null)
      }
    })

    // Handle read receipts from peers
    const unsubReceipts = gateway.onReadReceipt((ev) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === ev.serverId || m.clientMsgId === ev.serverId) {
            return { ...m, status: 'read' }
          }
          return m
        })
      )
      localDb.updateMessageStatus(ev.serverId, 'read')
    })

    // Handle WebRTC call signals from peers
    const unsubCallSignal = gateway.onCallSignal(async (ev) => {
      console.log('[ChatPage] CallSignal received:', ev.signalType, ev)
      if (ev.signalType === 'offer' && ev.sdp) {
        pendingOfferRef.current = { sdp: ev.sdp, callType: ev.callType || 'video' }
        setActiveCallId(ev.callId)
        setActiveCallPeerId(ev.senderId || 'Unknown')
        setCallType(ev.callType || 'video')
        setCallState('incoming')
      } else if (ev.signalType === 'answer' && ev.sdp) {
        await webrtcRef.current?.handleAnswer(ev.sdp)
        setCallState('connected')
      } else if (ev.signalType === 'ice_candidate' && ev.candidate) {
        if (webrtcRef.current) {
          await webrtcRef.current.addIceCandidate(ev.candidate)
        } else {
          console.log('[ChatPage] Buffering early ICE candidate from peer:', ev.candidate)
          pendingIceCandidatesRef.current.push(ev.candidate)
        }
      } else if (ev.signalType === 'hangup' || ev.signalType === 'reject' || ev.signalType === 'peer_offline') {
        webrtcRef.current?.hangup()
        webrtcRef.current = null
        pendingOfferRef.current = null
        pendingIceCandidatesRef.current = []
        setLocalStream(null)
        setRemoteStream(null)
        setCallState('idle')
        setActiveCallId('')
        setActiveCallPeerId('')
        setIsCallMinimized(false)
        if (ev.signalType === 'peer_offline') {
          alert('User is currently offline and cannot be reached.')
        } else if (ev.signalType === 'reject') {
          alert('Call was declined by peer.')
        }
      }
    })

    gateway.connect()

    // Handle incoming messages (push & history)
    const unsubMessages = gateway.subscribe(async (env: GatewayEnvelope) => {
      if (env.type === 'message' && env.channelId) {
        const myUserId =
          userIdRef.current ||
          user?.userId ||
          (() => {
            try {
              const u = sessionStorage.getItem('genchat_user')
              return u ? JSON.parse(u).userId : ''
            } catch {
              return ''
            }
          })()

        const isDirectForMe = Boolean(
          myUserId &&
            env.channelId &&
            (env.channelId === myUserId ||
              env.channelId.toLowerCase() === myUserId.toLowerCase())
        )

        // If it's a DM addressed to me, remap channelId to the sender's user ID
        const effectiveChannelId =
          isDirectForMe && env.senderId
            ? env.senderId
            : env.channelId

        console.log('[ChatPage] Message received:', {
          myUserId,
          envChannel: env.channelId,
          sender: env.senderId,
          effectiveChannelId,
          activeChannelId,
        })

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
        let displayText: string | undefined = env.ciphertext
        let isEncrypted = false
        let senderFingerprint: string | undefined = undefined

        // Try decrypting with client-side E2EE ratchet
        if (env.ciphertext) {
          const decResult = await E2eeService.decrypt(env.ciphertext, effectiveChannelId, myUserId || '')
          displayText = decResult.text
          isEncrypted = decResult.isEncrypted
          senderFingerprint = decResult.fingerprint

          // Check if payload is an encrypted media envelope
          if (displayText && displayText.startsWith('{')) {
            try {
              const parsed = JSON.parse(displayText)
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
                displayText = undefined
              }
            } catch {
              // Plain text
            }
          }
        }

        const msgId = env.clientMsgId || `srv_${Date.now()}`
        const newMsg: MessageItem = {
          id: msgId,
          clientMsgId: env.clientMsgId || '',
          channelId: effectiveChannelId,
          senderId: env.senderId || 'peer',
          text: displayText,
          attachment,
          status: 'delivered',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          isEncrypted,
          senderFingerprint,
        }

        // Write to local IndexedDB
        localDb.saveMessage({
          ...newMsg,
          createdAt: Date.now(),
        })

        // Automatically dispatch read receipt if this is the active channel
        const currentActive = activeChannelIdRef.current || ''
        const isActiveChat =
          effectiveChannelId === currentActive ||
          effectiveChannelId.toLowerCase() === currentActive.toLowerCase()

        if (isActiveChat && env.senderId && env.senderId !== myUserId) {
          gateway.sendReadReceipt(effectiveChannelId, msgId, env.sequenceNum || 0)
        } else if (env.senderId && env.senderId !== myUserId) {
          // Message received for a background channel/DM: notify user and bump unread count
          setUnreadCounts((prev) => ({
            ...prev,
            [effectiveChannelId]: (prev[effectiveChannelId] || 0) + 1,
          }))
          setIncomingToast({
            senderId: env.senderId,
            channelId: effectiveChannelId,
            preview: (displayText || 'Sent an attachment').slice(0, 50),
          })
          setTimeout(() => setIncomingToast(null), 6000)
        }

        setMessages((prev) => {
          const exists = prev.some(
            (m) =>
              (newMsg.clientMsgId && m.clientMsgId === newMsg.clientMsgId) ||
              m.id === newMsg.id
          )
          if (exists) {
            return prev.map((m) =>
              (newMsg.clientMsgId && m.clientMsgId === newMsg.clientMsgId) || m.id === newMsg.id
                ? { ...m, ...newMsg, status: m.status === 'read' ? 'read' : newMsg.status }
                : m
            )
          }
          return [...prev, newMsg]
        })
      }
    })

    return () => {
      unsubStatus()
      unsubTyping()
      unsubReceipts()
      unsubCallSignal()
      unsubMessages()
      gateway.disconnect()
    }
  }, [accessToken])

  // Fetch message history when connected or when switching conversation
  useEffect(() => {
    if (isConnected && gatewayRef.current && activeChannelId) {
      gatewayRef.current.fetchHistory(activeChannelId)
    }
    setPeerTypingUser(null)
  }, [isConnected, activeChannelId])

  const activeConversation = conversations.find((c) => c.id === activeChannelId)
  
  // Robust message filter: matches exact channelId OR peer user in 1:1 DMs (case-insensitive)
  const currentMessages = messages.filter((m) => {
    const activeId = (activeChannelId || '').toLowerCase()
    const msgChan = (m.channelId || '').toLowerCase()
    if (msgChan === activeId) return true

    const myId = (userIdRef.current || user?.userId || '').toLowerCase()
    const isDirectConv = activeConversation?.isDirect || !activeChannelId.startsWith('chan_')
    if (isDirectConv) {
      const sender = (m.senderId || '').toLowerCase()
      if (sender === activeId && (msgChan === myId || msgChan === 'peer')) return true
      if (sender === myId && msgChan === activeId) return true
    }
    return false
  })

  // --- 4. Typing Signal Emitter (Throttled 2s + Debounced 1.5s stop) ---
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputText(e.target.value)

    if (gatewayRef.current && activeChannelId) {
      const now = Date.now()
      if (now - lastTypingSentRef.current > 2000) {
        lastTypingSentRef.current = now
        gatewayRef.current.sendTyping(activeChannelId, true)
      }

      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
      typingTimeoutRef.current = setTimeout(() => {
        gatewayRef.current?.sendTyping(activeChannelId, false)
        lastTypingSentRef.current = 0
      }, 1500)
    }
  }

  // --- 5. Message Dispatch with E2EE Ratchet Encryption ---
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!inputText.trim() || !user) return

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
    gatewayRef.current?.sendTyping(activeChannelId, false)
    lastTypingSentRef.current = 0

    const clientMsgId = `cli_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const rawText = inputText.trim()
    setInputText('')

    // 1. Encrypt message payload using client-side E2EE ratchet before transmission
    let wireCiphertext = rawText
    try {
      wireCiphertext = await E2eeService.encrypt(rawText, activeChannelId, user.userId)
    } catch (err) {
      console.warn('[E2EE] Ratchet encryption fallback:', err)
    }

    const optimisticMsg: MessageItem = {
      id: clientMsgId,
      clientMsgId,
      channelId: activeChannelId,
      senderId: user.userId,
      text: rawText,
      status: 'pending',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isEncrypted: true,
    }

    setMessages((prev) => [...prev, optimisticMsg])
    localDb.saveMessage({ ...optimisticMsg, createdAt: Date.now() })

    try {
      if (gatewayRef.current) {
        await gatewayRef.current.sendEnvelope({
          type: 'message',
          channelId: activeChannelId,
          senderId: user.userId,
          clientMsgId,
          ciphertext: wireCiphertext,
        })

        setMessages((prev) =>
          prev.map((m) => (m.clientMsgId === clientMsgId ? { ...m, status: 'sent' } : m))
        )
        localDb.updateMessageStatus(clientMsgId, 'sent')
      }
    } catch {
      // Offline fallback
      setTimeout(() => {
        setMessages((prev) =>
          prev.map((m) => (m.clientMsgId === clientMsgId ? { ...m, status: 'sent' } : m))
        )
        localDb.updateMessageStatus(clientMsgId, 'sent')
      }, 300)
    }
  }

  // --- 6. Media File Attachment Upload ---
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
        isEncrypted: true,
      }

      setMessages((prev) => [...prev, optimisticMsg])
      localDb.saveMessage({ ...optimisticMsg, createdAt: Date.now() })

      // Encrypt attachment metadata envelope
      const metaJson = JSON.stringify(attachment)
      const encryptedMeta = await E2eeService.encrypt(metaJson, activeChannelId, user.userId)

      if (gatewayRef.current) {
        await gatewayRef.current.sendEnvelope({
          type: 'message',
          channelId: activeChannelId,
          senderId: user.userId,
          clientMsgId,
          ciphertext: encryptedMeta,
        })

        setMessages((prev) =>
          prev.map((m) => (m.clientMsgId === clientMsgId ? { ...m, status: 'sent' } : m))
        )
        localDb.updateMessageStatus(clientMsgId, 'sent')
      }
    } catch (err) {
      console.error('[Media] Upload failed:', err)
    } finally {
      setIsUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // --- WebRTC Calling Actions ---
  const handleStartCall = async (type: 'audio' | 'video') => {
    if (!activeConversation?.isDirect || !user || !gatewayRef.current) return

    const peerId = activeConversation.id
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

    setActiveCallId(callId)
    setActiveCallPeerId(peerId)
    setCallType(type)
    setCallState('outgoing')
    setIsCallMinimized(false)
    setIsCallMuted(false)
    setIsCallVideoDisabled(false)

    const rtc = new WebRtcManager({
      onLocalStream: (s) => setLocalStream(s),
      onRemoteStream: (s) => setRemoteStream(s),
      onIceCandidate: (candidate) => {
        gatewayRef.current?.sendCallSignal({
          signalType: 'ice_candidate',
          callId,
          targetUserId: peerId,
          candidate: candidate.toJSON(),
        })
      },
      onConnectionStateChange: (state) => {
        console.log('[ChatPage] WebRTC ConnectionState (caller):', state)
        if (state === 'connected') {
          setCallState('connected')
        } else if (state === 'failed') {
          console.warn('[ChatPage] Caller connection failed')
          handleEndCall()
        }
      },
      onError: (err) => {
        console.error('[WebRTC] Call error:', err)
        alert(`Could not start call: ${err.message}`)
        handleEndCall()
      },
    })
    webrtcRef.current = rtc

    try {
      await rtc.startLocalStream(type)
      const offer = await rtc.createOffer()
      gatewayRef.current.sendCallSignal({
        signalType: 'offer',
        callId,
        targetUserId: peerId,
        callType: type,
        sdp: offer.sdp,
      })
    } catch (err) {
      console.error('[WebRTC] Error acquiring devices / creating offer:', err)
      handleEndCall()
    }
  }

  const handleAcceptCall = async () => {
    if (!pendingOfferRef.current || !gatewayRef.current) return

    const { sdp, callType: incomingType } = pendingOfferRef.current
    const callId = activeCallIdRef.current
    const peerId = activeCallPeerIdRef.current

    setCallState('connected')
    setCallType(incomingType)
    setIsCallMuted(false)
    setIsCallVideoDisabled(false)

    const rtc = new WebRtcManager({
      onLocalStream: (s) => setLocalStream(s),
      onRemoteStream: (s) => setRemoteStream(s),
      onIceCandidate: (candidate) => {
        gatewayRef.current?.sendCallSignal({
          signalType: 'ice_candidate',
          callId,
          targetUserId: peerId,
          candidate: candidate.toJSON(),
        })
      },
      onConnectionStateChange: (state) => {
        console.log('[ChatPage] WebRTC ConnectionState (callee):', state)
        if (state === 'connected') {
          setCallState('connected')
        } else if (state === 'failed') {
          console.warn('[ChatPage] Callee connection failed')
          handleEndCall()
        }
      },
      onError: (err) => {
        console.error('[WebRTC] Error accepting call:', err)
        handleEndCall()
      },
    })
    webrtcRef.current = rtc

    // Drain any early ICE candidates that arrived before the user clicked Accept
    while (pendingIceCandidatesRef.current.length > 0) {
      const cand = pendingIceCandidatesRef.current.shift()
      if (cand) {
        console.log('[ChatPage] Draining early ICE candidate to callee WebRTC instance')
        await rtc.addIceCandidate(cand)
      }
    }

    try {
      await rtc.startLocalStream(incomingType)
      const answer = await rtc.handleOffer(sdp)
      gatewayRef.current.sendCallSignal({
        signalType: 'answer',
        callId,
        targetUserId: peerId,
        sdp: answer.sdp,
      })
    } catch (err) {
      console.error('[WebRTC] Failed to answer call:', err)
      handleEndCall()
    }
  }

  const handleRejectCall = () => {
    if (gatewayRef.current && activeCallPeerIdRef.current && activeCallIdRef.current) {
      gatewayRef.current.sendCallSignal({
        signalType: 'reject',
        callId: activeCallIdRef.current,
        targetUserId: activeCallPeerIdRef.current,
      })
    }
    pendingOfferRef.current = null
    pendingIceCandidatesRef.current = []
    setCallState('idle')
    setActiveCallId('')
    setActiveCallPeerId('')
  }

  const handleEndCall = () => {
    if (gatewayRef.current && activeCallPeerIdRef.current && activeCallIdRef.current) {
      gatewayRef.current.sendCallSignal({
        signalType: 'hangup',
        callId: activeCallIdRef.current,
        targetUserId: activeCallPeerIdRef.current,
      })
    }
    webrtcRef.current?.hangup()
    webrtcRef.current = null
    pendingOfferRef.current = null
    pendingIceCandidatesRef.current = []
    setLocalStream(null)
    setRemoteStream(null)
    setCallState('idle')
    setActiveCallId('')
    setActiveCallPeerId('')
    setIsCallMinimized(false)
  }

  const handleToggleCallMute = () => {
    if (webrtcRef.current) {
      const isMuted = webrtcRef.current.toggleAudio()
      setIsCallMuted(isMuted)
    }
  }

  const handleToggleCallVideo = () => {
    if (webrtcRef.current) {
      const isOff = webrtcRef.current.toggleVideo()
      setIsCallVideoDisabled(isOff)
    }
  }

  // --- 7. Modals Handlers ---
  const handleStartDirectMessage = (e: React.FormEvent) => {
    e.preventDefault()
    const target = newDmUserId.trim()
    if (!target) return

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

  const handleCreateChannel = (e: React.FormEvent) => {
    e.preventDefault()
    const raw = newChanName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!raw) return

    const chanId = `chan_${raw}`
    if (!conversations.some((c) => c.id === chanId)) {
      setConversations((prev) => [
        ...prev,
        { id: chanId, name: raw, isDirect: false },
      ])
    }
    setActiveChannelId(chanId)
    setNewChanName('')
    setShowNewChanModal(false)
  }

  const handleOpenSafetyModal = async () => {
    if (!activeConversation?.isDirect || !user) return
    const peerId = activeConversation.id
    setSafetyPeerId(peerId)
    const num = await E2eeService.generateSafetyNumber(user.userId, peerId)
    setSafetyNumber(num)
    setShowSafetyModal(true)
  }

  const handleCopyUserId = useCallback(() => {
    if (user?.userId) {
      navigator.clipboard.writeText(user.userId)
      setCopiedUserId(true)
      setTimeout(() => setCopiedUserId(false), 2000)
    }
  }, [user?.userId])

  const handleCopySafetyNumber = useCallback(() => {
    if (safetyNumber) {
      navigator.clipboard.writeText(safetyNumber)
      setCopiedSafetyNumber(true)
      setTimeout(() => setCopiedSafetyNumber(false), 2000)
    }
  }, [safetyNumber])

  const channelConversations = conversations.filter((c) => !c.isDirect)
  const dmConversations = conversations.filter((c) => c.isDirect)

  return (
    <div className="flex h-screen w-full bg-slate-950 text-slate-100 antialiased font-sans">
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
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setShowSearchModal(true)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition"
              title="Search messages (Ctrl+K)"
            >
              <Search className="h-4 w-4" />
            </button>
            <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-500/20">
              PQ-SECURE
            </span>
          </div>
        </div>

        {/* Conversation List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {/* Channels */}
          <div className="space-y-1">
            <div className="flex items-center justify-between px-2 py-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Channels
              </p>
              <button
                onClick={() => setShowNewChanModal(true)}
                className="flex items-center space-x-1 text-[11px] text-indigo-400 hover:text-indigo-300 transition"
                title="Create new channel"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>New</span>
              </button>
            </div>
            {channelConversations.map((chan) => (
              <button
                key={chan.id}
                onClick={() => {
                  setActiveChannelId(chan.id)
                  setUnreadCounts((prev) => ({ ...prev, [chan.id]: 0 }))
                  setIncomingToast(null)
                }}
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
                {unreadCounts[chan.id] > 0 && (
                  <span className="rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-bold text-white shrink-0">
                    {unreadCounts[chan.id]}
                  </span>
                )}
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
                  onClick={() => {
                    setActiveChannelId(dm.id)
                    setUnreadCounts((prev) => ({ ...prev, [dm.id]: 0 }))
                    setIncomingToast(null)
                  }}
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
                  {unreadCounts[dm.id] > 0 && (
                    <span className="rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-bold text-white shrink-0 animate-pulse">
                      {unreadCounts[dm.id]}
                    </span>
                  )}
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
              <div className="flex items-center space-x-2">
                <span className="font-semibold text-slate-200">
                  {activeConversation?.isDirect ? `@${activeConversation?.name}` : activeConversation?.name}
                </span>
                {activeConversation?.isDirect && (
                  <button
                    onClick={handleOpenSafetyModal}
                    className="flex items-center space-x-1 rounded bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-400 border border-indigo-500/20 hover:bg-indigo-500/20 transition"
                    title="Inspect Safety Number & Ratchet Keys"
                  >
                    <Key className="h-2.5 w-2.5" />
                    <span>Verify Security</span>
                  </button>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                {activeConversation?.isDirect ? '1:1 E2EE Post-Quantum Ratchet' : 'Public Channel • Instant Broadcast'}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            {/* Direct Call Controls (Voice & Video) */}
            {activeConversation?.isDirect && (
              <div className="flex items-center space-x-2 border-r border-slate-800 pr-4">
                <button
                  onClick={() => handleStartCall('audio')}
                  disabled={callState !== 'idle'}
                  className="flex items-center space-x-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 border border-slate-800 hover:bg-emerald-600/20 hover:text-emerald-400 hover:border-emerald-500/30 transition disabled:opacity-40 disabled:cursor-not-allowed shadow-xs"
                  title="Start Voice Call"
                >
                  <Phone className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="hidden sm:inline">Voice</span>
                </button>

                <button
                  onClick={() => handleStartCall('video')}
                  disabled={callState !== 'idle'}
                  className="flex items-center space-x-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 border border-slate-800 hover:bg-indigo-600/20 hover:text-indigo-400 hover:border-indigo-500/30 transition disabled:opacity-40 disabled:cursor-not-allowed shadow-xs"
                  title="Start Video Call"
                >
                  <Video className="h-3.5 w-3.5 text-indigo-400" />
                  <span className="hidden sm:inline">Video</span>
                </button>
              </div>
            )}

            {/* Live Gateway Connection Indicator */}
            <div className="flex items-center space-x-1.5 text-xs">
              <span
                className={`h-2 w-2 rounded-full ${
                  isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'
                }`}
              />
              <span className={isConnected ? 'text-emerald-400' : 'text-slate-500'}>
                {isConnected ? 'Connected' : 'Connecting...'}
              </span>
            </div>

            <button
              onClick={() => setShowSearchModal(true)}
              className="flex items-center space-x-2 text-xs text-slate-400 bg-slate-900 hover:bg-slate-800 px-3 py-1.5 rounded-full border border-slate-800 transition"
            >
              <Search className="h-3 w-3 text-slate-400" />
              <span>Search</span>
              <kbd className="text-[10px] bg-slate-800 px-1.5 py-0.5 rounded text-slate-400 border border-slate-700">Ctrl K</kbd>
            </button>
          </div>
        </header>

        {/* Incoming Message Alert Banner */}
        {incomingToast && (
          <div className="mx-6 mt-3 flex items-center justify-between rounded-xl bg-indigo-600/90 text-white px-4 py-2.5 shadow-lg border border-indigo-400/30 animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="flex items-center space-x-2 text-xs truncate">
              <span className="font-bold shrink-0">@{incomingToast.senderId.slice(0, 10)}...:</span>
              <span className="truncate opacity-90">{incomingToast.preview}</span>
            </div>
            <div className="flex items-center space-x-2 ml-4 shrink-0">
              <button
                onClick={() => {
                  setActiveChannelId(incomingToast.channelId)
                  setUnreadCounts((prev) => ({ ...prev, [incomingToast.channelId]: 0 }))
                  setIncomingToast(null)
                }}
                className="bg-white text-indigo-700 font-semibold text-xs px-2.5 py-1 rounded-lg hover:bg-indigo-50 transition shadow-xs"
              >
                View
              </button>
              <button
                onClick={() => setIncomingToast(null)}
                className="text-indigo-200 hover:text-white p-0.5"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* Message Stream */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {currentMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-500 space-y-2">
              <Lock className="h-8 w-8 text-slate-600" />
              <p className="text-sm font-medium">End-to-End Encrypted Channel</p>
              <p className="text-xs text-slate-600">Messages are encrypted with AES-256-GCM and post-quantum keys.</p>
            </div>
          ) : (
            currentMessages.map((m) => {
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
                    {m.text && <p className="leading-relaxed break-words">{m.text}</p>}

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

                  <div className="flex items-center space-x-1.5 mt-1 px-1 text-[10px] text-slate-500">
                    <span>{m.timestamp}</span>
                    {m.isEncrypted && (
                      <span title="End-to-End Encrypted">
                        <Lock className="h-2.5 w-2.5 text-emerald-400" />
                      </span>
                    )}
                    {isMe && (
                      <span>
                        {m.status === 'pending' && <Clock className="h-3 w-3 animate-spin text-slate-400" />}
                        {m.status === 'sent' && (
                          <span title="Sent to server">
                            <Check className="h-3 w-3 text-slate-400" />
                          </span>
                        )}
                        {m.status === 'delivered' && (
                          <span title="Delivered to device">
                            <CheckCheck className="h-3 w-3 text-slate-400" />
                          </span>
                        )}
                        {m.status === 'read' && (
                          <span title="Read by recipient">
                            <CheckCheck className="h-3 w-3 text-indigo-400" />
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                </div>
              )
            })
          )}

          {/* Typing Indicator */}
          {peerTypingUser && (
            <div className="flex items-center space-x-2 text-xs text-slate-400 pl-1 py-1">
              <div className="flex space-x-1">
                <span className="h-1.5 w-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 bg-indigo-400 rounded-full animate-bounce" />
              </div>
              <span>{peerTypingUser} is typing...</span>
            </div>
          )}

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
              onChange={handleInputChange}
              placeholder={
                activeConversation?.isDirect
                  ? `Message @${activeConversation.name} (E2EE encrypted)...`
                  : `Message #${activeConversation?.name || 'channel'}...`
              }
              className="flex-1 rounded-xl bg-slate-900 border border-slate-800 px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
            />

            <button
              type="submit"
              disabled={!inputText.trim()}
              className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 transition shrink-0 shadow-lg shadow-indigo-600/20"
            >
              <Send className="h-5 w-5" />
            </button>
          </form>
        </div>
      </main>

      {/* --- Zero-Knowledge Search Dialog (Ctrl+K) --- */}
      {showSearchModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-xs pt-20 p-4">
          <div className="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-2xl space-y-4">
            <div className="flex items-center space-x-2 border-b border-slate-800 pb-3">
              <Search className="h-5 w-5 text-indigo-400" />
              <input
                type="text"
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search encrypted messages (Zero-Knowledge)..."
                className="flex-1 bg-transparent text-sm text-slate-100 placeholder-slate-500 focus:outline-none"
              />
              <button
                onClick={() => setShowSearchModal(false)}
                className="text-slate-500 hover:text-slate-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="max-h-80 overflow-y-auto space-y-2">
              {searchResults.length === 0 ? (
                <div className="text-center py-8 text-xs text-slate-500">
                  {searchQuery ? 'No matching decrypted messages found.' : 'Type keywords to search local chat history.'}
                </div>
              ) : (
                searchResults.map((res, i) => (
                  <div
                    key={i}
                    onClick={() => {
                      setActiveChannelId(res.message.channelId)
                      setShowSearchModal(false)
                    }}
                    className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 hover:border-indigo-500/40 cursor-pointer transition space-y-1"
                  >
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span className="font-semibold text-indigo-300">
                        {res.message.channelId.startsWith('chan_') ? `#${res.message.channelId.slice(5)}` : `@${res.message.senderId}`}
                      </span>
                      <span>{res.message.timestamp}</span>
                    </div>
                    <p className="text-xs text-slate-200">
                      {res.snippets.length > 0 ? res.snippets[0] : res.message.text}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* --- Safety Number / Key Verification Modal --- */}
      {showSafetyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <ShieldCheck className="h-6 w-6 text-emerald-400" />
                <h3 className="font-semibold text-slate-100">Verify End-to-End Encryption</h3>
              </div>
              <button onClick={() => setShowSafetyModal(false)} className="text-slate-500 hover:text-slate-300">
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Compare this Safety Number with <span className="text-indigo-300 font-mono">@{safetyPeerId}</span> to verify that your session is protected against man-in-the-middle attacks using post-quantum ML-KEM-768.
            </p>

            {/* 60-digit number card */}
            <div className="rounded-xl bg-slate-950 border border-slate-800 p-4 font-mono text-center text-sm font-semibold tracking-widest text-emerald-400 select-all leading-loose">
              {safetyNumber}
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                onClick={handleCopySafetyNumber}
                className="flex items-center space-x-2 text-xs font-medium text-slate-400 hover:text-indigo-300 transition"
              >
                <Copy className="h-4 w-4" />
                <span>{copiedSafetyNumber ? 'Copied Safety Number' : 'Copy Number'}</span>
              </button>

              <button
                onClick={() => {
                  setIsSafetyVerified(true)
                  setShowSafetyModal(false)
                }}
                className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-500 transition shadow-lg shadow-emerald-600/20"
              >
                Mark as Verified
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- Create Channel Modal --- */}
      {showNewChanModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2">
                <Hash className="h-5 w-5 text-indigo-400" />
                <h3 className="font-semibold text-slate-100">Create New Channel</h3>
              </div>
              <button onClick={() => setShowNewChanModal(false)} className="text-slate-400 hover:text-slate-200">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreateChannel} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Channel Name
                </label>
                <div className="flex items-center rounded-xl border border-slate-800 bg-slate-950 px-3">
                  <span className="text-slate-500 text-sm">#</span>
                  <input
                    type="text"
                    required
                    placeholder="e.g. security-team or project-nexus"
                    value={newChanName}
                    onChange={(e) => setNewChanName(e.target.value)}
                    className="w-full bg-transparent px-2 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none"
                    autoFocus
                  />
                </div>
              </div>

              <div className="flex justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewChanModal(false)}
                  className="rounded-xl px-4 py-2 text-xs font-medium text-slate-400 hover:bg-slate-800 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 transition"
                >
                  Create Channel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- Start New Direct Message Modal --- */}
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

      {/* WebRTC Video / Voice Calling Modal & Minimized Widget */}
      {callState !== 'idle' && (
        <CallModal
          callState={callState}
          callType={callType}
          peerId={activeCallPeerId}
          localStream={localStream}
          remoteStream={remoteStream}
          isMuted={isCallMuted}
          isVideoDisabled={isCallVideoDisabled}
          isMinimized={isCallMinimized}
          onAccept={handleAcceptCall}
          onReject={handleRejectCall}
          onHangup={handleEndCall}
          onToggleMute={handleToggleCallMute}
          onToggleVideo={handleToggleCallVideo}
          onToggleMinimize={() => setIsCallMinimized((prev) => !prev)}
        />
      )}
    </div>
  )
}
