import React, { useEffect, useState } from 'react'
import { X, File, Image as ImageIcon, Loader2, Lock } from 'lucide-react'

interface AttachmentStagingProps {
  file: File | null
  isUploading: boolean
  onRemove: () => void
}

export function AttachmentStaging({ file, isUploading, onRemove }: AttachmentStagingProps) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!file) {
      setThumbnailUrl(null)
      return
    }

    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file)
      setThumbnailUrl(url)
      return () => URL.revokeObjectURL(url)
    } else {
      setThumbnailUrl(null)
    }
  }, [file])

  if (!file) return null

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <div className="flex items-center justify-between mx-4 mb-2 p-2.5 rounded-xl border border-indigo-500/30 bg-indigo-950/20 backdrop-blur-xs animate-in slide-in-from-bottom-2 duration-150">
      <div className="flex items-center space-x-3 overflow-hidden">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt="Preview"
            className="h-12 w-12 rounded-lg object-cover border border-white/10 shrink-0"
          />
        ) : (
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400 shrink-0">
            <File className="h-6 w-6" />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center space-x-2">
            <p className="text-xs font-semibold text-slate-100 truncate max-w-[240px] sm:max-w-md">
              {file.name}
            </p>
            <span className="flex items-center space-x-1 text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
              <Lock className="h-2.5 w-2.5" />
              <span>AES-256</span>
            </span>
          </div>

          <div className="flex items-center space-x-2 text-[11px] text-slate-400 mt-0.5">
            <span>{formatSize(file.size)}</span>
            {isUploading ? (
              <span className="flex items-center space-x-1 text-indigo-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>Encrypting & Uploading to MinIO...</span>
              </span>
            ) : (
              <span className="text-slate-500">• Ready to send</span>
            )}
          </div>
        </div>
      </div>

      <button
        type="button"
        disabled={isUploading}
        onClick={onRemove}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-40 transition shrink-0 ml-2"
        title="Remove attachment"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
