import React from 'react'
import { Pencil, X } from 'lucide-react'

interface EditingBannerProps {
  originalText: string
  onCancel: () => void
}

export function EditingBanner({
  originalText,
  onCancel,
}: EditingBannerProps) {
  return (
    <div className="flex items-center justify-between px-3.5 py-2 mb-2 bg-slate-900/90 border border-amber-500/30 rounded-xl backdrop-blur-md animate-in slide-in-from-bottom-1 duration-150">
      <div className="flex items-center space-x-2.5 min-w-0 flex-1 mr-2">
        {/* Accent Bar */}
        <div className="h-7 w-1 rounded-full bg-amber-500 shrink-0" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center space-x-1.5 text-[11px] font-semibold text-amber-400">
            <Pencil className="h-3 w-3" />
            <span>Editing message</span>
          </div>
          <div className="text-xs text-slate-300 truncate mt-0.5">
            {originalText || 'Message content'}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onCancel}
        className="flex h-6 w-6 items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/80 transition shrink-0"
        title="Cancel editing"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
