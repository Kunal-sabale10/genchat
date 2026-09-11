import React, { useState, useRef, useEffect, useMemo } from 'react'
import { Play, Pause, Loader2, Lock, Download } from 'lucide-react'
import { AttachmentMetadata } from '@/lib/media-client'
import { MediaCryptoService } from '@/lib/media-crypto'

interface VoiceNotePlayerProps {
  attachment: AttachmentMetadata & { decryptedUrl?: string }
  isMe: boolean
  onRenewDownloadUrl?: (blobId: string) => Promise<string>
}

export function VoiceNotePlayer({
  attachment,
  isMe,
  onRenewDownloadUrl,
}: VoiceNotePlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [isDecrypting, setIsDecrypting] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState<number>(attachment.durationSec || 0)
  const [playbackRate, setPlaybackRate] = useState<number>(1)
  const [localUrl, setLocalUrl] = useState<string | null>(attachment.decryptedUrl || null)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const waveformRef = useRef<HTMLDivElement | null>(null)

  // Update local URL if parent updates decryptedUrl
  useEffect(() => {
    if (attachment.decryptedUrl && !localUrl) {
      setLocalUrl(attachment.decryptedUrl)
    }
  }, [attachment.decryptedUrl, localUrl])

  // Normalize or generate 32 waveform bars
  const waveformBars = useMemo(() => {
    if (attachment.waveform && attachment.waveform.length > 0) {
      return attachment.waveform
    }
    // Deterministic fallback waveform if none was transmitted
    const seed = (attachment.blobId || 'seed')
      .split('')
      .reduce((acc, c) => acc + c.charCodeAt(0), 0)
    return Array.from({ length: 32 }, (_, i) => {
      const angle = (i / 31) * Math.PI
      const jitter = ((seed * (i + 1)) % 10) / 30
      return Math.min(1.0, Math.max(0.15, Math.sin(angle) * 0.7 + jitter))
    })
  }, [attachment.waveform, attachment.blobId])

  const formatTime = (secs: number) => {
    if (!secs || isNaN(secs)) return '0:00'
    const m = Math.floor(secs / 60)
    const s = Math.floor(secs % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  // Decrypt audio on-demand if not already decrypted
  const ensureDecrypted = async (): Promise<string> => {
    if (localUrl) return localUrl

    setIsDecrypting(true)
    try {
      let downloadUrl = attachment.downloadUrl
      let res = await fetch(downloadUrl)

      if (!res.ok && onRenewDownloadUrl) {
        downloadUrl = await onRenewDownloadUrl(attachment.blobId)
        res = await fetch(downloadUrl)
      }

      if (!res.ok) {
        throw new Error(`Failed to download encrypted audio (${res.status})`)
      }

      const cipherBuffer = await res.arrayBuffer()
      const decryptedUrl = await MediaCryptoService.decryptFile(
        cipherBuffer,
        attachment.encryptionKeyHex,
        attachment.ivHex,
        attachment.mimeType || 'audio/webm'
      )

      setLocalUrl(decryptedUrl)
      return decryptedUrl
    } finally {
      setIsDecrypting(false)
    }
  }

  const togglePlayPause = async (e: React.MouseEvent) => {
    e.stopPropagation()

    try {
      if (isPlaying) {
        audioRef.current?.pause()
        setIsPlaying(false)
        return
      }

      let src = localUrl
      if (!src) {
        src = await ensureDecrypted()
      }

      if (audioRef.current) {
        if (audioRef.current.src !== src) {
          audioRef.current.src = src
        }
        audioRef.current.playbackRate = playbackRate
        await audioRef.current.play()
        setIsPlaying(true)
      }
    } catch (err) {
      console.error('[VoiceNotePlayer] Playback error:', err)
      setIsPlaying(false)
    }
  }

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime)
    }
  }

  const handleLoadedMetadata = () => {
    if (audioRef.current && audioRef.current.duration && !isNaN(audioRef.current.duration)) {
      setDuration(Math.round(audioRef.current.duration))
    }
  }

  const handleEnded = () => {
    setIsPlaying(false)
    setCurrentTime(0)
    if (audioRef.current) {
      audioRef.current.currentTime = 0
    }
  }

  const handleWaveformClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (!waveformRef.current) return

    const rect = waveformRef.current.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const fraction = Math.max(0, Math.min(1, clickX / rect.width))
    const targetTime = fraction * (duration || 1)

    setCurrentTime(targetTime)
    if (audioRef.current) {
      audioRef.current.currentTime = targetTime
      if (!isPlaying && localUrl) {
        audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {})
      }
    }
  }

  const togglePlaybackRate = (e: React.MouseEvent) => {
    e.stopPropagation()
    const rates = [1, 1.5, 2]
    const nextIdx = (rates.indexOf(playbackRate) + 1) % rates.length
    const nextRate = rates[nextIdx]
    setPlaybackRate(nextRate)
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate
    }
  }

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const url = await ensureDecrypted()
      const a = document.createElement('a')
      a.href = url
      a.download = attachment.fileName || 'voice-note.webm'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (err) {
      console.error('[VoiceNotePlayer] Download failed:', err)
    }
  }

  const currentProgressFraction = duration > 0 ? Math.min(1, currentTime / duration) : 0

  return (
    <div
      className={`relative flex flex-col space-y-2 rounded-2xl p-3.5 transition-all max-w-[320px] sm:max-w-[360px] ${
        isMe
          ? 'bg-indigo-600/90 text-white shadow-md shadow-indigo-600/20'
          : 'bg-slate-800/95 border border-slate-700/60 text-slate-100 shadow-md shadow-black/20'
      }`}
    >
      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        onPause={() => setIsPlaying(false)}
        className="hidden"
      />

      <div className="flex items-center space-x-3">
        {/* Play/Pause Button */}
        <button
          type="button"
          disabled={isDecrypting}
          onClick={togglePlayPause}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition transform active:scale-95 shadow-sm ${
            isMe
              ? 'bg-white text-indigo-700 hover:bg-slate-100'
              : 'bg-indigo-600 text-white hover:bg-indigo-500'
          }`}
          title={isPlaying ? 'Pause voice message' : 'Play encrypted voice message'}
        >
          {isDecrypting ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : isPlaying ? (
            <Pause className="h-5 w-5 fill-current" />
          ) : (
            <Play className="h-5 w-5 fill-current translate-x-0.5" />
          )}
        </button>

        {/* Interactive Waveform Bar Visualizer */}
        <div
          ref={waveformRef}
          onClick={handleWaveformClick}
          className="flex-1 flex items-center h-10 space-x-[2px] sm:space-x-1 cursor-pointer select-none group py-1"
          title="Click to seek"
        >
          {waveformBars.map((vol, idx) => {
            const barFraction = idx / (waveformBars.length - 1)
            const isBarPlayed = barFraction <= currentProgressFraction
            const barHeightPx = Math.max(4, Math.round(vol * 28))

            return (
              <div
                key={idx}
                className="flex-1 flex items-center justify-center h-full"
              >
                <div
                  style={{ height: `${barHeightPx}px` }}
                  className={`w-full rounded-full transition-all duration-100 ${
                    isBarPlayed
                      ? isMe
                        ? 'bg-white shadow-[0_0_6px_rgba(255,255,255,0.7)]'
                        : 'bg-indigo-400 shadow-[0_0_6px_rgba(129,140,248,0.5)]'
                      : isMe
                      ? 'bg-indigo-300/40 group-hover:bg-indigo-200/60'
                      : 'bg-slate-600/70 group-hover:bg-slate-500/80'
                  }`}
                />
              </div>
            )
          })}
        </div>

        {/* Playback Speed Multiplier */}
        <button
          type="button"
          onClick={togglePlaybackRate}
          className={`px-2 py-0.5 rounded-full text-[11px] font-bold tracking-tight transition shrink-0 ${
            isMe
              ? 'bg-indigo-700/80 text-indigo-100 hover:bg-indigo-800'
              : 'bg-slate-700/80 text-slate-300 hover:bg-slate-600 hover:text-white'
          }`}
          title="Change playback speed (1x, 1.5x, 2x)"
        >
          {playbackRate}x
        </button>
      </div>

      {/* Footer Info Row */}
      <div className="flex items-center justify-between text-[11px] px-1 opacity-85">
        <div className="flex items-center space-x-1.5 font-mono">
          <span>{formatTime(currentTime)}</span>
          <span>/</span>
          <span>{formatTime(duration)}</span>
        </div>

        <div className="flex items-center space-x-2">
          <span
            className="flex items-center space-x-1 text-[10px]"
            title="End-to-End Encrypted via WebCrypto AES-256-GCM"
          >
            <Lock className="h-3 w-3" />
            <span>AES-256-GCM</span>
          </span>

          <button
            type="button"
            onClick={handleDownload}
            className={`p-1 rounded-md transition ${
              isMe
                ? 'hover:bg-indigo-700 text-indigo-100'
                : 'hover:bg-slate-700 text-slate-400 hover:text-slate-200'
            }`}
            title="Download voice note"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
