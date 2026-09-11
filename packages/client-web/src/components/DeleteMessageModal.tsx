import React, { useEffect } from 'react'
import { Trash2, Users, User, X } from 'lucide-react'

interface DeleteMessageModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (scope: 'everyone' | 'me') => void
  isSender: boolean
  messageSnippet?: string
}

export const DeleteMessageModal: React.FC<DeleteMessageModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  isSender,
  messageSnippet,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 relative overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800/80">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-rose-500/10 text-rose-400 border border-rose-500/20">
              <Trash2 className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Delete Message</h3>
              <p className="text-xs text-slate-400">Choose how you want to delete this message</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Message Snippet Preview */}
        {messageSnippet && (
          <div className="my-4 p-3 rounded-xl bg-slate-950/60 border border-slate-800 text-xs text-slate-300 italic truncate">
            &ldquo;{messageSnippet}&rdquo;
          </div>
        )}

        {/* Action Options */}
        <div className="space-y-3 mt-4">
          {isSender && (
            <button
              type="button"
              onClick={() => onConfirm('everyone')}
              className="w-full group text-left p-3.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 hover:border-rose-500/40 transition flex items-start space-x-3 cursor-pointer"
            >
              <div className="p-2 rounded-lg bg-rose-500/20 text-rose-400 group-hover:scale-105 transition-transform mt-0.5">
                <Users className="h-4 w-4" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-rose-300 group-hover:text-rose-200">
                  Delete for Everyone
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  Permanently wipes the content for all participants and leaves a tombstone.
                </div>
              </div>
            </button>
          )}

          <button
            type="button"
            onClick={() => onConfirm('me')}
            className="w-full group text-left p-3.5 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-slate-700/60 hover:border-slate-600 transition flex items-start space-x-3 cursor-pointer"
          >
            <div className="p-2 rounded-lg bg-slate-700 text-slate-300 group-hover:scale-105 transition-transform mt-0.5">
              <User className="h-4 w-4" />
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium text-slate-200 group-hover:text-white">
                Delete for Me
              </div>
              <div className="text-xs text-slate-400 mt-0.5">
                Removes this message only from your device. Other participants will still see it.
              </div>
            </div>
          </button>
        </div>

        {/* Cancel Button */}
        <div className="mt-5 pt-3 border-t border-slate-800/80 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
