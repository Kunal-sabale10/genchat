/**
 * WebRtcManager — Peer-to-Peer Audio/Video Calling Manager
 *
 * Handles:
 * 1. Local media capture (microphone + camera).
 * 2. WebRTC PeerConnection with standard STUN servers.
 * 3. SDP Offer / Answer handshake.
 * 4. ICE candidate queuing and dispatch.
 * 5. Track-level mute and camera disable toggles.
 * 6. Clean media stream and connection release.
 */

export interface WebRtcCallbacks {
  onLocalStream?: (stream: MediaStream) => void
  onRemoteStream?: (stream: MediaStream) => void
  onIceCandidate?: (candidate: RTCIceCandidate) => void
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void
  onError?: (err: Error) => void
  iceServers?: RTCIceServer[]
  allowSyntheticFallback?: boolean
}

export const DEFAULT_ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 2,
}

let cachedIceServers: RTCIceServer[] | null = null
let cachedIceServersExpiresAt = 0

/**
 * Dynamically fetches ephemeral RFC 7635 TURN credentials from authd.
 * Caches credentials in-memory until near expiry.
 */
export async function fetchDynamicIceServers(accessToken?: string): Promise<RTCIceServer[]> {
  const now = Date.now()
  if (cachedIceServers && cachedIceServersExpiresAt > now + 60000) {
    return cachedIceServers
  }

  const token =
    accessToken ||
    (typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem('genchat_access_token')
      : null)

  if (!token) {
    return DEFAULT_ICE_SERVERS.iceServers || []
  }

  const authBaseUrl = (import.meta as any).env?.VITE_AUTH_URL || ''
  try {
    const res = await fetch(`${authBaseUrl}/chat.v1.AuthService/GetIceServers`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    if (!res.ok) {
      console.warn(`[WebRTC] Failed to fetch dynamic ICE servers (${res.status}), using STUN fallback`)
      return DEFAULT_ICE_SERVERS.iceServers || []
    }
    const data = await res.json()
    if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      cachedIceServers = data.iceServers
      const ttlMs = ((data.ttl as number) || 3600) * 1000
      cachedIceServersExpiresAt = now + ttlMs
      return data.iceServers
    }
  } catch (err) {
    console.warn('[WebRTC] Error fetching dynamic ICE servers:', err)
  }

  return DEFAULT_ICE_SERVERS.iceServers || []
}

export function getIceConfiguration(customServers?: RTCIceServer[]): RTCConfiguration {
  if (customServers && customServers.length > 0) {
    return { iceServers: customServers, iceCandidatePoolSize: 2 }
  }

  if (cachedIceServers && cachedIceServers.length > 0) {
    return { iceServers: cachedIceServers, iceCandidatePoolSize: 2 }
  }

  const envServers = (import.meta as any).env?.VITE_ICE_SERVERS
  if (envServers) {
    try {
      const parsed = typeof envServers === 'string' ? JSON.parse(envServers) : envServers
      return { iceServers: parsed, iceCandidatePoolSize: 2 }
    } catch {
      console.warn('[WebRTC] Could not parse VITE_ICE_SERVERS, using default STUN configuration')
    }
  }

  return DEFAULT_ICE_SERVERS
}

function createFallbackVideoTrack(label: string): MediaStreamTrack {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 480
  const ctx = canvas.getContext('2d')!

  let angle = 0
  const draw = () => {
    ctx.fillStyle = '#090d16'
    ctx.fillRect(0, 0, 640, 480)

    const cx = 320
    const cy = 200
    const radius = 60 + Math.sin(angle) * 6

    const grad = ctx.createRadialGradient(cx, cy, 20, cx, cy, radius + 20)
    grad.addColorStop(0, '#6366f1')
    grad.addColorStop(1, '#4338ca22')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(cx, cy - 10, 22, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.arc(cx, cy + 32, 34, Math.PI, Math.PI * 2)
    ctx.fill()

    ctx.font = 'bold 18px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillStyle = '#cbd5e1'
    ctx.fillText(label, 320, 310)

    ctx.font = '13px sans-serif'
    ctx.fillStyle = '#94a3b8'
    ctx.fillText('(Simulated Camera Feed)', 320, 335)

    angle += 0.05
  }

  const intervalId = setInterval(draw, 100)
  draw()

  const stream = (canvas as any).captureStream(15)
  const track = stream.getVideoTracks()[0]

  const originalStop = track.stop.bind(track)
  track.stop = () => {
    clearInterval(intervalId)
    originalStop()
  }

  return track
}

export const HIGH_QUALITY_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: { ideal: true },
  noiseSuppression: { ideal: true },
  autoGainControl: { ideal: true },
  channelCount: { ideal: 1 }, // Pure mono eliminates stereo comb filtering & phase cancellation
  sampleRate: { ideal: 48000 },
  sampleSize: { ideal: 16 },
  ...({
    googEchoCancellation: { ideal: true },
    googAutoGainControl: { ideal: true },
    googNoiseSuppression: { ideal: true },
    googHighpassFilter: { ideal: true },
    googTypingNoiseDetection: { ideal: true },
  } as any),
}

function createSilentAudioTrack(): MediaStreamTrack {
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
  const ctx = new AudioContextClass({ sampleRate: 48000 })
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  gain.gain.value = 0.0
  const dst = ctx.createMediaStreamDestination()
  osc.connect(gain)
  gain.connect(dst)
  osc.start()
  return dst.stream.getAudioTracks()[0]
}

/**
 * Munges SDP to enforce high-fidelity Opus voice codec settings:
 * - in-band Forward Error Correction (useinbandfec=1) heals lost packets
 * - discontinuous transmission (usedtx=1) eliminates silence crackles
 * - stable high-res voice bitrate (maxaveragebitrate=64000)
 * - strict mono voice (stereo=0;sprop-stereo=0) prevents phase distortion
 * - 20ms audio frame packetization (minptime=10;maxptime=20;cbr=1)
 */
export function optimizeAudioSdp(sdp: string): string {
  if (!sdp) return sdp
  const lines = sdp.split('\r\n')
  let opusPt: string | null = null

  for (const line of lines) {
    const match = line.match(/^a=rtpmap:(\d+)\s+opus\/48000/i)
    if (match) {
      opusPt = match[1]
      break
    }
  }

  if (!opusPt) return sdp

  const enhancedParams = 'minptime=10;maxptime=20;useinbandfec=1;usedtx=1;maxaveragebitrate=64000;stereo=0;sprop-stereo=0;cbr=1'
  let foundFmtp = false

  const newLines = lines.map((line) => {
    if (line.startsWith(`a=fmtp:${opusPt} `)) {
      foundFmtp = true
      let params = line.substring(`a=fmtp:${opusPt} `.length)
      if (!params.includes('useinbandfec=')) params += ';useinbandfec=1'
      if (!params.includes('usedtx=')) params += ';usedtx=1'
      if (!params.includes('maxaveragebitrate=')) params += ';maxaveragebitrate=64000'
      if (!params.includes('stereo=')) params += ';stereo=0;sprop-stereo=0'
      if (!params.includes('cbr=')) params += ';cbr=1'
      if (!params.includes('minptime=')) params += ';minptime=10;maxptime=20'
      return `a=fmtp:${opusPt} ${params}`
    }
    return line
  })

  if (!foundFmtp) {
    const rtpmapIdx = newLines.findIndex((l) => l.startsWith(`a=rtpmap:${opusPt} `))
    if (rtpmapIdx !== -1) {
      newLines.splice(rtpmapIdx + 1, 0, `a=fmtp:${opusPt} ${enhancedParams}`)
    }
  }

  return newLines.join('\r\n')
}

export class WebRtcManager {
  private pc: RTCPeerConnection | null = null
  private localStream: MediaStream | null = null
  private remoteStream: MediaStream | null = null
  private pendingCandidates: RTCIceCandidateInit[] = []
  private isRemoteDescriptionSet = false

  public isAudioMuted = false
  public isVideoDisabled = false

  constructor(private callbacks: WebRtcCallbacks = {}) {}

  /**
   * Acquire local camera and microphone stream with graceful fallbacks
   */
  public async startLocalStream(callType: 'audio' | 'video'): Promise<MediaStream> {
    if (this.localStream) {
      return this.localStream
    }

    let audioTrack: MediaStreamTrack | null = null
    let videoTrack: MediaStreamTrack | null = null

    // 1. Attempt to acquire real hardware media streams with high-quality acoustic processing
    try {
      const constraints: MediaStreamConstraints = {
        audio: HIGH_QUALITY_AUDIO_CONSTRAINTS,
        video:
          callType === 'video'
            ? {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: 'user',
              }
            : false,
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      audioTrack = stream.getAudioTracks()[0] || null
      if (callType === 'video') {
        videoTrack = stream.getVideoTracks()[0] || null
      }
    } catch (primaryErr) {
      console.warn('[WebRTC] Primary getUserMedia failed, attempting graceful fallback:', primaryErr)

      // If video failed (e.g. exclusive lock on same PC or camera in use), try audio only with AEC
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({
          audio: HIGH_QUALITY_AUDIO_CONSTRAINTS,
        })
      } catch (audioErr) {
        const isDev = Boolean((import.meta as any).env?.DEV)
        const allowFallback = this.callbacks.allowSyntheticFallback ?? isDev
        if (allowFallback) {
          console.warn('[WebRTC] Microphone unavailable, using silent audio fallback (dev mode):', audioErr)
          try {
            audioTrack = createSilentAudioTrack()
          } catch {
            // WebAudio unavailable
          }
        } else {
          throw new Error('Microphone access failed: device unavailable or permission denied.')
        }
      }

      // If call is video and videoTrack is still null, check if synthetic fallback is allowed
      const isDev = Boolean((import.meta as any).env?.DEV)
      const allowFallback = this.callbacks.allowSyntheticFallback ?? isDev
      if (callType === 'video' && !videoTrack) {
        if (allowFallback) {
          console.info('[WebRTC] Generating synthetic camera feed (dev mode: webcam busy or unavailable)')
          videoTrack = createFallbackVideoTrack('Camera Busy / Shared PC Test')
        } else {
          throw new Error('Camera access failed: device unavailable or permission denied.')
        }
      }
    }

    const tracks: MediaStreamTrack[] = []
    if (audioTrack) tracks.push(audioTrack)
    if (videoTrack) tracks.push(videoTrack)

    if (tracks.length === 0) {
      const err = new Error('Could not acquire audio or video stream')
      this.callbacks.onError?.(err)
      throw err
    }

    this.localStream = new MediaStream(tracks)
    this.callbacks.onLocalStream?.(this.localStream)
    return this.localStream
  }

  /**
   * Initialize RTCPeerConnection and attach local media tracks
   */
  public initPeerConnection(): RTCPeerConnection {
    if (this.pc) {
      return this.pc
    }

    const iceConfig = getIceConfiguration(this.callbacks.iceServers)
    this.pc = new RTCPeerConnection(iceConfig)
    this.remoteStream = new MediaStream()
    this.callbacks.onRemoteStream?.(this.remoteStream)

    // Attach local stream tracks
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        this.pc.addTrack(track, this.localStream)
      }
    }

    // Handle inbound remote tracks
    this.pc.ontrack = (event) => {
      console.log('[WebRTC] Received remote track:', event.track.kind, event.track.id)
      if (event.streams && event.streams[0]) {
        this.remoteStream = event.streams[0]
      } else {
        if (!this.remoteStream) {
          this.remoteStream = new MediaStream()
        }
        if (!this.remoteStream.getTracks().some((t) => t.id === event.track.id)) {
          this.remoteStream.addTrack(event.track)
        }
      }
      this.callbacks.onRemoteStream?.(this.remoteStream)
    }

    // Handle ICE candidates
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('[WebRTC] Local ICE candidate gathered')
        this.callbacks.onIceCandidate?.(event.candidate)
      }
    }

    // Handle connection state transitions
    this.pc.onconnectionstatechange = () => {
      if (!this.pc) return
      console.log('[WebRTC] Connection state:', this.pc.connectionState)
      this.callbacks.onConnectionStateChange?.(this.pc.connectionState)
    }

    return this.pc
  }

  /**
   * Prioritize audio packets over video packets in the WebRTC transmission pipeline
   */
  private configureSenders(): void {
    if (!this.pc) return
    const senders = this.pc.getSenders()
    for (const sender of senders) {
      if (sender.track?.kind === 'audio') {
        try {
          const params = sender.getParameters()
          if (params.encodings && params.encodings.length > 0) {
            params.encodings[0].maxBitrate = 64000
            params.encodings[0].networkPriority = 'high' as any
            params.encodings[0].priority = 'high' as any
            sender.setParameters(params).catch(() => {})
          }
        } catch {
          // sender parameter mutations not supported on this browser version
        }
      }
    }
  }

  /**
   * Create SDP Offer for outgoing calls with voice optimization
   */
  public async createOffer(): Promise<RTCSessionDescriptionInit> {
    const pc = this.initPeerConnection()
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    })
    const optimizedSdp = optimizeAudioSdp(offer.sdp || '')
    const desc = new RTCSessionDescription({ type: 'offer', sdp: optimizedSdp })
    await pc.setLocalDescription(desc)
    this.configureSenders()
    return desc
  }

  /**
   * Accept incoming SDP Offer and create SDP Answer with voice optimization
   */
  public async handleOffer(sdp: string): Promise<RTCSessionDescriptionInit> {
    const pc = this.initPeerConnection()
    const optimizedRemoteSdp = optimizeAudioSdp(sdp)
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: optimizedRemoteSdp }))
    this.isRemoteDescriptionSet = true

    // Drain queued ICE candidates
    await this.drainPendingCandidates()

    const answer = await pc.createAnswer()
    const optimizedLocalSdp = optimizeAudioSdp(answer.sdp || '')
    const desc = new RTCSessionDescription({ type: 'answer', sdp: optimizedLocalSdp })
    await pc.setLocalDescription(desc)
    this.configureSenders()
    return desc
  }

  /**
   * Apply remote SDP Answer on caller side
   */
  public async handleAnswer(sdp: string): Promise<void> {
    if (!this.pc) return
    const optimizedRemoteSdp = optimizeAudioSdp(sdp)
    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: optimizedRemoteSdp }))
    this.isRemoteDescriptionSet = true

    // Drain queued ICE candidates
    await this.drainPendingCandidates()
    this.configureSenders()
  }

  /**
   * Add incoming ICE candidate from peer, or buffer if remote description is pending
   */
  public async addIceCandidate(candidateInit: RTCIceCandidateInit): Promise<void> {
    if (!this.pc || !this.isRemoteDescriptionSet) {
      this.pendingCandidates.push(candidateInit)
      return
    }

    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidateInit))
    } catch (err) {
      console.warn('[WebRTC] Error adding ICE candidate:', err)
    }
  }

  private async drainPendingCandidates(): Promise<void> {
    if (!this.pc || !this.isRemoteDescriptionSet) return
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift()
      if (candidate) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate))
        } catch (err) {
          console.warn('[WebRTC] Error draining ICE candidate:', err)
        }
      }
    }
  }

  /**
   * Toggle microphone mute state
   */
  public toggleAudio(muted?: boolean): boolean {
    if (!this.localStream) return false
    const audioTrack = this.localStream.getAudioTracks()[0]
    if (!audioTrack) return false

    this.isAudioMuted = muted !== undefined ? muted : !this.isAudioMuted
    audioTrack.enabled = !this.isAudioMuted
    return this.isAudioMuted
  }

  /**
   * Toggle camera enable/disable state
   */
  public toggleVideo(disabled?: boolean): boolean {
    if (!this.localStream) return false
    const videoTrack = this.localStream.getVideoTracks()[0]
    if (!videoTrack) return false

    this.isVideoDisabled = disabled !== undefined ? disabled : !this.isVideoDisabled
    videoTrack.enabled = !this.isVideoDisabled
    return this.isVideoDisabled
  }

  /**
   * Hang up and clean up all hardware tracks and network connections
   */
  public hangup(): void {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        track.stop()
      })
      this.localStream = null
    }

    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach((track) => {
        track.stop()
      })
      this.remoteStream = null
    }

    if (this.pc) {
      this.pc.close()
      this.pc = null
    }

    this.pendingCandidates = []
    this.isRemoteDescriptionSet = false
    this.isAudioMuted = false
    this.isVideoDisabled = false
    console.log('[WebRTC] Call session terminated and hardware released')
  }
}
