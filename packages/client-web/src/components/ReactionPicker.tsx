import React, { useEffect, useRef } from 'react'

interface ReactionPickerProps {
  onSelectEmoji: (emoji: string) => void
  onClose: () => void
  userReactions?: string[]
}

const COMMON_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👏']

export function ReactionPicker({
  onSelectEmoji,
  onClose,
  userReactions = [],
}: ReactionPickerProps) {
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('mousedown', handleClickOutside)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('mousedown', handleClickOutside)
    }
  }, [onClose])

  return (
    <div
      ref={pickerRef}
      className="flex items-center space-x-1 bg-slate-900/95 border border-slate-700/80 shadow-2xl rounded-full px-2 py-1.5 backdrop-blur-md animate-in fade-in zoom-in-95 duration-150 z-30 select-none"
    >
      {COMMON_EMOJIS.map((emoji) => {
        const isSelected = userReactions.includes(emoji)
        return (
          <button
            key={emoji}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onSelectEmoji(emoji)
              onClose()
            }}
            className={`flex h-8 w-8 items-center justify-center rounded-full text-lg transition-transform hover:scale-130 active:scale-95 ${
              isSelected ? 'bg-indigo-600/40 ring-1 ring-indigo-400' : 'hover:bg-slate-800/80'
            }`}
            title={isSelected ? `Remove ${emoji}` : `React with ${emoji}`}
          >
            {emoji}
          </button>
        )
      })}
    </div>
  )
}
