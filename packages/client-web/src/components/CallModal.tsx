import React, { useEffect, useRef, useState } from 'react'
import {
  Phone,
  PhoneOff,
  Video,
  VideoOff,
  Mic,
  MicOff,
  Maximize2,
  Minimize2,
  User,
  ShieldCheck,
} from 'lucide-react'

export interface CallModalProps {
  callState: 'incoming' | 'outgoing' | 'connected' | 'ended'
  callType: 'audio' | 'video'
  peerId: string
  localStream: MediaStream | null
  remoteStream: MediaStream | null
  isMuted: boolean
  isVideoDisabled: boolean
  isMinimized: boolean
  onAccept: () => void
  onReject: () => void
  onHangup: () => void
  onToggleMute: () => void
  onToggleVideo: () => void
  onToggleMinimize: () => void
}

export const CallModal: React.FC<CallModalProps> = ({
  callState,
  callType,
  peerId,
  localStream,
  remoteStream,
  isMuted,
  isVideoDisabled,
  isMinimized,
  onAccept,
  onReject,
  onHangup,
  onToggleMute,
  onToggleVideo,
  onToggleMinimize,
}) => {
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const [durationSeconds, setDurationSeconds] = useState(0)

  // Attach local stream to local video element
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream
    }
  }, [localStream])

  // Attach remote stream to remote video element
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream
    }
  }, [remoteStream])

  // In-call duration timer
  useEffect(() => {
    if (callState !== 'connected') {
      setDurationSeconds(0)
      return
    }

    const interval = setInterval(() => {
      setDurationSeconds((s) => s + 1)
    }, 1000)

    return () => clearInterval(interval)
  }, [callState])

  const formatTimer = (secs: number) => {
    const m = Math.floor(secs / 60)
      .toString()
      .padStart(2, '0')
    const s = (secs % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  // --- 1. Minimized Floating Call Pill (Allows navigating app while on call) ---
  if (isMinimized && callState === 'connected') {
    return (
      <div className="fixed bottom-6 right-6 z-50 flex items-center space-x-3 rounded-2xl border border-slate-700/80 bg-slate-900/95 p-3 shadow-2xl backdrop-blur-md transition-all">
        <div className="flex items-center space-x-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600/20 text-indigo-400">
            {callType === 'video' ? <Video className="h-5 w-5" /> : <Phone className="h-5 w-5" />}
          </div>
          <div>
            <p className="max-w-[120px] truncate text-xs font-semibold text-slate-200">@{peerId}</p>
            <p className="text-[11px] font-mono text-emerald-400">{formatTimer(durationSeconds)}</p>
          </div>
        </div>

        <div className="flex items-center space-x-1.5 border-l border-slate-800 pl-2">
          <button
            onClick={onToggleMute}
            className={`rounded-lg p-2 transition ${
              isMuted ? 'bg-rose-500/20 text-rose-400' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
            title={isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
          >
            {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>

          {callType === 'video' && (
            <button
              onClick={onToggleVideo}
              className={`rounded-lg p-2 transition ${
                isVideoDisabled
                  ? 'bg-rose-500/20 text-rose-400'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
              title={isVideoDisabled ? 'Turn Camera On' : 'Turn Camera Off'}
            >
              {isVideoDisabled ? <VideoOff className="h-4 w-4" /> : <Video className="h-4 w-4" />}
            </button>
          )}

          <button
            onClick={onToggleMinimize}
            className="rounded-lg bg-slate-800 p-2 text-slate-300 hover:bg-slate-700 transition"
            title="Maximize View"
          >
            <Maximize2 className="h-4 w-4" />
          </button>

          <button
            onClick={onHangup}
            className="rounded-lg bg-rose-600 p-2 text-white hover:bg-rose-500 transition shadow-md shadow-rose-600/20"
            title="End Call"
          >
            <PhoneOff className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  // --- 2. Incoming Call Prompt ---
  if (callState === 'incoming') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-200">
        <div className="w-full max-w-sm rounded-3xl border border-slate-800 bg-slate-900 p-8 text-center shadow-2xl">
          <div className="relative mx-auto mb-6 flex h-24 w-24 items-center justify-center">
            <div className="absolute inset-0 rounded-full bg-indigo-500/20 animate-ping" />
            <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-tr from-indigo-600 to-violet-500 text-white shadow-lg">
              {callType === 'video' ? <Video className="h-9 w-9" /> : <Phone className="h-9 w-9" />}
            </div>
          </div>

          <h3 className="text-xl font-bold text-slate-100">Incoming {callType === 'video' ? 'Video' : 'Voice'} Call</h3>
          <p className="mt-1 text-sm font-medium text-slate-400 truncate">@{peerId}</p>
          <div className="mt-3 flex items-center justify-center space-x-1.5 text-xs text-emerald-400">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>End-to-End Encrypted WebRTC</span>
          </div>

          <div className="mt-8 flex justify-center space-x-6">
            <button
              onClick={onReject}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-600 text-white shadow-lg shadow-rose-600/30 hover:bg-rose-500 transition hover:scale-105 active:scale-95"
              title="Decline"
            >
              <PhoneOff className="h-6 w-6" />
            </button>

            <button
              onClick={onAccept}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg shadow-emerald-600/30 hover:bg-emerald-500 transition hover:scale-105 active:scale-95 animate-pulse"
              title="Accept Call"
            >
              {callType === 'video' ? <Video className="h-6 w-6" /> : <Phone className="h-6 w-6" />}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // --- 3. Outgoing Call (Ringing) ---
  if (callState === 'outgoing') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-200">
        <div className="w-full max-w-sm rounded-3xl border border-slate-800 bg-slate-900 p-8 text-center shadow-2xl">
          <div className="relative mx-auto mb-6 flex h-24 w-24 items-center justify-center">
            <div className="absolute inset-0 rounded-full bg-indigo-500/20 animate-pulse" />
            <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-slate-800 text-indigo-400 border border-indigo-500/30">
              {callType === 'video' ? <Video className="h-9 w-9" /> : <Phone className="h-9 w-9" />}
            </div>
          </div>

          <h3 className="text-xl font-bold text-slate-100">Calling @{peerId}...</h3>
          <p className="mt-1 text-xs text-slate-500 font-medium">Waiting for peer to connect</p>

          <div className="mt-8 flex justify-center">
            <button
              onClick={onHangup}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-600 text-white shadow-lg shadow-rose-600/30 hover:bg-rose-500 transition hover:scale-105 active:scale-95"
              title="Cancel Call"
            >
              <PhoneOff className="h-6 w-6" />
            </button>
          </div>
        </div>
      </div>
    )
  }

  // --- 4. Active In-Call View (Voice or Video) ---
  if (callState === 'connected') {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-slate-950 text-slate-100 animate-in fade-in duration-200">
        {/* Top bar */}
        <div className="flex h-16 items-center justify-between px-6 border-b border-slate-800 bg-slate-900/60 backdrop-blur-md">
          <div className="flex items-center space-x-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600/20 text-indigo-400">
              <User className="h-5 w-5" />
            </div>
            <div>
              <p className="font-semibold text-sm text-slate-100">@{peerId}</p>
              <p className="text-xs text-emerald-400 font-mono">{formatTimer(durationSeconds)}</p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <div className="flex items-center space-x-1.5 rounded-full bg-slate-800/80 px-3 py-1 text-xs text-slate-300 border border-slate-700/50">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
              <span>WebRTC Encrypted</span>
            </div>

            <button
              onClick={onToggleMinimize}
              className="rounded-xl p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
              title="Minimize to Floating Window"
            >
              <Minimize2 className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Video / Audio viewport */}
        <div className="relative flex flex-1 items-center justify-center p-6 overflow-hidden">
          {callType === 'video' ? (
            <div className="relative h-full w-full max-w-5xl rounded-3xl overflow-hidden bg-slate-900 border border-slate-800 shadow-2xl flex items-center justify-center">
              {/* Remote Video (Main) */}
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="h-full w-full object-contain bg-black"
              />

              {/* Local Video PiP (Picture-in-Picture Floating Preview) */}
              <div className="absolute bottom-6 right-6 h-40 w-56 rounded-2xl overflow-hidden border-2 border-slate-700 bg-slate-900 shadow-2xl z-10 transition-transform hover:scale-105">
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="h-full w-full object-cover scale-x-[-1]"
                />
                {isVideoDisabled && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/90 text-slate-400 text-xs">
                    <VideoOff className="h-6 w-6 mb-1 text-slate-500" />
                    <span>Camera Off</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* Voice Call Graphic */
            <div className="flex flex-col items-center justify-center space-y-6">
              <div className="relative flex h-36 w-36 items-center justify-center">
                <div className="absolute inset-0 rounded-full bg-indigo-500/10 animate-ping" />
                <div className="absolute inset-2 rounded-full bg-indigo-500/20 animate-pulse" />
                <div className="relative flex h-28 w-28 items-center justify-center rounded-full bg-gradient-to-tr from-indigo-600 to-violet-600 text-white shadow-2xl">
                  <User className="h-14 w-14" />
                </div>
              </div>

              <div className="text-center space-y-1">
                <h4 className="text-xl font-bold text-slate-100">Voice Call in Progress</h4>
                <p className="text-sm text-slate-400">Connected with @{peerId}</p>
                <p className="text-base font-mono text-emerald-400 pt-2">{formatTimer(durationSeconds)}</p>
              </div>

              {/* Hidden audio tag to route remote audio tracks */}
              <audio ref={remoteVideoRef} autoPlay playsInline />
            </div>
          )}
        </div>

        {/* Bottom Control Toolbar */}
        <div className="flex h-24 items-center justify-center space-x-6 border-t border-slate-800 bg-slate-900/80 backdrop-blur-md px-6">
          {/* Mute Mic */}
          <button
            onClick={onToggleMute}
            className={`flex h-12 w-12 items-center justify-center rounded-full transition hover:scale-105 active:scale-95 ${
              isMuted
                ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
            }`}
            title={isMuted ? 'Unmute Mic' : 'Mute Mic'}
          >
            {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>

          {/* Toggle Camera (in video mode) */}
          {callType === 'video' && (
            <button
              onClick={onToggleVideo}
              className={`flex h-12 w-12 items-center justify-center rounded-full transition hover:scale-105 active:scale-95 ${
                isVideoDisabled
                  ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                  : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
              }`}
              title={isVideoDisabled ? 'Turn On Camera' : 'Turn Off Camera'}
            >
              {isVideoDisabled ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
            </button>
          )}

          {/* End Call Button */}
          <button
            onClick={onHangup}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-600 text-white shadow-xl shadow-rose-600/30 hover:bg-rose-500 transition hover:scale-105 active:scale-95"
            title="End Call"
          >
            <PhoneOff className="h-6 w-6" />
          </button>
        </div>
      </div>
    )
  }

  return null
}
