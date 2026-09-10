import React, { useEffect, useState } from 'react'
import { Timer } from 'lucide-react'

interface DisappearingTimerBadgeProps {
  expiresAt: number
  onExpire?: () => void
  className?: string
}

export const DisappearingTimerBadge: React.FC<DisappearingTimerBadgeProps> = ({
  expiresAt,
  onExpire,
  className = '',
}) => {
  const [secondsRemaining, setSecondsRemaining] = useState<number>(() =>
    Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  )

  useEffect(() => {
    const updateRemaining = () => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      setSecondsRemaining(remaining)
      if (remaining <= 0 && onExpire) {
        onExpire()
      }
    }

    updateRemaining()
    if (expiresAt <= Date.now()) return

    const timer = setInterval(updateRemaining, 1000)
    return () => clearInterval(timer)
  }, [expiresAt, onExpire])

  if (secondsRemaining <= 0) {
    return null
  }

  const formatRemaining = (sec: number): string => {
    if (sec < 60) return `${sec}s`
    if (sec < 3600) return `${Math.floor(sec / 60)}m`
    if (sec < 86400) return `${Math.floor(sec / 3600)}h`
    return `${Math.floor(sec / 86400)}d`
  }

  const isCritical = secondsRemaining <= 10

  return (
    <span
      title={`Self-destructs in ${secondsRemaining}s`}
      className={`inline-flex items-center gap-1 text-[10px] font-mono font-medium px-1.5 py-0.5 rounded-full border transition-all select-none ${
        isCritical
          ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 animate-pulse'
          : 'bg-amber-500/15 text-amber-300/90 border-amber-500/30'
      } ${className}`}
    >
      <Timer className={`w-3 h-3 ${isCritical ? 'text-rose-400 animate-spin' : 'text-amber-400'}`} />
      <span>{formatRemaining(secondsRemaining)}</span>
    </span>
  )
}
