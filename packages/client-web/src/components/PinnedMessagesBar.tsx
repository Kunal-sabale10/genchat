import React, { useState } from 'react'
import { Pin, PinOff, ChevronLeft, ChevronRight } from 'lucide-react'

export interface PinnedMessageItem {
  id: string
  clientMsgId?: string
  senderId: string
  text?: string
  attachment?: {
    fileName?: string
    isVoiceNote?: boolean
    mimeType?: string
  }
  isDeleted?: boolean
}

interface PinnedMessagesBarProps {
  pinnedMessages: PinnedMessageItem[]
  onJumpToMessage: (messageId: string) => void
  onUnpinMessage: (message: PinnedMessageItem) => void
}

export function PinnedMessagesBar({
  pinnedMessages,
  onJumpToMessage,
  onUnpinMessage,
}: PinnedMessagesBarProps) {
  const [currentIndex, setCurrentIndex] = useState(0)

  if (!pinnedMessages || pinnedMessages.length === 0) return null

  // Ensure index is within bounds if count changes
  const activeIndex = currentIndex >= pinnedMessages.length ? pinnedMessages.length - 1 : currentIndex
  const current = pinnedMessages[activeIndex]
  if (!current) return null

  const targetMsgId = current.clientMsgId || current.id
  const snippet =
    current.text ||
    (current.attachment?.isVoiceNote
      ? '🎙️ Voice message'
      : current.attachment?.mimeType?.startsWith('image/')
      ? '📷 Photo'
      : current.attachment?.fileName || 'Attachment')

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation()
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : pinnedMessages.length - 1))
  }

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation()
    setCurrentIndex((prev) => (prev < pinnedMessages.length - 1 ? prev + 1 : 0))
  }

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-slate-900/90 border-b border-slate-800/80 backdrop-blur-md text-xs select-none z-10 animate-in slide-in-from-top-1 duration-150 shadow-xs">
      <div
        onClick={() => onJumpToMessage(targetMsgId)}
        className="flex items-center space-x-2.5 min-w-0 flex-1 cursor-pointer group"
        title="Click to jump to pinned message"
      >
        <div className="flex items-center justify-center h-6 w-6 rounded-lg bg-emerald-500/10 text-emerald-400 group-hover:bg-emerald-500/20 transition shrink-0">
          <Pin className="h-3.5 w-3.5 fill-emerald-400/30" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center space-x-1.5 font-semibold text-emerald-400 text-[11px]">
            <span>Pinned Message</span>
            {pinnedMessages.length > 1 && (
              <span className="text-[10px] text-slate-500 font-normal">
                ({activeIndex + 1} of {pinnedMessages.length})
              </span>
            )}
          </div>
          <div className="text-slate-300 truncate mt-0.5 group-hover:text-white transition">
            <span className="text-slate-400 font-medium mr-1">@{current.senderId.slice(0, 10)}:</span>
            <span>{snippet}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center space-x-1 shrink-0 ml-2">
        {pinnedMessages.length > 1 && (
          <div className="flex items-center space-x-0.5 mr-1 bg-slate-800/60 rounded-md p-0.5 border border-slate-700/50">
            <button
              type="button"
              onClick={handlePrev}
              className="p-0.5 text-slate-400 hover:text-white rounded transition"
              title="Previous pinned message"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleNext}
              className="p-0.5 text-slate-400 hover:text-white rounded transition"
              title="Next pinned message"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onUnpinMessage(current)
          }}
          className="flex h-6 w-6 items-center justify-center rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition"
          title="Unpin message"
        >
          <PinOff className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
