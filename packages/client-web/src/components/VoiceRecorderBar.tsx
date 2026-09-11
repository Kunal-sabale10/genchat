import React, { useState, useEffect, useRef } from 'react'
import { Trash2, Send, Loader2, AlertCircle } from 'lucide-react'
import { VoiceRecorder, VoiceRecordingResult } from '@/lib/voice-recorder'

interface VoiceRecorderBarProps {
  onSend: (result: VoiceRecordingResult) => Promise<void> | void
  onCancel: () => void
  isUploading?: boolean
}

export function VoiceRecorderBar({
  onSend,
  onCancel,
  isUploading = false,
}: VoiceRecorderBarProps) {
  const [elapsedSec, setElapsedSec] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isFinishing, setIsFinishing] = useState(false)
  const [liveBars, setLiveBars] = useState<number[]>(Array(24).fill(0.1))

  const recorderRef = useRef<VoiceRecorder | null>(null)
  const timerRef = useRef<any>(null)

  useEffect(() => {
    let isMounted = true
    const recorder = new VoiceRecorder()
    recorderRef.current = recorder

    recorder.onVolume((vol) => {
      if (!isMounted) return
      setLiveBars((prev) => {
        const next = [...prev.slice(1), vol]
        return next
      })
    })

    recorder
      .start()
      .then(() => {
        if (!isMounted) return
        timerRef.current = setInterval(() => {
          setElapsedSec((s) => s + 1)
        }, 1000)
      })
      .catch((err) => {
        console.error('[VoiceRecorderBar] Failed to start recorder:', err)
        if (!isMounted) return
        setError(
          err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError'
            ? 'Microphone access was denied. Please allow microphone permissions.'
            : 'Could not access microphone.'
        )
      })

    return () => {
      isMounted = false
      if (timerRef.current) clearInterval(timerRef.current)
      recorder.cancel()
    }
  }, [])

  const handleCancel = () => {
    if (timerRef.current) clearInterval(timerRef.current)
    recorderRef.current?.cancel()
    onCancel()
  }

  const handleSend = async () => {
    if (isFinishing || !recorderRef.current) return
    setIsFinishing(true)
    if (timerRef.current) clearInterval(timerRef.current)

    try {
      const result = await recorderRef.current.stop()
      await onSend(result)
    } catch (err: any) {
      console.error('[VoiceRecorderBar] Error stopping recorder:', err)
      setError(err.message || 'Failed to finish voice recording.')
      setIsFinishing(false)
    }
  }

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  if (error) {
    return (
      <div className="flex items-center justify-between px-4 py-3 bg-rose-950/60 border border-rose-800/80 rounded-2xl text-rose-200 text-xs w-full animate-in fade-in duration-200">
        <div className="flex items-center space-x-2">
          <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />
          <span>{error}</span>
        </div>
        <button
          type="button"
          onClick={handleCancel}
          className="ml-3 px-3 py-1 bg-rose-800/60 hover:bg-rose-700/60 rounded-lg text-white font-medium transition"
        >
          Dismiss
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between w-full space-x-3 bg-slate-900/90 border border-indigo-500/40 px-4 py-2.5 rounded-2xl shadow-xl backdrop-blur-md animate-in slide-in-from-bottom-2 duration-200">
      {/* Recording Indicator & Timer */}
      <div className="flex items-center space-x-2.5 shrink-0">
        <div className="relative flex h-3 w-3 items-center justify-center">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
        </div>
        <span className="font-mono text-sm font-semibold text-rose-400 tracking-wider">
          {formatTimer(elapsedSec)}
        </span>
      </div>

      {/* Live Animated Oscilloscope Bars */}
      <div className="flex-1 flex items-center justify-center h-8 space-x-1 px-2 overflow-hidden">
        {liveBars.map((vol, idx) => {
          const heightPx = Math.max(4, Math.round(vol * 28))
          return (
            <div
              key={idx}
              style={{ height: `${heightPx}px` }}
              className="w-1 rounded-full bg-gradient-to-t from-indigo-500 to-cyan-400 transition-all duration-75"
            />
          )
        })}
      </div>

      {/* Action Controls: Discard & Send */}
      <div className="flex items-center space-x-2 shrink-0">
        {/* Cancel / Trash Button */}
        <button
          type="button"
          disabled={isFinishing || isUploading}
          onClick={handleCancel}
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800 text-slate-400 hover:text-rose-400 hover:bg-rose-950/40 border border-slate-700/60 hover:border-rose-800/60 transition disabled:opacity-40"
          title="Cancel and discard voice recording"
        >
          <Trash2 className="h-4 w-4" />
        </button>

        {/* Send Button */}
        <button
          type="button"
          disabled={isFinishing || isUploading}
          onClick={handleSend}
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 transition shadow-lg shadow-indigo-600/30 disabled:opacity-40"
          title="Finish and send encrypted voice note"
        >
          {isFinishing || isUploading ? (
            <Loader2 className="h-4 w-4 animate-spin text-white" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  )
}
