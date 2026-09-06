import React, { useState } from 'react'
import {
  FileText,
  FileArchive,
  Film,
  Music,
  Code,
  File,
  Download,
  Loader2,
  Lock,
  Play,
  Pause,
} from 'lucide-react'
import { AttachmentMetadata } from '@/lib/media-client'
import { MediaCryptoService } from '@/lib/media-crypto'

interface FileAttachmentCardProps {
  attachment: AttachmentMetadata & { decryptedUrl?: string }
  isMe: boolean
  onRenewDownloadUrl?: (blobId: string) => Promise<string>
}

export function FileAttachmentCard({
  attachment,
  isMe,
  onRenewDownloadUrl,
}: FileAttachmentCardProps) {
  const [isDecrypting, setIsDecrypting] = useState(false)
  const [localDecryptedUrl, setLocalDecryptedUrl] = useState<string | null>(
    attachment.decryptedUrl || null
  )
  const [isPlayingAudio, setIsPlayingAudio] = useState(false)
  const audioRef = React.useRef<HTMLAudioElement>(null)

  const mimeType = attachment.mimeType || 'application/octet-stream'
  const fileName = attachment.fileName || attachment.blobId || 'attachment'
  const fileSize = attachment.originalSize || 0

  const isVideo = mimeType.startsWith('video/')
  const isAudio = mimeType.startsWith('audio/')
  const isPdf = mimeType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')
  const isArchive =
    mimeType.includes('zip') ||
    mimeType.includes('tar') ||
    mimeType.includes('rar') ||
    mimeType.includes('compressed') ||
    /\.(zip|tar|gz|rar|7z)$/i.test(fileName)
  const isCode =
    mimeType.includes('javascript') ||
    mimeType.includes('typescript') ||
    mimeType.includes('json') ||
    mimeType.includes('html') ||
    /\.(ts|tsx|js|jsx|json|go|rs|py|c|cpp|h|css|html|md|sql)$/i.test(fileName)

  const formatSize = (bytes: number) => {
    if (!bytes) return '0 B'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const getDecryptedUrl = async (): Promise<string> => {
    if (localDecryptedUrl) return localDecryptedUrl

    setIsDecrypting(true)
    try {
      let downloadUrl = attachment.downloadUrl

      // Fetch ciphertext from MinIO
      let res = await fetch(downloadUrl)
      if (!res.ok && onRenewDownloadUrl) {
        // If expired, refresh presigned URL
        downloadUrl = await onRenewDownloadUrl(attachment.blobId)
        res = await fetch(downloadUrl)
      }

      if (!res.ok) {
        throw new Error(`Failed to download encrypted file (${res.status})`)
      }

      const cipherBuffer = await res.arrayBuffer()
      const decryptedUrl = await MediaCryptoService.decryptFile(
        cipherBuffer,
        attachment.encryptionKeyHex,
        attachment.ivHex,
        mimeType
      )

      setLocalDecryptedUrl(decryptedUrl)
      return decryptedUrl
    } finally {
      setIsDecrypting(false)
    }
  }

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const url = await getDecryptedUrl()
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (err) {
      console.error('[FileCard] Download/decrypt failed:', err)
    }
  }

  const toggleAudioPlay = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const url = await getDecryptedUrl()
      if (audioRef.current) {
        if (isPlayingAudio) {
          audioRef.current.pause()
          setIsPlayingAudio(false)
        } else {
          audioRef.current.src = url
          await audioRef.current.play()
          setIsPlayingAudio(true)
        }
      }
    } catch (err) {
      console.error('[FileCard] Audio play failed:', err)
    }
  }

  // Render Video Preview if video
  if (isVideo && localDecryptedUrl) {
    return (
      <div className="space-y-2 max-w-sm rounded-xl overflow-hidden bg-black/40 border border-white/10 p-1">
        <video
          src={localDecryptedUrl}
          controls
          className="w-full max-h-64 rounded-lg bg-black object-contain"
        />
        <div className="flex items-center justify-between px-2 py-1 text-[11px] text-slate-400">
          <span className="truncate max-w-[200px]">{fileName}</span>
          <span>{formatSize(fileSize)}</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`group flex items-center justify-between space-x-3 rounded-xl p-3 border transition ${
        isMe
          ? 'bg-indigo-700/50 border-indigo-400/20 hover:border-indigo-400/40'
          : 'bg-slate-900/60 border-slate-700/50 hover:border-slate-600'
      }`}
    >
      {/* Type Icon */}
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
          isPdf
            ? 'bg-rose-500/20 text-rose-400'
            : isArchive
            ? 'bg-amber-500/20 text-amber-400'
            : isCode
            ? 'bg-cyan-500/20 text-cyan-400'
            : isAudio
            ? 'bg-emerald-500/20 text-emerald-400'
            : isVideo
            ? 'bg-purple-500/20 text-purple-400'
            : 'bg-indigo-500/20 text-indigo-400'
        }`}
      >
        {isPdf ? (
          <FileText className="h-5 w-5" />
        ) : isArchive ? (
          <FileArchive className="h-5 w-5" />
        ) : isCode ? (
          <Code className="h-5 w-5" />
        ) : isAudio ? (
          <Music className="h-5 w-5" />
        ) : isVideo ? (
          <Film className="h-5 w-5" />
        ) : (
          <File className="h-5 w-5" />
        )}
      </div>

      {/* File Info */}
      <div className="flex-1 min-w-0 pr-2">
        <div className="text-xs font-medium text-slate-100 truncate" title={fileName}>
          {fileName}
        </div>
        <div className="flex items-center space-x-2 text-[10px] text-slate-400 mt-0.5">
          <span>{formatSize(fileSize)}</span>
          <span>•</span>
          <span className="flex items-center space-x-1 text-emerald-400">
            <Lock className="h-2.5 w-2.5" />
            <span>AES-256-GCM</span>
          </span>
        </div>
      </div>

      {/* Audio Play or Download button */}
      <div className="flex items-center space-x-1 shrink-0">
        {isAudio && (
          <>
            <audio
              ref={audioRef}
              onEnded={() => setIsPlayingAudio(false)}
              onPause={() => setIsPlayingAudio(false)}
              className="hidden"
            />
            <button
              type="button"
              disabled={isDecrypting}
              onClick={toggleAudioPlay}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-slate-200 hover:bg-white/20 transition"
              title={isPlayingAudio ? 'Pause' : 'Play voice message/audio'}
            >
              {isDecrypting ? (
                <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
              ) : isPlayingAudio ? (
                <Pause className="h-4 w-4 text-emerald-400" />
              ) : (
                <Play className="h-4 w-4 fill-current" />
              )}
            </button>
          </>
        )}

        <button
          type="button"
          disabled={isDecrypting}
          onClick={handleDownload}
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-slate-200 hover:bg-indigo-600 hover:text-white transition"
          title="Download decrypted file"
        >
          {isDecrypting ? (
            <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  )
}
