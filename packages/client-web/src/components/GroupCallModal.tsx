import React, { useEffect, useRef, useState } from 'react'
import {
  PhoneOff,
  Video,
  VideoOff,
  Mic,
  MicOff,
  Maximize2,
  Minimize2,
  MonitorUp,
  Users,
  ShieldCheck,
  Volume2,
} from 'lucide-react'

export interface GroupCallModalProps {
  isOpen: boolean
  channelName: string
  callType: 'audio' | 'video'
  localStream: MediaStream | null
  remoteStreams: Map<string, MediaStream>
  currentUserId: string
  activeSpeakerId: string | null
  isMuted: boolean
  isVideoDisabled: boolean
  isScreenSharing: boolean
  isMinimized: boolean
  onToggleMute: () => void
  onToggleVideo: () => void
  onToggleScreenShare: () => void
  onToggleMinimize: () => void
  onLeaveCall: () => void
}

const ParticipantTile: React.FC<{
  stream: MediaStream | null
  label: string
  isLocal?: boolean
  isMuted?: boolean
  isVideoOff?: boolean
  isActiveSpeaker?: boolean
}> = ({ stream, label, isLocal = false, isMuted = false, isVideoOff = false, isActiveSpeaker = false }) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    if (videoRef.current && stream) {
      if (videoRef.current.srcObject !== stream) {
        videoRef.current.srcObject = stream
      }
    }
  }, [stream])

  useEffect(() => {
    if (!isLocal && audioRef.current && stream) {
      if (audioRef.current.srcObject !== stream) {
        audioRef.current.srcObject = stream
        audioRef.current.play().catch(() => {})
      }
    }
  }, [stream, isLocal])

  const hasVideoTrack = Boolean(
    stream &&
      stream.getVideoTracks().length > 0 &&
      stream.getVideoTracks()[0].enabled &&
      !isVideoOff
  )

  return (
    <div
      className={`relative flex items-center justify-center rounded-2xl overflow-hidden bg-slate-900/90 border transition-all duration-300 shadow-lg min-h-[160px] aspect-video sm:aspect-auto ${
        isActiveSpeaker
          ? 'border-emerald-400 ring-4 ring-emerald-500/30 shadow-emerald-950/40 shadow-xl'
          : 'border-slate-800/80 hover:border-slate-700'
      }`}
    >
      {/* Background Audio Player for Remote Peers */}
      {!isLocal && (
        <audio
          ref={audioRef}
          autoPlay
          playsInline
        />
      )}

      {/* Video Element */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        className={`h-full w-full object-cover transition-opacity duration-300 ${
          hasVideoTrack ? 'opacity-100' : 'opacity-0 absolute'
        }`}
      />

      {/* Fallback Avatar / Audio-Only Display */}
      {!hasVideoTrack && (
        <div className="flex flex-col items-center justify-center space-y-2 select-none">
          <div
            className={`relative flex h-16 w-16 items-center justify-center rounded-full text-xl font-bold uppercase transition ${
              isActiveSpeaker
                ? 'bg-gradient-to-tr from-emerald-600 to-indigo-600 text-white ring-4 ring-emerald-400/50 animate-pulse'
                : 'bg-slate-800 text-slate-300 border border-slate-700'
            }`}
          >
            {label.slice(0, 2)}
          </div>
          <span className="text-xs text-slate-400 font-medium">Camera Off</span>
        </div>
      )}

      {/* Participant Label & Badges */}
      <div className="absolute bottom-2.5 left-2.5 right-2.5 flex items-center justify-between text-xs backdrop-blur-md bg-black/40 px-2.5 py-1 rounded-xl border border-white/10 pointer-events-none">
        <div className="flex items-center space-x-1.5 truncate">
          <span className="font-semibold text-white truncate">{label}</span>
          {isLocal && (
            <span className="text-[10px] px-1 rounded bg-indigo-600/80 text-white font-medium">
              You
            </span>
          )}
        </div>

        <div className="flex items-center space-x-1">
          {isActiveSpeaker && (
            <span className="flex items-center space-x-1 text-[10px] font-bold text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
              <span>Speaking</span>
            </span>
          )}
          {isMuted && (
            <span className="rounded-full bg-rose-500/30 p-1 text-rose-300">
              <MicOff className="h-3 w-3" />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export const GroupCallModal: React.FC<GroupCallModalProps> = ({
  isOpen,
  channelName,
  callType,
  localStream,
  remoteStreams,
  currentUserId,
  activeSpeakerId,
  isMuted,
  isVideoDisabled,
  isScreenSharing,
  isMinimized,
  onToggleMute,
  onToggleVideo,
  onToggleScreenShare,
  onToggleMinimize,
  onLeaveCall,
}) => {
  const [durationSeconds, setDurationSeconds] = useState(0)

  // In-call duration timer
  useEffect(() => {
    if (!isOpen) {
      setDurationSeconds(0)
      return
    }

    const interval = setInterval(() => {
      setDurationSeconds((s) => s + 1)
    }, 1000)

    return () => clearInterval(interval)
  }, [isOpen])

  if (!isOpen) return null

  const formatTimer = (secs: number) => {
    const m = Math.floor(secs / 60)
      .toString()
      .padStart(2, '0')
    const s = (secs % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  const remotePeerList = Array.from(remoteStreams.entries())
  const totalParticipants = 1 + remotePeerList.length

  // Calculate dynamic grid columns based on participant count
  const getGridColsClass = () => {
    if (totalParticipants <= 1) return 'grid-cols-1 max-w-2xl'
    if (totalParticipants === 2) return 'grid-cols-1 sm:grid-cols-2 max-w-4xl'
    if (totalParticipants <= 4) return 'grid-cols-1 sm:grid-cols-2 max-w-5xl'
    return 'grid-cols-2 sm:grid-cols-3 max-w-6xl'
  }

  // --- 1. Minimized Floating Call Dock ---
  if (isMinimized) {
    return (
      <div className="fixed bottom-6 right-6 z-50 flex items-center space-x-3 rounded-2xl border border-emerald-500/40 bg-slate-950/95 p-3 shadow-2xl backdrop-blur-md transition-all animate-in fade-in slide-in-from-bottom-2">
        <div className="flex items-center space-x-2.5">
          <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600/20 text-emerald-400 border border-emerald-500/30">
            {callType === 'video' ? <Video className="h-5 w-5" /> : <Users className="h-5 w-5" />}
            <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse" />
          </div>
          <div>
            <p className="max-w-[130px] truncate text-xs font-semibold text-slate-200">#{channelName}</p>
            <p className="text-[11px] font-mono text-emerald-400 flex items-center gap-1.5">
              <span>{formatTimer(durationSeconds)}</span>
              <span className="text-slate-500">•</span>
              <span className="text-slate-400">{totalParticipants} online</span>
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-1.5 border-l border-slate-800 pl-2">
          <button
            type="button"
            onClick={onToggleMute}
            className={`rounded-lg p-2 transition ${
              isMuted
                ? 'bg-rose-500/20 text-rose-400 hover:bg-rose-500/30'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>

          <button
            type="button"
            onClick={onToggleMinimize}
            className="rounded-lg bg-slate-800 p-2 text-slate-300 hover:bg-slate-700 transition"
            title="Expand Call Grid"
          >
            <Maximize2 className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={onLeaveCall}
            className="rounded-lg bg-rose-600 p-2 text-white hover:bg-rose-500 transition shadow-xs"
            title="Leave Call"
          >
            <PhoneOff className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  // --- 2. Full-Screen Group Calling Modal Grid ---
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 backdrop-blur-xl animate-in fade-in">
      {/* Header Bar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800/80">
        <div className="flex items-center space-x-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h2 className="text-sm font-bold text-white tracking-wide">#{channelName}</h2>
              <span className="flex items-center space-x-1 text-[10px] text-emerald-400 bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 rounded-full font-medium">
                <ShieldCheck className="h-3 w-3" />
                <span>P2P E2EE Mesh</span>
              </span>
            </div>
            <div className="flex items-center space-x-2 text-xs text-slate-400">
              <span className="font-mono text-emerald-400">{formatTimer(durationSeconds)}</span>
              <span>•</span>
              <span>{totalParticipants} {totalParticipants === 1 ? 'participant' : 'participants'} in call</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onToggleMinimize}
          className="rounded-xl p-2 text-slate-400 hover:bg-slate-900 hover:text-white transition"
          title="Minimize Call (browse chat)"
        >
          <Minimize2 className="h-5 w-5" />
        </button>
      </div>

      {/* Multi-Tile Calling Grid */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 flex items-center justify-center">
        <div className={`grid gap-4 w-full ${getGridColsClass()}`}>
          {/* Local User Tile */}
          <ParticipantTile
            stream={localStream}
            label={currentUserId || 'You'}
            isLocal={true}
            isMuted={isMuted}
            isVideoOff={isVideoDisabled}
            isActiveSpeaker={activeSpeakerId === 'local'}
          />

          {/* Remote Peer Tiles */}
          {remotePeerList.map(([peerId, stream]) => (
            <ParticipantTile
              key={peerId}
              stream={stream}
              label={peerId}
              isLocal={false}
              isActiveSpeaker={activeSpeakerId === peerId}
            />
          ))}
        </div>
      </div>

      {/* Bottom Controls Bar */}
      <div className="flex items-center justify-center space-x-3 sm:space-x-4 py-5 px-6 border-t border-slate-800/80 bg-slate-900/50 backdrop-blur-md">
        {/* Mute Mic Button */}
        <button
          type="button"
          onClick={onToggleMute}
          className={`flex h-12 w-12 items-center justify-center rounded-2xl transition transform active:scale-95 shadow-md ${
            isMuted
              ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40 hover:bg-rose-500/30'
              : 'bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700'
          }`}
          title={isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
        >
          {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>

        {/* Video Toggle Button */}
        <button
          type="button"
          onClick={onToggleVideo}
          className={`flex h-12 w-12 items-center justify-center rounded-2xl transition transform active:scale-95 shadow-md ${
            isVideoDisabled
              ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40 hover:bg-rose-500/30'
              : 'bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700'
          }`}
          title={isVideoDisabled ? 'Turn On Camera' : 'Turn Off Camera'}
        >
          {isVideoDisabled ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
        </button>

        {/* Screen Share Button */}
        <button
          type="button"
          onClick={onToggleScreenShare}
          className={`flex h-12 w-12 items-center justify-center rounded-2xl transition transform active:scale-95 shadow-md ${
            isScreenSharing
              ? 'bg-indigo-600 text-white border border-indigo-400 shadow-indigo-600/40 ring-2 ring-indigo-400'
              : 'bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700'
          }`}
          title={isScreenSharing ? 'Stop Screen Sharing' : 'Share Screen'}
        >
          <MonitorUp className="h-5 w-5" />
        </button>

        {/* End / Leave Call Button */}
        <button
          type="button"
          onClick={onLeaveCall}
          className="flex h-12 items-center space-x-2 rounded-2xl bg-rose-600 px-6 font-semibold text-white shadow-lg shadow-rose-900/40 hover:bg-rose-500 transition transform active:scale-95"
          title="Leave Group Call"
        >
          <PhoneOff className="h-5 w-5" />
          <span className="hidden sm:inline">Leave Call</span>
        </button>
      </div>
    </div>
  )
}
