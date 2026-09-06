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
}

const DEFAULT_ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
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
   * Acquire local camera and microphone stream
   */
  public async startLocalStream(callType: 'audio' | 'video'): Promise<MediaStream> {
    if (this.localStream) {
      return this.localStream
    }

    const constraints: MediaStreamConstraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video:
        callType === 'video'
          ? {
              width: { ideal: 1280 },
              height: { ideal: 720 },
              facingMode: 'user',
            }
          : false,
    }

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints)
      this.callbacks.onLocalStream?.(this.localStream)
      return this.localStream
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to acquire media stream')
      this.callbacks.onError?.(error)
      throw error
    }
  }

  /**
   * Initialize RTCPeerConnection and attach local media tracks
   */
  public initPeerConnection(): RTCPeerConnection {
    if (this.pc) {
      return this.pc
    }

    this.pc = new RTCPeerConnection(DEFAULT_ICE_SERVERS)
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
      console.log('[WebRTC] Received remote track:', event.track.kind)
      if (this.remoteStream) {
        event.streams[0]?.getTracks().forEach((track) => {
          if (!this.remoteStream!.getTracks().some((t) => t.id === track.id)) {
            this.remoteStream!.addTrack(track)
          }
        })
      }
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
   * Create SDP Offer for outgoing calls
   */
  public async createOffer(): Promise<RTCSessionDescriptionInit> {
    const pc = this.initPeerConnection()
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    })
    await pc.setLocalDescription(offer)
    return offer
  }

  /**
   * Accept incoming SDP Offer and create SDP Answer
   */
  public async handleOffer(sdp: string): Promise<RTCSessionDescriptionInit> {
    const pc = this.initPeerConnection()
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }))
    this.isRemoteDescriptionSet = true

    // Drain queued ICE candidates
    await this.drainPendingCandidates()

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    return answer
  }

  /**
   * Apply remote SDP Answer on caller side
   */
  public async handleAnswer(sdp: string): Promise<void> {
    if (!this.pc) return
    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }))
    this.isRemoteDescriptionSet = true

    // Drain queued ICE candidates
    await this.drainPendingCandidates()
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
