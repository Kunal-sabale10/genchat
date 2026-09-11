/**
 * GroupWebRtcManager — Full-Mesh Multi-Party Audio/Video Calling Manager
 *
 * Capabilities:
 * 1. Multi-peer RTCPeerConnection orchestration (P2P full mesh).
 * 2. Shared local MediaStream distribution across all active peer connections.
 * 3. Screen sharing with seamless in-place track replacement (replaceTrack).
 * 4. Dynamic peer joining and leaving.
 * 5. Web Audio API AnalyserNode active speaker detection.
 * 6. Headless fallback tracks (canvas camera & silent audio) for camera-less/automated environments.
 */

import {
  DEFAULT_ICE_SERVERS,
  getIceConfiguration,
  optimizeAudioSdp,
  HIGH_QUALITY_AUDIO_CONSTRAINTS,
} from './webrtc-manager'

export interface GroupWebRtcCallbacks {
  onLocalStream?: (stream: MediaStream) => void
  onPeerStream?: (peerId: string, stream: MediaStream) => void
  onPeerLeft?: (peerId: string) => void
  onActiveSpeakerChange?: (activeSpeakerId: string | null) => void
  onSignal?: (signal: {
    targetUserId: string
    signalType: 'offer' | 'answer' | 'ice_candidate'
    sdp?: string
    candidate?: any
  }) => void
  onError?: (err: Error) => void
  iceServers?: RTCIceServer[]
}

interface PeerConnectionItem {
  peerId: string
  pc: RTCPeerConnection
  remoteStream: MediaStream
  pendingCandidates: RTCIceCandidateInit[]
  isRemoteDescriptionSet: boolean
}

export class GroupWebRtcManager {
  private peers: Map<string, PeerConnectionItem> = new Map()
  private localStream: MediaStream | null = null
  private screenStream: MediaStream | null = null
  private cameraVideoTrack: MediaStreamTrack | null = null
  private callbacks: GroupWebRtcCallbacks
  private iceConfig: RTCConfiguration

  public isAudioMuted = false
  public isVideoDisabled = false
  public isScreenSharing = false

  // Active speaker detection state
  private audioContext: AudioContext | null = null
  private localAnalyser: AnalyserNode | null = null
  private peerAnalysers: Map<string, AnalyserNode> = new Map()
  private speakerDetectionTimer: any = null
  private currentActiveSpeakerId: string | null = null

  constructor(callbacks: GroupWebRtcCallbacks) {
    this.callbacks = callbacks
    this.iceConfig = getIceConfiguration(callbacks.iceServers)
  }

  /**
   * Acquire local camera and microphone stream.
   */
  public async startLocalStream(type: 'audio' | 'video' = 'video'): Promise<MediaStream> {
    try {
      if (navigator?.mediaDevices?.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: HIGH_QUALITY_AUDIO_CONSTRAINTS,
            video:
              type === 'video'
                ? {
                    width: { ideal: 1280, max: 1920 },
                    height: { ideal: 720, max: 1080 },
                    frameRate: { ideal: 30, max: 60 },
                    facingMode: 'user',
                  }
                : false,
          })
          this.localStream = stream
        } catch (mediaErr) {
          console.warn('[GroupWebRtc] getUserMedia failed, creating fallback stream:', mediaErr)
          this.localStream = this.createFallbackStream(type)
        }
      } else {
        this.localStream = this.createFallbackStream(type)
      }
    } catch (err) {
      console.warn('[GroupWebRtc] Fallback to synthetic media:', err)
      this.localStream = this.createFallbackStream(type)
    }

    const videoTrack = this.localStream.getVideoTracks()[0]
    if (videoTrack) {
      this.cameraVideoTrack = videoTrack
    }

    this.callbacks.onLocalStream?.(this.localStream)
    this.setupActiveSpeakerDetection()
    return this.localStream
  }

  /**
   * Add a remote peer to the mesh.
   * If isInitiator is true, this client generates and dispatches an SDP offer to peerId.
   */
  public async addPeer(peerId: string, isInitiator: boolean): Promise<void> {
    if (this.peers.has(peerId)) {
      console.log(`[GroupWebRtc] Peer ${peerId} already connected, skipping creation`)
      return
    }

    console.log(`[GroupWebRtc] Initializing peer connection with: ${peerId} (isInitiator=${isInitiator})`)
    const pc = new RTCPeerConnection(this.iceConfig)
    const remoteStream = new MediaStream()

    const item: PeerConnectionItem = {
      peerId,
      pc,
      remoteStream,
      pendingCandidates: [],
      isRemoteDescriptionSet: false,
    }
    this.peers.set(peerId, item)

    // Attach local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!)
      })
    }

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.callbacks.onSignal?.({
          targetUserId: peerId,
          signalType: 'ice_candidate',
          candidate: event.candidate.toJSON(),
        })
      }
    }

    // Handle incoming remote media tracks
    pc.ontrack = (event) => {
      console.log(`[GroupWebRtc] Received track (${event.track.kind}) from peer: ${peerId}`)
      remoteStream.addTrack(event.track)
      this.callbacks.onPeerStream?.(peerId, remoteStream)

      if (event.track.kind === 'audio') {
        this.attachPeerAudioAnalyser(peerId, remoteStream)
      }
    }

    pc.onconnectionstatechange = () => {
      console.log(`[GroupWebRtc] Peer ${peerId} state: ${pc.connectionState}`)
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.removePeer(peerId)
      }
    }

    // If initiator, send offer
    if (isInitiator) {
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        })
        const enhancedSdp = optimizeAudioSdp(offer.sdp || '')
        await pc.setLocalDescription(new RTCSessionDescription({ type: 'offer', sdp: enhancedSdp }))

        this.callbacks.onSignal?.({
          targetUserId: peerId,
          signalType: 'offer',
          sdp: enhancedSdp,
        })
      } catch (err: any) {
        console.error(`[GroupWebRtc] Failed to create offer for peer ${peerId}:`, err)
        this.callbacks.onError?.(err)
      }
    }
  }

  /**
   * Handle incoming SDP offer from a peer in the group.
   */
  public async handleOffer(peerId: string, sdp: string): Promise<void> {
    console.log(`[GroupWebRtc] Handling offer from: ${peerId}`)
    let item = this.peers.get(peerId)
    if (!item) {
      await this.addPeer(peerId, false)
      item = this.peers.get(peerId)!
    }

    const { pc } = item
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }))
      item.isRemoteDescriptionSet = true

      // Drain queued ICE candidates
      if (item.pendingCandidates.length > 0) {
        for (const cand of item.pendingCandidates) {
          await pc.addIceCandidate(new RTCIceCandidate(cand))
        }
        item.pendingCandidates = []
      }

      const answer = await pc.createAnswer()
      const enhancedSdp = optimizeAudioSdp(answer.sdp || '')
      await pc.setLocalDescription(new RTCSessionDescription({ type: 'answer', sdp: enhancedSdp }))

      this.callbacks.onSignal?.({
        targetUserId: peerId,
        signalType: 'answer',
        sdp: enhancedSdp,
      })
    } catch (err: any) {
      console.error(`[GroupWebRtc] Error handling offer from peer ${peerId}:`, err)
      this.callbacks.onError?.(err)
    }
  }

  /**
   * Handle incoming SDP answer from a peer in the group.
   */
  public async handleAnswer(peerId: string, sdp: string): Promise<void> {
    console.log(`[GroupWebRtc] Handling answer from: ${peerId}`)
    const item = this.peers.get(peerId)
    if (!item) {
      console.warn(`[GroupWebRtc] No peer connection found for answer from: ${peerId}`)
      return
    }

    const { pc } = item
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }))
      item.isRemoteDescriptionSet = true

      // Drain queued ICE candidates
      if (item.pendingCandidates.length > 0) {
        for (const cand of item.pendingCandidates) {
          await pc.addIceCandidate(new RTCIceCandidate(cand))
        }
        item.pendingCandidates = []
      }
    } catch (err: any) {
      console.error(`[GroupWebRtc] Error handling answer from peer ${peerId}:`, err)
      this.callbacks.onError?.(err)
    }
  }

  /**
   * Handle incoming ICE candidate from a peer.
   */
  public async handleIceCandidate(peerId: string, candidateInit: any): Promise<void> {
    const item = this.peers.get(peerId)
    if (!item) {
      console.warn(`[GroupWebRtc] Buffered ICE candidate for unknown peer ${peerId}`)
      return
    }

    if (item.isRemoteDescriptionSet && item.pc.remoteDescription) {
      try {
        await item.pc.addIceCandidate(new RTCIceCandidate(candidateInit))
      } catch (err) {
        console.warn(`[GroupWebRtc] Failed adding ICE candidate for peer ${peerId}:`, err)
      }
    } else {
      item.pendingCandidates.push(candidateInit)
    }
  }

  /**
   * Remove a peer when they leave the call or disconnect.
   */
  public removePeer(peerId: string): void {
    const item = this.peers.get(peerId)
    if (!item) return

    console.log(`[GroupWebRtc] Removing peer: ${peerId}`)
    try {
      item.pc.close()
    } catch {}

    this.peers.delete(peerId)
    this.peerAnalysers.delete(peerId)

    this.callbacks.onPeerLeft?.(peerId)
    if (this.currentActiveSpeakerId === peerId) {
      this.currentActiveSpeakerId = null
      this.callbacks.onActiveSpeakerChange?.(null)
    }
  }

  /**
   * Toggle local microphone mute state.
   */
  public toggleAudio(): boolean {
    if (!this.localStream) return false
    const audioTrack = this.localStream.getAudioTracks()[0]
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled
      this.isAudioMuted = !audioTrack.enabled
    }
    return this.isAudioMuted
  }

  /**
   * Toggle local camera video state.
   */
  public toggleVideo(): boolean {
    if (!this.localStream) return false
    const videoTrack = this.localStream.getVideoTracks()[0]
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled
      this.isVideoDisabled = !videoTrack.enabled
    }
    return this.isVideoDisabled
  }

  /**
   * Start screen sharing and replace outgoing video track across all mesh peers.
   */
  public async startScreenShare(): Promise<MediaStream | null> {
    if (!navigator?.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen sharing is not supported by your browser')
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'monitor',
        } as any,
        audio: false,
      })

      const screenTrack = stream.getVideoTracks()[0]
      if (!screenTrack) return null

      this.screenStream = stream
      this.isScreenSharing = true

      // Replace track on all active peer connections
      for (const item of this.peers.values()) {
        const sender = item.pc.getSenders().find((s) => s.track?.kind === 'video')
        if (sender) {
          await sender.replaceTrack(screenTrack)
        }
      }

      // Revert automatically when user clicks browser's "Stop Sharing" button
      screenTrack.onended = () => {
        this.stopScreenShare()
      }

      return stream
    } catch (err) {
      console.warn('[GroupWebRtc] User cancelled or screen share failed:', err)
      return null
    }
  }

  /**
   * Stop screen sharing and restore camera video track.
   */
  public async stopScreenShare(): Promise<void> {
    if (!this.isScreenSharing) return

    if (this.screenStream) {
      this.screenStream.getTracks().forEach((t) => t.stop())
      this.screenStream = null
    }

    this.isScreenSharing = false

    // Restore camera video track on all peer connections
    if (this.cameraVideoTrack) {
      for (const item of this.peers.values()) {
        const sender = item.pc.getSenders().find((s) => s.track?.kind === 'video')
        if (sender) {
          await sender.replaceTrack(this.cameraVideoTrack)
        }
      }
    }
  }

  /**
   * Get all active peers in the group call.
   */
  public getConnectedPeerIds(): string[] {
    return Array.from(this.peers.keys())
  }

  /**
   * Set up Web Audio AnalyserNode to detect active speaker volume.
   */
  private setupActiveSpeakerDetection(): void {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
      if (!AudioContextClass) return

      this.audioContext = new AudioContextClass()
      if (this.localStream && this.localStream.getAudioTracks().length > 0) {
        const source = this.audioContext.createMediaStreamSource(this.localStream)
        const analyser = this.audioContext.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.3
        source.connect(analyser)
        this.localAnalyser = analyser
      }

      // Periodically poll audio volumes
      this.speakerDetectionTimer = setInterval(() => {
        this.pollActiveSpeaker()
      }, 200)
    } catch (err) {
      console.warn('[GroupWebRtc] Active speaker detection setup error:', err)
    }
  }

  private attachPeerAudioAnalyser(peerId: string, stream: MediaStream): void {
    if (!this.audioContext || stream.getAudioTracks().length === 0) return
    try {
      const source = this.audioContext.createMediaStreamSource(stream)
      const analyser = this.audioContext.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.3
      source.connect(analyser)
      this.peerAnalysers.set(peerId, analyser)
    } catch (err) {
      console.warn(`[GroupWebRtc] Failed to attach audio analyser for peer ${peerId}:`, err)
    }
  }

  private pollActiveSpeaker(): void {
    const SPEECH_THRESHOLD = 0.08
    let maxVol = 0
    let loudestSpeaker: string | null = null

    // Check local speaker
    if (this.localAnalyser && !this.isAudioMuted) {
      const vol = this.calculateRmsVolume(this.localAnalyser)
      if (vol > SPEECH_THRESHOLD && vol > maxVol) {
        maxVol = vol
        loudestSpeaker = 'local'
      }
    }

    // Check remote peers
    for (const [peerId, analyser] of this.peerAnalysers.entries()) {
      const vol = this.calculateRmsVolume(analyser)
      if (vol > SPEECH_THRESHOLD && vol > maxVol) {
        maxVol = vol
        loudestSpeaker = peerId
      }
    }

    if (loudestSpeaker !== this.currentActiveSpeakerId) {
      this.currentActiveSpeakerId = loudestSpeaker
      this.callbacks.onActiveSpeakerChange?.(loudestSpeaker)
    }
  }

  private calculateRmsVolume(analyser: AnalyserNode): number {
    const data = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteTimeDomainData(data)

    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const normalized = (data[i] - 128) / 128
      sum += normalized * normalized
    }
    return Math.sqrt(sum / data.length)
  }

  /**
   * Leave call and clean up all resources.
   */
  public leave(): void {
    console.log('[GroupWebRtc] Leaving call and releasing all media connections...')

    if (this.speakerDetectionTimer) {
      clearInterval(this.speakerDetectionTimer)
      this.speakerDetectionTimer = null
    }

    if (this.audioContext) {
      try {
        this.audioContext.close()
      } catch {}
      this.audioContext = null
    }

    this.localAnalyser = null
    this.peerAnalysers.clear()

    // Stop all local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop())
      this.localStream = null
    }

    // Stop screen stream
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((track) => track.stop())
      this.screenStream = null
    }

    // Close all peer connections
    for (const item of this.peers.values()) {
      try {
        item.pc.close()
      } catch {}
    }
    this.peers.clear()
  }

  /**
   * Fallback stream for environments without a physical camera or microphone.
   */
  private createFallbackStream(type: 'audio' | 'video'): MediaStream {
    const stream = new MediaStream()

    // Simulated silent audio track
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
      if (AudioContextClass) {
        const ctx = new AudioContextClass({ sampleRate: 48000 })
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        gain.gain.value = 0.0
        const dst = ctx.createMediaStreamDestination()
        osc.connect(gain)
        gain.connect(dst)
        osc.start()
        stream.addTrack(dst.stream.getAudioTracks()[0])
      }
    } catch {}

    // Simulated video track with animated gradient
    if (type === 'video') {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 640
        canvas.height = 480
        const ctx = canvas.getContext('2d')
        if (ctx) {
          let angle = 0
          const draw = () => {
            ctx.fillStyle = '#0f172a'
            ctx.fillRect(0, 0, 640, 480)

            ctx.fillStyle = '#6366f1'
            ctx.beginPath()
            ctx.arc(320, 240, 60 + Math.sin(angle) * 8, 0, Math.PI * 2)
            ctx.fill()

            ctx.fillStyle = '#ffffff'
            ctx.font = 'bold 20px sans-serif'
            ctx.textAlign = 'center'
            ctx.fillText('GenChat Group Call', 320, 340)

            angle += 0.05
          }
          const intervalId = setInterval(draw, 100)
          draw()

          const canvasStream = (canvas as any).captureStream(15)
          const track = canvasStream.getVideoTracks()[0]
          if (track) {
            const originalStop = track.stop.bind(track)
            track.stop = () => {
              clearInterval(intervalId)
              originalStop()
            }
            stream.addTrack(track)
          }
        }
      } catch {}
    }

    return stream
  }
}
