import React, { useEffect, useState } from 'react'
import { X, Download, ZoomIn, ZoomOut, RotateCcw, Lock, FileImage } from 'lucide-react'

interface ImageViewerModalProps {
  isOpen: boolean
  onClose: () => void
  imageUrl: string
  fileName?: string
  fileSize?: number
}

export function ImageViewerModal({
  isOpen,
  onClose,
  imageUrl,
  fileName = 'decrypted_image.jpg',
  fileSize,
}: ImageViewerModalProps) {
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    if (isOpen) {
      setZoom(1)
    }
  }, [isOpen])

  // Keyboard shortcut: Esc to close, +/- to zoom
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === '+' || e.key === '=') {
        setZoom((z) => Math.min(3, z + 0.25))
      } else if (e.key === '-' || e.key === '_') {
        setZoom((z) => Math.max(0.5, z - 0.25))
      } else if (e.key === '0') {
        setZoom(1)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const handleDownload = () => {
    const a = document.createElement('a')
    a.href = imageUrl
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-black/95 backdrop-blur-md animate-in fade-in duration-200">
      {/* Top Bar */}
      <div className="flex items-center justify-between w-full px-6 py-4 bg-black/50 border-b border-white/10 z-10">
        <div className="flex items-center space-x-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400">
            <FileImage className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-medium text-slate-100 truncate max-w-xs sm:max-w-md">
              {fileName}
            </h3>
            <div className="flex items-center space-x-2 text-[11px] text-slate-400">
              {fileSize && <span>{(fileSize / 1024).toFixed(1)} KB</span>}
              <span className="flex items-center space-x-1 text-emerald-400">
                <Lock className="h-2.5 w-2.5" />
                <span>Zero-Knowledge Decrypted</span>
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          {/* Zoom controls */}
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-xl p-0.5">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
              className="p-1.5 text-slate-400 hover:text-white rounded-lg transition"
              title="Zoom out (-)"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <span className="text-[11px] font-mono text-slate-300 px-2 select-none">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
              className="p-1.5 text-slate-400 hover:text-white rounded-lg transition"
              title="Zoom in (+)"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            {zoom !== 1 && (
              <button
                type="button"
                onClick={() => setZoom(1)}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg transition border-l border-slate-800"
                title="Reset zoom (0)"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={handleDownload}
            className="flex items-center space-x-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-indigo-500 shadow-md shadow-indigo-600/30 transition"
            title="Download image"
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Download</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white transition"
            title="Close (Esc)"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Main Image Stage */}
      <div
        className="relative flex-1 w-full flex items-center justify-center overflow-auto p-4 select-none"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <img
          src={imageUrl}
          alt={fileName}
          style={{ transform: `scale(${zoom})` }}
          className="max-h-[85vh] max-w-[90vw] object-contain rounded-lg shadow-2xl transition-transform duration-150 cursor-zoom-in"
          onClick={() => setZoom((z) => (z === 1 ? 1.75 : 1))}
        />
      </div>

      {/* Bottom Hint */}
      <div className="py-2 text-[11px] text-slate-500 text-center select-none">
        Click image or use controls to zoom • Press Esc to close
      </div>
    </div>
  )
}
