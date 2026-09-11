import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useAuth } from '@/lib/auth-context'
import { GatewayClient, GatewayEnvelope } from '@/lib/gateway-client'
import { MediaClient, AttachmentMetadata } from '@/lib/media-client'
import { MediaCryptoService } from '@/lib/media-crypto'
import { E2eeService } from '@/lib/e2ee-ratchet'
import { localDb, StoredMessage, StoredConversation, SearchSnippetResult } from '@/lib/local-storage-db'
import { CallModal } from '@/components/CallModal'
import { CameraModal } from '@/components/CameraModal'
import { ImageViewerModal } from '@/components/ImageViewerModal'
import { FileAttachmentCard } from '@/components/FileAttachmentCard'
import { AttachmentStaging } from '@/components/AttachmentStaging'
import { ActionChips } from '@/components/ActionChips'
import { SummaryModal } from '@/components/SummaryModal'
import { GroupMembersModal } from '@/components/GroupMembersModal'
import { DisappearingTimerBadge } from '@/components/DisappearingTimerBadge'
import { EphemeralSettingsModal } from '@/components/EphemeralSettingsModal'
import { SafetyNumberModal } from '@/components/SafetyNumberModal'
import { VoiceNotePlayer } from '@/components/VoiceNotePlayer'
import { VoiceRecorderBar } from '@/components/VoiceRecorderBar'
import { ReactionPicker } from '@/components/ReactionPicker'
import { QuotedReplyBanner } from '@/components/QuotedReplyBanner'
import { QuotedReply } from '@/lib/local-storage-db'
import { VoiceRecordingResult } from '@/lib/voice-recorder'
import { SafetyNumberManager, TrustRecord } from '@/lib/safety-numbers'
import { WebRtcManager, fetchDynamicIceServers } from '@/lib/webrtc-manager'
import { AuthService } from '@/lib/grpc-client'
import { PushClient } from '@/lib/push-client'
import { PreKeyManager } from '@/lib/prekey-manager'
import { LocalEncryptedCache } from '@/lib/local-cache'
import { MlsGroupManager } from '@/lib/mls-group-manager'
import { LocalIntelligence } from '@/lib/local-intelligence'

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
  Users,
  Copy,
  Plus,
  X,
  Search,
  Key,
  Radio,
  Phone,
  Video,
  Camera,
  FolderOpen,
  Maximize2,
  Sparkles,
  Timer,
  AlertTriangle,
  Mic,
  Smile,
  CornerUpLeft
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
  ephemeralTtlSec?: number
  expiresAt?: number
  replyTo?: QuotedReply
  reactions?: Record<string, string[]>
}

interface ConversationItem {
  id: string
  name: string
  isDirect: boolean
}

function formatTtlLabel(sec: number): string {
  if (!sec || sec <= 0) return 'Off'
  if (sec === 30) return '30s'
  if (sec === 300) return '5m'
  if (sec === 3600) return '1h'
  if (sec === 86400) return '24h'
  if (sec === 604800) return '7d'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}

export default function ChatPage() {
  const { user, accessToken, logout } = useAuth()
  
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [activeChannelId, setActiveChannelId] = useState<string>('')
  const [messages, setMessages] = useState<MessageItem[]>([])

  const [inputText, setInputText] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  
  // Modals state
  const [showNewDmModal, setShowNewDmModal] = useState(false)
  const [newDmUserId, setNewDmUserId] = useState('')
  const [availableUsers, setAvailableUsers] = useState<Array<{ userId: string; displayName: string; isSelf: boolean }>>([])
  const [isLoadingUsers, setIsLoadingUsers] = useState(false)
  const [userSearchQuery, setUserSearchQuery] = useState('')
  const [showNewChanModal, setShowNewChanModal] = useState(false)
  const [newChanName, setNewChanName] = useState('')
  const [selectedGroupMembers, setSelectedGroupMembers] = useState<string[]>([])
  const [showSafetyModal, setShowSafetyModal] = useState(false)
  const [safetyNumber, setSafetyNumber] = useState('')
  const [safetyPeerId, setSafetyPeerId] = useState('')
  const [isSafetyVerified, setIsSafetyVerified] = useState(false)
  const [verifiedPeerIds, setVerifiedPeerIds] = useState<Set<string>>(() =>
    SafetyNumberManager.getVerifiedPeerIds()
  )
  const [showSearchModal, setShowSearchModal] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchSnippetResult[]>([])
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false)
  const [isSummaryModalOpen, setIsSummaryModalOpen] = useState(false)
  const [isEphemeralModalOpen, setIsEphemeralModalOpen] = useState(false)
  const [conversationTtls, setConversationTtls] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem('genchat_conv_ttls')
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  })
  const conversationTtlsRef = useRef<Record<string, number>>(conversationTtls)
  useEffect(() => {
    conversationTtlsRef.current = conversationTtls
  }, [conversationTtls])
  const currentChannelTtl = conversationTtls[activeChannelId] || 0
  const chatInputRef = useRef<HTMLInputElement>(null)
  
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

  // Media Attachment & Camera states
  const [stagedFile, setStagedFile] = useState<File | null>(null)
  const [showCameraModal, setShowCameraModal] = useState(false)
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false)
  const [viewerImage, setViewerImage] = useState<{ url: string; fileName?: string; fileSize?: number } | null>(null)
  const [isDraggingFile, setIsDraggingFile] = useState(false)
  const [isRecordingVoice, setIsRecordingVoice] = useState(false)
  const [replyingTo, setReplyingTo] = useState<QuotedReply | null>(null)
  const [activeReactionPickerMsgId, setActiveReactionPickerMsgId] = useState<string | null>(null)
  const [highlightedMsgId, setHighlightedMsgId] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const docInputRef = useRef<HTMLInputElement>(null)
  const attachmentMenuRef = useRef<HTMLDivElement>(null)
  const gatewayRef = useRef<GatewayClient | null>(null)
  const mediaClientRef = useRef<MediaClient>(new MediaClient('/media'))
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTypingSentRef = useRef<number>(0)

  // Auto-scroll to bottom of message list
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activeChannelId, peerTypingUser])

  // Clipboard Paste Listener (Ctrl+V for images / screenshots)
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
        const file = e.clipboardData.files[0]
        setStagedFile(file)
      }
    }

    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [])

  // Close attachment dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        attachmentMenuRef.current &&
        !attachmentMenuRef.current.contains(e.target as Node)
      ) {
        setShowAttachmentMenu(false)
      }
    }

    if (showAttachmentMenu) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showAttachmentMenu])

  // Keep a ref for current userId and activeChannelId so the subscribe closure always has the latest
  const userIdRef = useRef(user?.userId)
  useEffect(() => { userIdRef.current = user?.userId }, [user?.userId])
  const activeChannelIdRef = useRef(activeChannelId)
  useEffect(() => { activeChannelIdRef.current = activeChannelId }, [activeChannelId])

  // --- 1. Load cached messages and conversations from IndexedDB with AES-256-GCM decryption ---
  useEffect(() => {
    async function loadLocalCache() {
      // Load conversations
      const cachedConvs = await localDb.getConversations()
      if (cachedConvs && cachedConvs.length > 0) {
        const cleanConvs = cachedConvs.filter(
          (c) =>
            c.id !== 'general' &&
            c.id !== 'announcements' &&
            c.id !== 'chan_general' &&
            c.id !== 'chan_announcements'
        )
        setConversations(cleanConvs)
        if (cleanConvs.length > 0 && !activeChannelId) {
          setActiveChannelId(cleanConvs[0].id)
        }
      }

      // Load encrypted messages for current channel and decrypt them
      if (activeChannelId) {
        const cachedMsgs = await LocalEncryptedCache.loadMessages(activeChannelId)
        if (cachedMsgs && cachedMsgs.length > 0) {
          const now = Date.now()
          const valid = cachedMsgs.filter((m) => !m.expiresAt || m.expiresAt > now)
          setMessages((prev) => {
            const ids = new Set(valid.map((m) => m.id))
            const existingNotInCache = prev.filter((m) => (!m.expiresAt || m.expiresAt > now) && !ids.has(m.id))
            return [...valid, ...existingNotInCache].map((m: any) => ({
              ...m,
              isEncrypted: true,
            }))
          })
        }
      }
    }
    loadLocalCache()
  }, [activeChannelId])

  // --- 2. Synchronize remote channels from ChannelService ---
  useEffect(() => {
    const token = accessToken || sessionStorage.getItem('genchat_access_token')
    if (!token) return
    async function syncChannels() {
      try {
        const res = await fetch('/chat.v1.ChannelService/ListChannels', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const data = await res.json()
          if (data.channels && Array.isArray(data.channels)) {
            setConversations((prev) => {
              const map = new Map<string, ConversationItem>()
              prev.forEach((c) => map.set(c.id, c))
              data.channels.forEach((ch: any) => {
                const chanId = `chan_${ch.id}`
                map.set(chanId, {
                  id: chanId,
                  name: ch.name || 'Group Chat',
                  isDirect: false,
                })
              })
              return Array.from(map.values())
            })
          }
        }
      } catch (err) {
        console.warn('[ChatPage] Channel sync failed:', err)
      }
    }
    syncChannels()
  }, [accessToken])

  // --- 3. Anti-exhaustion OTK prekey replenishment & MLS KeyPackage publishing ---
  useEffect(() => {
    const token = accessToken || sessionStorage.getItem('genchat_access_token')
    if (token && user?.deviceId && user?.userId) {
      PreKeyManager.checkAndReplenish(token, user.deviceId)
      MlsGroupManager.publishKeyPackage(user.userId, user.deviceId, token)
    }
  }, [accessToken, user?.deviceId, user?.userId])


  // Fetch registered users when New DM or Create Group modal opens
  useEffect(() => {
    if (!showNewDmModal && !showNewChanModal) return
    let active = true
    async function fetchUsers() {
      setIsLoadingUsers(true)
      try {
        const token = accessToken || sessionStorage.getItem('genchat_access_token') || undefined
        const res = await AuthService.listUsers(token)
        if (active && res.users) {
          setAvailableUsers(res.users)
        }
      } catch (err) {
        console.warn('[ChatPage] Failed to fetch user directory:', err)
      } finally {
        if (active) setIsLoadingUsers(false)
      }
    }
    fetchUsers()
    return () => {
      active = false
    }
  }, [showNewDmModal, showNewChanModal, accessToken])

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

    // Handle delivery & read receipts from peers
    const unsubReceipts = gateway.onReadReceipt((ev) => {
      const newStatus = ev.receiptType === 'delivered' ? 'delivered' : 'read'
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === ev.serverId || m.clientMsgId === ev.serverId) {
            if (m.status === 'read') return m
            return { ...m, status: newStatus }
          }
          return m
        })
      )
      localDb.updateMessageStatus(ev.serverId, newStatus)
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

    // Handle Ephemeral Setting changes from peers
    const unsubEphemeral = gateway.onEphemeralSetting((ev) => {
      console.log('[ChatPage] EphemeralSetting received:', ev)
      setConversationTtls((prev) => {
        const updated = { ...prev, [ev.channelId]: ev.ephemeralTtlSec }
        try {
          localStorage.setItem('genchat_conv_ttls', JSON.stringify(updated))
        } catch {}
        return updated
      })

      // Add a system notice in chat
      const myId = userIdRef.current || user?.userId
      const actorName = ev.updatedBy === myId ? 'You' : ev.updatedBy
      const noticeText = ev.ephemeralTtlSec > 0
        ? `⏳ ${actorName} set disappearing messages to ${formatTtlLabel(ev.ephemeralTtlSec)}.`
        : `⏳ ${actorName} turned off disappearing messages.`

      const noticeMsg: MessageItem = {
        id: `notice_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        clientMsgId: `notice_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        channelId: ev.channelId,
        senderId: 'system',
        text: noticeText,
        status: 'read',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }
      setMessages((prev) => [...prev, noticeMsg])
    })

    // Handle incoming real-time emoji reactions
    const unsubReaction = gateway.onReaction((ev) => {
      console.log('[ChatPage] Reaction received:', ev)
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === ev.targetId || m.clientMsgId === ev.targetId) {
            const reactions = { ...(m.reactions || {}) }
            const users = new Set(reactions[ev.emoji] || [])
            if (ev.op === 'remove') {
              users.delete(ev.senderId)
            } else {
              users.add(ev.senderId)
            }
            if (users.size === 0) {
              delete reactions[ev.emoji]
            } else {
              reactions[ev.emoji] = Array.from(users)
            }
            const updated = { ...m, reactions }
            localDb.saveMessage({ ...updated, createdAt: Date.now() })
            return updated
          }
          return m
        })
      )
    })

    gateway.connect()

    // Handle incoming messages (push & history) and MLS group commits
    const unsubMessages = gateway.subscribe(async (env: GatewayEnvelope) => {
      if (env.type === 'group_commit' && env.ciphertext && env.sequenceNum && env.channelId) {
        await MlsGroupManager.applyIncomingCommit(env.channelId, env.ciphertext, env.sequenceNum)
        return
      }

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
        let replyTo: QuotedReply | undefined = undefined

        let displayText: string | undefined = env.ciphertext
        let isEncrypted = false
        let senderFingerprint: string | undefined = undefined

        // Try decrypting with MLS if group channel or MLS envelope, else client-side E2EE ratchet
        if (env.ciphertext) {
          if (env.ciphertext.includes('"protocol":"genchat-mls-v1"') || effectiveChannelId.startsWith('chan_')) {
            displayText = await MlsGroupManager.decryptGroupMessage(effectiveChannelId, env.ciphertext)
            isEncrypted = true
          } else {
            const decResult = await E2eeService.decrypt(env.ciphertext, effectiveChannelId, myUserId || '')
            displayText = decResult.text
            isEncrypted = decResult.isEncrypted
            senderFingerprint = decResult.fingerprint
          }

          // Check if payload is an encrypted JSON envelope (media, voice note, or quoted reply)
          if (displayText && displayText.startsWith('{')) {
            try {
              const parsed = JSON.parse(displayText)
              if (parsed.replyTo) {
                replyTo = parsed.replyTo
              }
              if (parsed.downloadUrl && parsed.encryptionKeyHex && parsed.ivHex) {
                let decryptedUrl: string | undefined = undefined
                try {
                  const res = await fetch(parsed.downloadUrl)
                  if (res.ok) {
                    const cipherBuffer = await res.arrayBuffer()
                    decryptedUrl = await MediaCryptoService.decryptFile(
                      cipherBuffer,
                      parsed.encryptionKeyHex,
                      parsed.ivHex,
                      parsed.mimeType
                    )
                  }
                } catch (fetchErr) {
                  console.warn('[Media] Direct download failed, will renew on demand:', fetchErr)
                }

                attachment = { ...parsed, decryptedUrl }
                displayText = parsed.caption || undefined
              } else if (parsed.text !== undefined) {
                displayText = parsed.text
              }
            } catch {
              // Plain text
            }
          }
        }

        const ttlSec = env.ephemeralTtlSec || conversationTtlsRef.current[effectiveChannelId] || 0
        const expiresAt = ttlSec > 0 ? Date.now() + (ttlSec * 1000) : undefined

        const msgId = env.clientMsgId || `srv_${Date.now()}`
        const newMsg: MessageItem = {
          id: msgId,
          clientMsgId: env.clientMsgId || '',
          channelId: effectiveChannelId,
          senderId: env.senderId || 'peer',
          text: displayText,
          attachment,
          replyTo,
          reactions: {},
          status: 'delivered',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          isEncrypted,
          senderFingerprint,
          ephemeralTtlSec: ttlSec > 0 ? ttlSec : undefined,
          expiresAt,
        }

        // Write to local IndexedDB with AES-256-GCM encryption at rest
        LocalEncryptedCache.saveMessage({
          ...newMsg,
          createdAt: Date.now(),
        })
        if (env.sequenceNum) {
          LocalEncryptedCache.setLastReadSeq(effectiveChannelId, env.sequenceNum)
        }

        // Automatically dispatch read or delivery receipt
        const currentActive = activeChannelIdRef.current || ''
        const isActiveChat =
          effectiveChannelId === currentActive ||
          effectiveChannelId.toLowerCase() === currentActive.toLowerCase()

        if (env.senderId && env.senderId !== myUserId) {
          if (isActiveChat) {
            gateway.sendReadReceipt(effectiveChannelId, msgId, env.sequenceNum || 0)
          } else {
            gateway.sendDeliveryReceipt(effectiveChannelId, msgId, env.sequenceNum || 0)
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
      unsubEphemeral()
      unsubReaction()
      unsubMessages()
      gateway.disconnect()
    }
  }, [accessToken])

  // Automatic push notification registration for offline wake-up
  useEffect(() => {
    const token = accessToken || sessionStorage.getItem('genchat_access_token')
    const deviceId = user?.deviceId || sessionStorage.getItem('genchat_device_id')
    if (token && deviceId) {
      PushClient.registerBrowserPush(deviceId, token).catch(() => {})
    }
  }, [accessToken, user?.deviceId])

  // Fetch message history when connected or when switching conversation
  useEffect(() => {
    if (isConnected && gatewayRef.current && activeChannelId) {
      gatewayRef.current.fetchHistory(activeChannelId)
    }
    setPeerTypingUser(null)
  }, [isConnected, activeChannelId])

  // Ephemeral Self-Destruct Engine: 1s interval to purge expired messages from memory and storage
  useEffect(() => {
    const purgeInterval = setInterval(async () => {
      const now = Date.now()
      setMessages((prev) => {
        const hasExpired = prev.some((m) => m.expiresAt && m.expiresAt <= now)
        if (!hasExpired) return prev
        return prev.filter((m) => !m.expiresAt || m.expiresAt > now)
      })
      await localDb.purgeExpiredMessages()
    }, 1000)

    return () => clearInterval(purgeInterval)
  }, [])

  const handleSaveEphemeralTtl = (ttlSec: number) => {
    if (!activeChannelId) return
    setConversationTtls((prev) => {
      const updated = { ...prev, [activeChannelId]: ttlSec }
      try {
        localStorage.setItem('genchat_conv_ttls', JSON.stringify(updated))
      } catch {}
      return updated
    })

    // Broadcast over WebSocket to peer / members
    if (gatewayRef.current) {
      gatewayRef.current.sendEphemeralSetting(activeChannelId, ttlSec)
    }

    // Add local system notice
    const noticeText = ttlSec > 0
      ? `⏳ You set disappearing messages to ${formatTtlLabel(ttlSec)}.`
      : `⏳ You turned off disappearing messages.`

    const noticeMsg: MessageItem = {
      id: `notice_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      clientMsgId: `notice_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      channelId: activeChannelId,
      senderId: 'system',
      text: noticeText,
      status: 'read',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }
    setMessages((prev) => [...prev, noticeMsg])
  }

  const activeConversation = conversations.find((c) => c.id === activeChannelId)

  // Auto-compute safety number & trust status for active 1:1 direct chat
  useEffect(() => {
    if (!user || !activeConversation?.isDirect) {
      setSafetyNumber('')
      setSafetyPeerId('')
      return
    }
    const peerId = activeConversation.id
    setSafetyPeerId(peerId)
    E2eeService.generateSafetyNumber(user.userId, peerId).then((num) => {
      setSafetyNumber(num)
      const record = SafetyNumberManager.getTrustRecord(peerId, num)
      setIsSafetyVerified(record.isVerified)
    })
  }, [activeConversation, user])

  const currentPeerTrust = useMemo<TrustRecord | null>(() => {
    if (!activeConversation?.isDirect || !activeConversation.id || !safetyNumber) return null
    return SafetyNumberManager.getTrustRecord(activeConversation.id, safetyNumber)
  }, [activeConversation, safetyNumber, isSafetyVerified])
  
  // Robust message filter: matches exact channelId OR peer user in 1:1 DMs (case-insensitive)
  const currentMessages = messages.filter((m) => {
    const now = Date.now()
    if (m.expiresAt && m.expiresAt <= now) return false

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

  // Contextual Smart Replies based on last incoming message in the active conversation
  const lastIncomingMessage = useMemo(() => {
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      const msg = currentMessages[i]
      if (msg.senderId !== user?.userId && msg.senderId !== 'system' && msg.text) {
        return msg.text
      }
    }
    return ''
  }, [currentMessages, user?.userId])

  const smartReplies = useMemo(() => {
    if (!lastIncomingMessage) return []
    return LocalIntelligence.suggestSmartReplies(lastIncomingMessage)
  }, [lastIncomingMessage])

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

  // --- 4B. Reaction and Quoted Reply Navigation Handlers ---
  const handleToggleReaction = (targetMsg: MessageItem, emoji: string) => {
    if (!user) return
    const targetId = targetMsg.id || targetMsg.clientMsgId
    const existing = targetMsg.reactions?.[emoji] || []
    const hasReacted = existing.includes(user.userId)
    const op: 'add' | 'remove' = hasReacted ? 'remove' : 'add'

    setMessages((prev) =>
      prev.map((m) => {
        if (m.id === targetId || m.clientMsgId === targetId) {
          const reactions = { ...(m.reactions || {}) }
          const users = new Set(reactions[emoji] || [])
          if (op === 'remove') {
            users.delete(user.userId)
          } else {
            users.add(user.userId)
          }
          if (users.size === 0) {
            delete reactions[emoji]
          } else {
            reactions[emoji] = Array.from(users)
          }
          const updated = { ...m, reactions }
          localDb.saveMessage({ ...updated, createdAt: Date.now() })
          return updated
        }
        return m
      })
    )

    gatewayRef.current?.sendReaction(activeChannelId, targetId, emoji, op)
  }

  const handleJumpToMessage = (messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedMsgId(messageId)
      setTimeout(() => setHighlightedMsgId(null), 2200)
    }
  }

  // --- 5. Message Dispatch with E2EE Ratchet & Encrypted Attachments ---
  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if ((!inputText.trim() && !stagedFile) || !user) return

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
    gatewayRef.current?.sendTyping(activeChannelId, false)
    lastTypingSentRef.current = 0

    const currentReply = replyingTo
    setReplyingTo(null)

    const textToSend = inputText.trim()
    const clientMsgId = `cli_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const ttlSec = currentChannelTtl
    const expiresAt = ttlSec > 0 ? Date.now() + (ttlSec * 1000) : undefined

    // --- Case A: Sending an Encrypted Attachment (Photo, Video, Document) ---
    if (stagedFile) {
      setIsUploading(true)
      const file = stagedFile
      const caption = textToSend || undefined

      try {
        const attachment = await mediaClientRef.current.uploadEncryptedAttachment(file, caption)
        const localPreviewUrl = URL.createObjectURL(file)

        const optimisticMsg: MessageItem = {
          id: clientMsgId,
          clientMsgId,
          channelId: activeChannelId,
          senderId: user.userId,
          text: caption,
          attachment: { ...attachment, decryptedUrl: localPreviewUrl },
          replyTo: currentReply || undefined,
          reactions: {},
          status: 'pending',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          isEncrypted: true,
          ephemeralTtlSec: ttlSec > 0 ? ttlSec : undefined,
          expiresAt,
        }

        setMessages((prev) => [...prev, optimisticMsg])
        localDb.saveMessage({ ...optimisticMsg, createdAt: Date.now() })

        // Clear staging & input
        setStagedFile(null)
        setInputText('')

        // Encrypt attachment metadata envelope
        const metaJson = JSON.stringify({
          ...attachment,
          replyTo: currentReply || undefined,
        })
        const encryptedMeta = await E2eeService.encrypt(metaJson, activeChannelId, user.userId)

        if (gatewayRef.current) {
          await gatewayRef.current.sendEnvelope({
            type: 'message',
            channelId: activeChannelId,
            senderId: user.userId,
            clientMsgId,
            ciphertext: encryptedMeta,
            ephemeralTtlSec: ttlSec > 0 ? ttlSec : undefined,
            replyToMessageId: currentReply?.messageId,
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
        if (photoInputRef.current) photoInputRef.current.value = ''
        if (docInputRef.current) docInputRef.current.value = ''
      }
      return
    }

    // --- Case B: Normal Plaintext / Ratchet Encrypted Text Message ---
    setInputText('')

    let payloadString = textToSend
    if (currentReply) {
      payloadString = JSON.stringify({
        text: textToSend,
        replyTo: currentReply,
      })
    }

    let wireCiphertext = payloadString
    try {
      if (activeChannelId.startsWith('chan_')) {
        wireCiphertext = await MlsGroupManager.encryptGroupMessage(activeChannelId, user.userId, payloadString)
      } else {
        wireCiphertext = await E2eeService.encrypt(payloadString, activeChannelId, user.userId)
      }
    } catch (err) {
      console.warn('[E2EE] Encryption fallback:', err)
    }

    const optimisticMsg: MessageItem = {
      id: clientMsgId,
      clientMsgId,
      channelId: activeChannelId,
      senderId: user.userId,
      text: textToSend,
      replyTo: currentReply || undefined,
      reactions: {},
      status: 'pending',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isEncrypted: true,
      ephemeralTtlSec: ttlSec > 0 ? ttlSec : undefined,
      expiresAt,
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
          ephemeralTtlSec: ttlSec > 0 ? ttlSec : undefined,
          replyToMessageId: currentReply?.messageId,
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

  // --- 5B. Encrypted Voice Note Dispatch ---
  const handleSendVoiceNote = async (result: VoiceRecordingResult) => {
    if (!user) return
    setIsUploading(true)
    const clientMsgId = `cli_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const ttlSec = currentChannelTtl
    const expiresAt = ttlSec > 0 ? Date.now() + (ttlSec * 1000) : undefined

    const currentReply = replyingTo
    setReplyingTo(null)

    try {
      const attachment = await mediaClientRef.current.uploadEncryptedAttachment(result.blob, {
        isVoiceNote: true,
        durationSec: result.durationSec,
        waveform: result.waveform,
        fileName: 'Voice message.webm',
      })
      const localPreviewUrl = URL.createObjectURL(result.blob)

      const optimisticMsg: MessageItem = {
        id: clientMsgId,
        clientMsgId,
        channelId: activeChannelId,
        senderId: user.userId,
        attachment: {
          ...attachment,
          decryptedUrl: localPreviewUrl,
          isVoiceNote: true,
          durationSec: result.durationSec,
          waveform: result.waveform,
        },
        replyTo: currentReply || undefined,
        reactions: {},
        status: 'pending',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isEncrypted: true,
        ephemeralTtlSec: ttlSec > 0 ? ttlSec : undefined,
        expiresAt,
      }

      setMessages((prev) => [...prev, optimisticMsg])
      localDb.saveMessage({ ...optimisticMsg, createdAt: Date.now() })

      // Encrypt attachment metadata envelope
      const metaJson = JSON.stringify({
        ...attachment,
        isVoiceNote: true,
        durationSec: result.durationSec,
        waveform: result.waveform,
        replyTo: currentReply || undefined,
      })

      let wireCiphertext = metaJson
      if (activeChannelId.startsWith('chan_')) {
        wireCiphertext = await MlsGroupManager.encryptGroupMessage(activeChannelId, user.userId, metaJson)
      } else {
        wireCiphertext = await E2eeService.encrypt(metaJson, activeChannelId, user.userId)
      }

      if (gatewayRef.current) {
        await gatewayRef.current.sendEnvelope({
          type: 'message',
          channelId: activeChannelId,
          senderId: user.userId,
          clientMsgId,
          ciphertext: wireCiphertext,
          ephemeralTtlSec: ttlSec > 0 ? ttlSec : undefined,
          replyToMessageId: currentReply?.messageId,
        })

        setMessages((prev) =>
          prev.map((m) => (m.clientMsgId === clientMsgId ? { ...m, status: 'sent' } : m))
        )
        localDb.updateMessageStatus(clientMsgId, 'sent')
      }
    } catch (err) {
      console.error('[VoiceNote] Upload & dispatch failed:', err)
    } finally {
      setIsUploading(false)
      setIsRecordingVoice(false)
    }
  }

  // --- 6. Media Attachment Handlers (Photo, Document, Camera, Drag & Drop) ---
  const handleSelectFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setStagedFile(file)
      setShowAttachmentMenu(false)
    }
    e.target.value = ''
  }

  const handleCameraCapture = (file: File) => {
    setStagedFile(file)
    setShowCameraModal(false)
    setShowAttachmentMenu(false)
  }

  // Drag and Drop handlers for chat pane
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDraggingFile(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDraggingFile(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDraggingFile(false)

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0]
      setStagedFile(file)
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

    const dynamicServers = await fetchDynamicIceServers(accessToken || undefined)
    const rtc = new WebRtcManager({
      iceServers: dynamicServers,
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

    const dynamicServers = await fetchDynamicIceServers(accessToken || undefined)
    const rtc = new WebRtcManager({
      iceServers: dynamicServers,
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

  // --- 45-Second Ring Timeout: cancels unanswered outgoing calls or auto-dismisses incoming calls ---
  useEffect(() => {
    if (callState === 'outgoing') {
      const timeout = setTimeout(() => {
        const peer = activeCallPeerIdRef.current
        console.info(`[WebRTC] Outgoing call to @${peer} timed out after 45s (no answer)`)
        handleEndCall()
        alert(`No answer from @${peer}`)
      }, 45000)
      return () => clearTimeout(timeout)
    }

    if (callState === 'incoming') {
      const timeout = setTimeout(() => {
        const peer = activeCallPeerIdRef.current
        console.info(`[WebRTC] Incoming call from @${peer} timed out after 45s`)
        pendingOfferRef.current = null
        pendingIceCandidatesRef.current = []
        setCallState('idle')
        setActiveCallId('')
        setActiveCallPeerId('')
      }, 45000)
      return () => clearTimeout(timeout)
    }
  }, [callState])

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
  const handleSelectUser = (targetUserId: string, displayName?: string) => {
    const target = targetUserId.trim()
    if (!target) return

    setConversations((prev) => {
      const exists = prev.some((c) => c.id === target)
      if (exists) return prev
      return [
        ...prev,
        { id: target, name: displayName || target, isDirect: true },
      ]
    })
    setActiveChannelId(target)
    setNewDmUserId('')
    setUserSearchQuery('')
    setShowNewDmModal(false)
  }

  const handleStartDirectMessage = (e: React.FormEvent) => {
    e.preventDefault()
    const target = (userSearchQuery || newDmUserId).trim()
    if (!target) return
    handleSelectUser(target)
  }

  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault()
    const name = newChanName.trim()
    if (!name) return

    try {
      const token = accessToken || sessionStorage.getItem('genchat_access_token')
      if (token && user?.userId && user?.deviceId) {
        const mlsResult = await MlsGroupManager.createGroup(
          name,
          selectedGroupMembers,
          user.userId,
          user.deviceId,
          token
        )
        if (mlsResult) {
          setConversations((prev) => [
            ...prev,
            { id: mlsResult.channelId, name: name, isDirect: false },
          ])
          setActiveChannelId(mlsResult.channelId)
          setNewChanName('')
          setSelectedGroupMembers([])
          setShowNewChanModal(false)
          return
        }
      }

      const res = await fetch('/chat.v1.ChannelService/CreateChannel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: name,
          memberUserIds: selectedGroupMembers,
          type: 2,
        }),
      })


      if (res.ok) {
        const data = await res.json()
        const chanId = `chan_${data.channel.id}`
        setConversations((prev) => [
          ...prev,
          { id: chanId, name: data.channel.name || name, isDirect: false },
        ])
        setActiveChannelId(chanId)
        setNewChanName('')
        setSelectedGroupMembers([])
        setShowNewChanModal(false)
        return
      }
    } catch (err) {
      console.warn('[ChatPage] Channel creation error:', err)
    }

    const raw = name.toLowerCase().replace(/[^a-z0-9_-]/g, '')
    const chanId = `chan_${raw}`
    if (!conversations.some((c) => c.id === chanId)) {
      setConversations((prev) => [
        ...prev,
        { id: chanId, name: raw, isDirect: false },
      ])
    }
    setActiveChannelId(chanId)
    setNewChanName('')
    setSelectedGroupMembers([])
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
        {/* Quick Start Conversation Action */}
        <div className="p-3 pb-0">
          <button
            onClick={() => setShowNewDmModal(true)}
            className="flex w-full items-center justify-center space-x-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white shadow-md hover:bg-indigo-500 transition-colors shadow-indigo-600/20"
          >
            <UserPlus className="h-4 w-4" />
            <span>Start Conversation</span>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {conversations.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-800 p-4 text-center">
              <p className="text-xs text-slate-400 font-medium">No conversations yet</p>
              <p className="text-[11px] text-slate-500 mt-1">
                Start an end-to-end encrypted direct chat with any registered user.
              </p>
            </div>
          )}
          {/* Groups & Channels */}
          <div className="space-y-1">
            <div className="flex items-center justify-between px-2 py-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Groups & Channels
              </p>
              <button
                onClick={() => setShowNewChanModal(true)}
                className="flex items-center space-x-1 text-[11px] text-cyan-400 hover:text-cyan-300 transition"
                title="Create new encrypted group chat"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>New Group</span>
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
                    ? 'bg-cyan-600/20 text-cyan-300 border border-cyan-500/30'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                }`}
              >
                <div className="flex items-center space-x-2 truncate">
                  <Users className="h-4 w-4 shrink-0 text-cyan-400" />
                  <span className="truncate">{chan.name}</span>
                </div>
                {unreadCounts[chan.id] > 0 && (
                  <span className="rounded-full bg-cyan-600 px-1.5 py-0.5 text-[10px] font-bold text-white shrink-0">
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
                    {verifiedPeerIds.has(dm.id) && (
                      <span title="Cryptographically Verified Contact">
                        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                      </span>
                    )}
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
        {!activeConversation ? (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center select-none">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-600/10 text-indigo-400 mb-4 border border-indigo-500/20 shadow-lg">
              <ShieldCheck className="h-8 w-8" />
            </div>
            <h2 className="text-xl font-bold text-slate-100">Welcome to GenChat</h2>
            <p className="text-xs text-slate-400 max-w-sm mt-2 leading-relaxed">
              Zero-knowledge, post-quantum end-to-end encrypted messaging with WebRTC voice/video and encrypted attachments.
            </p>
            <div className="mt-6">
              <button
                onClick={() => setShowNewDmModal(true)}
                className="flex items-center space-x-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-indigo-500 transition shadow-indigo-600/30"
              >
                <UserPlus className="h-4 w-4" />
                <span>Start a Conversation</span>
              </button>
            </div>
          </div>
        ) : (
          <>
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
                    className={`flex items-center space-x-1 rounded px-2 py-0.5 text-[10px] font-medium border transition ${
                      currentPeerTrust?.hasChanged
                        ? 'bg-amber-500/15 text-amber-300 border-amber-500/40 hover:bg-amber-500/25 animate-pulse'
                        : currentPeerTrust?.isVerified
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/25'
                        : 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20 hover:bg-indigo-500/20'
                    }`}
                    title="Inspect Safety Number & Ratchet Keys"
                  >
                    {currentPeerTrust?.hasChanged ? (
                      <AlertTriangle className="h-3 w-3 text-amber-400" />
                    ) : currentPeerTrust?.isVerified ? (
                      <ShieldCheck className="h-3 w-3 text-emerald-400" />
                    ) : (
                      <Key className="h-2.5 w-2.5" />
                    )}
                    <span>
                      {currentPeerTrust?.hasChanged
                        ? 'Key Changed!'
                        : currentPeerTrust?.isVerified
                        ? 'Verified'
                        : 'Verify Security'}
                    </span>
                  </button>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                {activeConversation?.isDirect
                  ? '1:1 E2EE Post-Quantum Ratchet'
                  : activeChannelId.startsWith('chan_')
                  ? 'RFC 9420 MLS Group • TreeKEM E2EE'
                  : 'Public Channel • Instant Broadcast'}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            {/* Disappearing Messages Setting */}
            <button
              onClick={() => setIsEphemeralModalOpen(true)}
              className={`flex items-center space-x-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium border transition shadow-xs ${
                currentChannelTtl > 0
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/50 hover:bg-amber-500/25'
                  : 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800 hover:text-white'
              }`}
              title="Disappearing Messages (Self-Destruct Timers)"
            >
              <Timer className={`h-3.5 w-3.5 ${currentChannelTtl > 0 ? 'text-amber-400' : 'text-slate-400'}`} />
              <span className="hidden sm:inline">
                {currentChannelTtl > 0 ? formatTtlLabel(currentChannelTtl) : 'Timer'}
              </span>
            </button>

            {/* AI Conversation Summarizer */}
            <button
              onClick={() => setIsSummaryModalOpen(true)}
              className="flex items-center space-x-1.5 rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-purple-300 border border-purple-500/30 hover:bg-purple-600/20 hover:border-purple-500/50 transition shadow-xs"
              title="Summarize Chat with On-Device AI"
            >
              <Sparkles className="h-3.5 w-3.5 text-purple-400" />
              <span className="hidden sm:inline">Summarize</span>
            </button>

            {/* MLS Group Members Management */}
            {activeChannelId.startsWith('chan_') && (
              <button
                onClick={() => setIsGroupModalOpen(true)}
                className="flex items-center space-x-1.5 rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-cyan-300 border border-cyan-500/30 hover:bg-cyan-600/20 hover:border-cyan-500/50 transition shadow-xs"
                title="Manage Group Members & MLS Keys"
              >
                <Users className="h-3.5 w-3.5 text-cyan-400" />
                <span className="hidden sm:inline">Members</span>
              </button>
            )}

            {/* Direct Call Controls (Voice & Video) */}
            {activeConversation?.isDirect && (
              <div className="flex items-center space-x-2 border-r border-slate-800 pr-3">
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
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className="relative flex-1 overflow-y-auto p-6 space-y-4"
        >
          {/* Drag and drop overlay */}
          {isDraggingFile && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-indigo-950/85 backdrop-blur-sm border-2 border-dashed border-indigo-400 rounded-2xl m-3 pointer-events-none animate-in fade-in">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-500/20 text-indigo-300 mb-3 shadow-xl">
                <Paperclip className="h-8 w-8 animate-bounce" />
              </div>
              <h3 className="text-base font-semibold text-white">Drop file to attach</h3>
              <p className="text-xs text-indigo-200 mt-1">End-to-End Encrypted before upload to MinIO</p>
            </div>
          )}

          {/* Ephemeral Active Status Banner */}
          {currentChannelTtl > 0 && (
            <div className="flex justify-center mb-3">
              <div className="flex items-center space-x-2 rounded-full bg-amber-500/10 border border-amber-500/30 px-3.5 py-1.5 text-xs text-amber-300 shadow-sm">
                <Timer className="h-3.5 w-3.5 text-amber-400 animate-pulse" />
                <span>Disappearing messages on: {formatTtlLabel(currentChannelTtl)} self-destruct</span>
              </div>
            </div>
          )}

          {/* Key Change Security Alert Banner */}
          {activeConversation?.isDirect && currentPeerTrust?.hasChanged && (
            <div className="flex justify-center mb-3">
              <button
                onClick={handleOpenSafetyModal}
                className="flex items-center space-x-2.5 rounded-xl bg-amber-500/15 border border-amber-500/40 px-4 py-2 text-xs text-amber-300 shadow-md hover:bg-amber-500/25 transition text-left cursor-pointer"
              >
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 animate-bounce" />
                <div>
                  <span className="font-semibold">Security Number Changed:</span>{' '}
                  <span>The encryption keys for @{activeConversation.name} have changed since your last verification. Tap here to inspect and verify.</span>
                </div>
              </button>
            </div>
          )}

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

              const msgKey = m.id || m.clientMsgId
              const isHighlighted = highlightedMsgId === msgKey

              return (
                <div
                  key={msgKey}
                  id={`msg-${msgKey}`}
                  className={`group relative flex flex-col my-1 transition-all duration-300 ${
                    isMe ? 'items-end' : 'items-start'
                  } ${
                    isHighlighted
                      ? 'ring-2 ring-indigo-400 ring-offset-2 ring-offset-slate-950 rounded-2xl p-1 bg-indigo-500/15'
                      : ''
                  }`}
                >
                  {!isMe && (
                    <span className="text-[11px] text-slate-500 mb-1 px-1">{m.senderId}</span>
                  )}

                  {/* Floating Action Menu on Bubble Hover */}
                  <div
                    className={`absolute -top-3 opacity-0 group-hover:opacity-100 transition-opacity z-20 flex items-center space-x-1 bg-slate-900/95 border border-slate-700/80 rounded-full px-2 py-0.5 shadow-lg backdrop-blur-md ${
                      isMe ? 'right-2' : 'left-2'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setActiveReactionPickerMsgId(activeReactionPickerMsgId === msgKey ? null : msgKey)
                      }}
                      className="p-1 text-slate-400 hover:text-amber-400 hover:bg-slate-800 rounded-full transition"
                      title="React with emoji"
                    >
                      <Smile className="h-3.5 w-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        const snippet =
                          m.text ||
                          (m.attachment?.isVoiceNote
                            ? '🎙️ Voice message'
                            : m.attachment?.mimeType?.startsWith('image/')
                            ? '📷 Photo'
                            : m.attachment?.fileName || 'Attachment')
                        const senderName = isMe ? 'You' : (activeConversation?.name || m.senderId.slice(0, 10))
                        setReplyingTo({
                          messageId: msgKey,
                          senderId: m.senderId,
                          senderName,
                          snippet,
                        })
                        chatInputRef.current?.focus()
                      }}
                      className="p-1 text-slate-400 hover:text-indigo-400 hover:bg-slate-800 rounded-full transition"
                      title="Reply"
                    >
                      <CornerUpLeft className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Reaction Picker Popover */}
                  {activeReactionPickerMsgId === msgKey && (
                    <div className={`absolute -top-11 z-30 ${isMe ? 'right-2' : 'left-2'}`}>
                      <ReactionPicker
                        onSelectEmoji={(emoji) => handleToggleReaction(m, emoji)}
                        onClose={() => setActiveReactionPickerMsgId(null)}
                        userReactions={
                          user
                            ? Object.keys(m.reactions || {}).filter((k) =>
                                m.reactions![k]?.includes(user.userId)
                              )
                            : []
                        }
                      />
                    </div>
                  )}

                  <div
                    className={`max-w-md rounded-2xl px-4 py-2.5 text-sm ${
                      isMe
                        ? 'bg-indigo-600 text-white rounded-br-xs'
                        : 'bg-slate-800 text-slate-100 rounded-bl-xs'
                    }`}
                  >
                    {/* Quoted Reply Header */}
                    {m.replyTo && (
                      <div
                        onClick={(e) => {
                          e.stopPropagation()
                          handleJumpToMessage(m.replyTo!.messageId)
                        }}
                        className={`flex items-center space-x-2 px-3 py-1.5 mb-2 rounded-xl cursor-pointer transition select-none ${
                          isMe
                            ? 'bg-black/25 hover:bg-black/35 border-l-4 border-white'
                            : 'bg-slate-950/60 hover:bg-slate-950/80 border-l-4 border-indigo-500'
                        }`}
                        title="Click to jump to quoted message"
                      >
                        <div className="flex-1 min-w-0 text-left">
                          <div
                            className={`text-[11px] font-semibold truncate ${
                              isMe ? 'text-indigo-200' : 'text-indigo-400'
                            }`}
                          >
                            @{m.replyTo.senderName || m.replyTo.senderId.slice(0, 10)}
                          </div>
                          <div className={`text-xs truncate ${isMe ? 'text-white/80' : 'text-slate-300'}`}>
                            {m.replyTo.snippet}
                          </div>
                        </div>
                      </div>
                    )}
                    {m.text && <p className="leading-relaxed break-words">{m.text}</p>}
                    {m.text && <ActionChips text={m.text} />}

                    {m.attachment && (
                      <div className="space-y-2">
                        {m.attachment.isVoiceNote || m.attachment.mimeType.startsWith('audio/') ? (
                          <div className="mt-1">
                            <VoiceNotePlayer
                              attachment={m.attachment}
                              isMe={isMe}
                              onRenewDownloadUrl={(blobId) => mediaClientRef.current.getDownloadUrl(blobId)}
                            />
                          </div>
                        ) : m.attachment.mimeType.startsWith('image/') ? (
                          m.attachment.decryptedUrl ? (
                            <div
                              onClick={() =>
                                setViewerImage({
                                  url: m.attachment!.decryptedUrl!,
                                  fileName: m.attachment!.fileName,
                                  fileSize: m.attachment!.originalSize,
                                })
                              }
                              className="group relative cursor-pointer overflow-hidden rounded-xl border border-white/10 shadow hover:opacity-95 transition mt-1"
                            >
                              <img
                                src={m.attachment.decryptedUrl}
                                alt={m.attachment.fileName || 'Encrypted attachment'}
                                className="max-h-64 w-auto rounded-xl object-cover"
                              />
                              <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                                <span className="flex items-center space-x-1 rounded-lg bg-black/60 px-2.5 py-1 text-xs text-white backdrop-blur-xs">
                                  <Maximize2 className="h-3.5 w-3.5" />
                                  <span>View Fullscreen</span>
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center space-x-2 p-3 bg-black/20 rounded-xl mt-1">
                              <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
                              <span className="text-xs text-slate-300">Decrypting photo...</span>
                            </div>
                          )
                        ) : (
                          <div className="mt-1">
                            <FileAttachmentCard
                              attachment={m.attachment}
                              isMe={isMe}
                              onRenewDownloadUrl={(blobId) => mediaClientRef.current.getDownloadUrl(blobId)}
                            />
                          </div>
                        )}

                        {!m.attachment.isVoiceNote && (
                          <div className="flex items-center justify-between text-[10px] opacity-75">
                            <span className="truncate max-w-[180px]">
                              {m.attachment.fileName || m.attachment.blobId}
                            </span>
                            <span className="flex items-center space-x-1">
                              <Lock className="h-2.5 w-2.5" />
                              <span>{(m.attachment.originalSize / 1024).toFixed(1)} KB</span>
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Reaction Badges */}
                  {m.reactions && Object.keys(m.reactions).length > 0 && (
                    <div className={`flex flex-wrap items-center gap-1 mt-1 px-1 ${isMe ? 'justify-end' : 'justify-start'}`}>
                      {Object.entries(m.reactions).map(([emoji, userIds]) => {
                        if (!userIds || userIds.length === 0) return null
                        const hasReacted = user ? userIds.includes(user.userId) : false
                        return (
                          <button
                            key={emoji}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleToggleReaction(m, emoji)
                            }}
                            className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-xs font-medium border transition transform active:scale-95 ${
                              hasReacted
                                ? 'bg-indigo-600/40 border-indigo-400/60 text-white shadow-xs'
                                : 'bg-slate-800/80 border-slate-700/60 text-slate-300 hover:border-slate-500'
                            }`}
                            title={`${userIds.length} ${userIds.length === 1 ? 'reaction' : 'reactions'}`}
                          >
                            <span>{emoji}</span>
                            <span className="text-[10px] font-bold">{userIds.length}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}

                  <div className="flex items-center space-x-1.5 mt-1 px-1 text-[10px] text-slate-500">
                    <span>{m.timestamp}</span>
                    {m.isEncrypted && (
                      <span title="End-to-End Encrypted">
                        <Lock className="h-2.5 w-2.5 text-emerald-400" />
                      </span>
                    )}
                    {m.expiresAt && (
                      <DisappearingTimerBadge expiresAt={m.expiresAt} />
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
          {/* Attachment Staging Preview */}
          <AttachmentStaging
            file={stagedFile}
            isUploading={isUploading}
            onRemove={() => setStagedFile(null)}
          />

          {/* Quoted Reply Banner */}
          {replyingTo && (
            <QuotedReplyBanner
              replyingTo={replyingTo}
              onCancel={() => setReplyingTo(null)}
            />
          )}

          {/* Contextual Smart Replies Bar */}
          {smartReplies.length > 0 && !inputText && (
            <div className="flex items-center gap-1.5 mb-2.5 overflow-x-auto py-1 scrollbar-none animate-in fade-in slide-in-from-bottom-1">
              <span className="text-[10px] text-slate-500 font-medium shrink-0 flex items-center gap-1 mr-1">
                <Sparkles className="w-3 h-3 text-purple-400" />
                Suggestions:
              </span>
              {smartReplies.map((reply, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setInputText(reply)
                    chatInputRef.current?.focus()
                  }}
                  className="px-2.5 py-1 rounded-full text-xs font-medium bg-slate-800/90 text-slate-200 border border-slate-700/70 hover:bg-indigo-600/30 hover:text-indigo-200 hover:border-indigo-500/40 transition-colors shrink-0 shadow-xs"
                >
                  {reply}
                </button>
              ))}
            </div>
          )}

          {isRecordingVoice ? (
            <VoiceRecorderBar
              onSend={handleSendVoiceNote}
              onCancel={() => setIsRecordingVoice(false)}
              isUploading={isUploading}
            />
          ) : (
            <form onSubmit={handleSendMessage} className="flex items-center space-x-2">
              {/* Hidden File Inputs */}
              <input
                type="file"
                ref={photoInputRef}
                onChange={handleSelectFile}
                className="hidden"
                accept="image/*,video/*"
              />
              <input
                type="file"
                ref={docInputRef}
                onChange={handleSelectFile}
                className="hidden"
                accept="*/*"
              />

              {/* Attachment Plus Button & Menu */}
              <div className="relative" ref={attachmentMenuRef}>
                <button
                  type="button"
                  disabled={isUploading}
                  onClick={() => setShowAttachmentMenu((prev) => !prev)}
                  className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-800 bg-slate-900 text-slate-400 hover:text-indigo-400 hover:border-slate-700 disabled:opacity-50 transition shrink-0"
                  title="Attach photo, camera snapshot, or document"
                >
                  {isUploading ? (
                    <Loader2 className="h-5 w-5 animate-spin text-indigo-400" />
                  ) : (
                    <Plus className="h-5 w-5" />
                  )}
                </button>

                {showAttachmentMenu && (
                  <div className="absolute bottom-14 left-0 z-40 w-52 rounded-2xl border border-slate-800 bg-slate-900/95 p-1.5 shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-2 duration-150">
                    <button
                      type="button"
                      onClick={() => {
                        setShowAttachmentMenu(false)
                        setShowCameraModal(true)
                      }}
                      className="flex items-center space-x-2.5 w-full rounded-xl px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800/80 hover:text-white transition"
                    >
                      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400">
                        <Camera className="h-4 w-4" />
                      </div>
                      <span>Take Photo</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setShowAttachmentMenu(false)
                        photoInputRef.current?.click()
                      }}
                      className="flex items-center space-x-2.5 w-full rounded-xl px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800/80 hover:text-white transition"
                    >
                      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-500/20 text-purple-400">
                        <ImageIcon className="h-4 w-4" />
                      </div>
                      <span>Photos & Videos</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setShowAttachmentMenu(false)
                        docInputRef.current?.click()
                      }}
                      className="flex items-center space-x-2.5 w-full rounded-xl px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800/80 hover:text-white transition"
                    >
                      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400">
                        <FolderOpen className="h-4 w-4" />
                      </div>
                      <span>Browse Documents</span>
                    </button>
                  </div>
                )}
              </div>

              <input
                ref={chatInputRef}
                type="text"
                value={inputText}
                onChange={handleInputChange}
                placeholder={
                  stagedFile
                    ? `Add a caption for ${stagedFile.name}...`
                    : activeConversation?.isDirect
                    ? `Message @${activeConversation.name} (E2EE encrypted)...`
                    : `Message #${activeConversation?.name || 'channel'}...`
                }
                className="flex-1 rounded-xl bg-slate-900 border border-slate-800 px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
              />

              <button
                type="button"
                onClick={() => setIsRecordingVoice(true)}
                disabled={isUploading}
                className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-800 bg-slate-900 text-slate-400 hover:text-indigo-400 hover:border-slate-700 disabled:opacity-50 transition shrink-0 shadow-sm"
                title="Record encrypted voice note"
              >
                <Mic className="h-5 w-5" />
              </button>

              <button
                type="submit"
                disabled={(!inputText.trim() && !stagedFile) || isUploading}
                className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 transition shrink-0 shadow-lg shadow-indigo-600/20"
                title="Send message (Enter)"
              >
                <Send className="h-5 w-5" />
              </button>
            </form>
          )}
        </div>
          </>
        )}
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
      <SafetyNumberModal
        isOpen={showSafetyModal}
        onClose={() => setShowSafetyModal(false)}
        currentUserId={user?.userId || ''}
        peerId={safetyPeerId}
        peerName={activeConversation?.name}
        safetyNumber={safetyNumber}
        onVerificationChange={(verified) => {
          setIsSafetyVerified(verified)
          setVerifiedPeerIds(SafetyNumberManager.getVerifiedPeerIds())
        }}
      />

      {/* --- Create Encrypted Group Chat Modal --- */}
      {showNewChanModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2">
                <Users className="h-5 w-5 text-cyan-400" />
                <h3 className="font-semibold text-slate-100">Create Encrypted Group Chat</h3>
              </div>
              <button onClick={() => setShowNewChanModal(false)} className="text-slate-400 hover:text-slate-200">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreateChannel} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Group Name
                </label>
                <div className="flex items-center rounded-xl border border-slate-800 bg-slate-950 px-3">
                  <span className="text-slate-500 text-sm">#</span>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Engineering Guild or Incident Response"
                    value={newChanName}
                    onChange={(e) => setNewChanName(e.target.value)}
                    className="w-full bg-transparent px-2 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none"
                    autoFocus
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Invite Members ({selectedGroupMembers.length} selected)
                </label>
                <div className="max-h-44 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950 p-2 space-y-1">
                  {isLoadingUsers ? (
                    <div className="flex items-center justify-center py-4 text-xs text-slate-500 space-x-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Loading user directory...</span>
                    </div>
                  ) : availableUsers.filter((u) => !u.isSelf).length === 0 ? (
                    <p className="text-xs text-slate-500 p-2 text-center">No other users registered yet.</p>
                  ) : (
                    availableUsers
                      .filter((u) => !u.isSelf)
                      .map((u) => {
                        const isSelected = selectedGroupMembers.includes(u.userId)
                        return (
                          <label
                            key={u.userId}
                            className={`flex items-center justify-between p-2 rounded-lg cursor-pointer transition text-xs ${
                              isSelected
                                ? 'bg-cyan-600/20 text-cyan-200 border border-cyan-500/30'
                                : 'text-slate-300 hover:bg-slate-900'
                            }`}
                          >
                            <div className="flex items-center space-x-2 truncate">
                              <User className="h-3.5 w-3.5 text-slate-400" />
                              <span className="truncate font-medium">{u.displayName || u.userId.slice(0, 8)}</span>
                            </div>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedGroupMembers((prev) => [...prev, u.userId])
                                } else {
                                  setSelectedGroupMembers((prev) => prev.filter((id) => id !== u.userId))
                                }
                              }}
                              className="rounded border-slate-700 bg-slate-900 text-cyan-600 focus:ring-0"
                            />
                          </label>
                        )
                      })
                  )}
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
                  className="rounded-xl bg-cyan-600 px-4 py-2 text-xs font-medium text-white hover:bg-cyan-500 transition"
                >
                  Create Group
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- Start New Direct Message / User Discovery Modal --- */}
      {showNewDmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600/20 text-indigo-400">
                  <UserPlus className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="font-semibold text-slate-100 text-sm">Start a Conversation</h3>
                  <p className="text-[11px] text-slate-400">End-to-End Encrypted Direct Messaging</p>
                </div>
              </div>
              <button
                onClick={() => {
                  setShowNewDmModal(false)
                  setUserSearchQuery('')
                  setNewDmUserId('')
                }}
                className="text-slate-400 hover:text-slate-200 transition p-1 rounded-lg hover:bg-slate-800"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Real-time search or direct ID input */}
            <div className="space-y-3">
              <div className="relative">
                <Search className="absolute left-3 top-3 h-4 w-4 text-slate-500" />
                <input
                  type="text"
                  placeholder="Search by name or type User ID..."
                  value={userSearchQuery}
                  onChange={(e) => setUserSearchQuery(e.target.value)}
                  className="w-full rounded-xl border border-slate-800 bg-slate-950 pl-9 pr-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                  autoFocus
                />
              </div>

              {/* Registered Users Discovery List */}
              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 px-1 pt-1">
                  Registered Users
                </p>

                {isLoadingUsers ? (
                  <div className="flex items-center justify-center py-6 text-slate-400 space-x-2">
                    <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
                    <span className="text-xs">Loading directory...</span>
                  </div>
                ) : (
                  <div className="max-h-60 overflow-y-auto space-y-1 pr-1">
                    {/* Filtered users list */}
                    {availableUsers
                      .filter((u) => !u.isSelf)
                      .filter((u) => {
                        const q = userSearchQuery.trim().toLowerCase()
                        if (!q) return true
                        return (
                          u.displayName?.toLowerCase().includes(q) ||
                          u.userId.toLowerCase().includes(q)
                        )
                      })
                      .map((u) => (
                        <div
                          key={u.userId}
                          onClick={() => handleSelectUser(u.userId, u.displayName)}
                          className="flex items-center justify-between p-2.5 rounded-xl border border-slate-800/60 bg-slate-950/40 hover:bg-indigo-600/10 hover:border-indigo-500/30 cursor-pointer transition group"
                        >
                          <div className="flex items-center space-x-3 min-w-0">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-600/20 text-indigo-300 font-semibold text-xs border border-indigo-500/30">
                              {(u.displayName || u.userId).slice(0, 2).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-slate-200 group-hover:text-indigo-200 truncate">
                                {u.displayName || 'Anonymous User'}
                              </p>
                              <p className="text-[10px] font-mono text-slate-500 truncate">
                                {u.userId}
                              </p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleSelectUser(u.userId, u.displayName)
                            }}
                            className="shrink-0 rounded-lg bg-indigo-600/80 hover:bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white transition"
                          >
                            Message
                          </button>
                        </div>
                      ))}

                    {/* If custom query doesn't match any registered user, allow direct messaging */}
                    {userSearchQuery.trim() && (
                      <div
                        onClick={() => handleSelectUser(userSearchQuery.trim())}
                        className="flex items-center justify-between p-2.5 rounded-xl border border-dashed border-indigo-500/40 bg-indigo-950/20 hover:bg-indigo-950/40 cursor-pointer transition"
                      >
                        <div className="flex items-center space-x-2 truncate">
                          <UserPlus className="h-4 w-4 text-indigo-400 shrink-0" />
                          <span className="text-xs text-indigo-200 truncate">
                            Message custom ID: <strong className="text-white">@{userSearchQuery.trim()}</strong>
                          </span>
                        </div>
                        <button
                          type="button"
                          className="shrink-0 rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white"
                        >
                          Chat
                        </button>
                      </div>
                    )}

                    {!isLoadingUsers && availableUsers.filter((u) => !u.isSelf).length === 0 && !userSearchQuery.trim() && (
                      <div className="py-4 text-center text-xs text-slate-500">
                        No other registered users found in directory.
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex justify-end pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setShowNewDmModal(false)
                    setUserSearchQuery('')
                    setNewDmUserId('')
                  }}
                  className="rounded-xl px-4 py-2 text-xs font-medium text-slate-400 hover:bg-slate-800 transition"
                >
                  Close
                </button>
              </div>
            </div>
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

      {/* Live Camera Snapshot Modal */}
      <CameraModal
        isOpen={showCameraModal}
        onClose={() => setShowCameraModal(false)}
        onCapture={handleCameraCapture}
      />

      {/* Full-Screen Decrypted Image Lightbox */}
      <ImageViewerModal
        isOpen={Boolean(viewerImage)}
        onClose={() => setViewerImage(null)}
        imageUrl={viewerImage?.url || ''}
        fileName={viewerImage?.fileName}
        fileSize={viewerImage?.fileSize}
      />

      {/* Dynamic MLS Group Members & Info Modal */}
      <GroupMembersModal
        isOpen={isGroupModalOpen}
        onClose={() => setIsGroupModalOpen(false)}
        channelId={activeChannelId}
        channelName={activeConversation?.name || 'Group'}
        currentUserId={user?.userId || ''}
        accessToken={sessionStorage.getItem('genchat_token') || ''}
        wsSend={(frame) => gatewayRef.current?.sendRaw(frame)}
        onLeftGroup={() => {
          setActiveChannelId('')
          setIsGroupModalOpen(false)
        }}
      />

      {/* Zero-Knowledge Conversation Summarizer Modal */}
      <SummaryModal
        isOpen={isSummaryModalOpen}
        onClose={() => setIsSummaryModalOpen(false)}
        channelName={activeConversation?.name || 'Chat'}
        messages={currentMessages
          .filter(m => Boolean(m.text))
          .map(m => ({ text: m.text!, sender: m.senderId === user?.userId ? 'You' : m.senderId }))}
      />

      {/* Disappearing / Ephemeral Messages Modal */}
      <EphemeralSettingsModal
        isOpen={isEphemeralModalOpen}
        currentTtlSec={currentChannelTtl}
        channelName={activeConversation?.name || 'Conversation'}
        onClose={() => setIsEphemeralModalOpen(false)}
        onSave={handleSaveEphemeralTtl}
      />
    </div>
  )
}
