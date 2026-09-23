import React, { useState, useEffect, useMemo } from 'react'

export interface UserAvatarProps {
  name?: string
  avatarUrl?: string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  status?: 'online' | 'offline' | 'away'
  className?: string
  onClick?: () => void
}

const GRADIENT_PALETTES = [
  'from-violet-600 to-indigo-600',
  'from-blue-600 to-cyan-600',
  'from-emerald-600 to-teal-600',
  'from-amber-500 to-orange-600',
  'from-rose-600 to-pink-600',
  'from-fuchsia-600 to-purple-600',
  'from-indigo-600 to-purple-700',
  'from-teal-500 to-emerald-700',
]

const SIZE_CLASSES = {
  xs: 'w-6 h-6 text-[10px]',
  sm: 'w-8 h-8 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-14 h-14 text-lg font-semibold',
  xl: 'w-20 h-20 text-2xl font-bold',
}

const STATUS_SIZES = {
  xs: 'w-1.5 h-1.5 ring-1',
  sm: 'w-2 h-2 ring-1.5',
  md: 'w-2.5 h-2.5 ring-2',
  lg: 'w-3.5 h-3.5 ring-2',
  xl: 'w-4 h-4 ring-2',
}

function getInitials(name?: string): string {
  if (!name || !name.trim()) return 'U'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase()
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

export const UserAvatar: React.FC<UserAvatarProps> = ({
  name = '',
  avatarUrl,
  size = 'md',
  status,
  className = '',
  onClick,
}) => {
  const [imgError, setImgError] = useState(false)
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(undefined)

  // Compute effective URL (handles raw object keys, /media/view wrappers)
  const effectiveUrl = useMemo(() => {
    if (!avatarUrl || !avatarUrl.trim()) return undefined
    const trimmed = avatarUrl.trim()
    if (trimmed.startsWith('attachments/')) {
      return `/media/view?object_key=${encodeURIComponent(trimmed)}`
    }
    return trimmed
  }, [avatarUrl])

  useEffect(() => {
    setImgError(false)
    setResolvedUrl(effectiveUrl)
  }, [effectiveUrl])

  const handleImgError = async () => {
    if (!effectiveUrl) {
      setImgError(true)
      return
    }

    // Try extracting object_key if it was an expired MinIO URL or media URL
    let objectKey: string | null = null
    try {
      if (effectiveUrl.includes('object_key=')) {
        const u = new URL(effectiveUrl, window.location.origin)
        objectKey = u.searchParams.get('object_key')
      } else if (effectiveUrl.includes('/genchat-media/attachments/')) {
        const parts = effectiveUrl.split('/genchat-media/')
        if (parts[1]) {
          objectKey = parts[1].split('?')[0]
        }
      }
    } catch {
      // ignore
    }

    if (objectKey && !resolvedUrl?.includes('/media/view?')) {
      // Switch to permanent redirect endpoint
      setResolvedUrl(`/media/view?object_key=${encodeURIComponent(objectKey)}`)
      setImgError(false)
      return
    }

    setImgError(true)
  }

  const initials = useMemo(() => getInitials(name), [name])
  const gradient = useMemo(() => {
    const idx = hashString(name || 'user') % GRADIENT_PALETTES.length
    return GRADIENT_PALETTES[idx]
  }, [name])

  const sizeClass = SIZE_CLASSES[size] || SIZE_CLASSES.md
  const statusSize = STATUS_SIZES[size] || STATUS_SIZES.md

  const isClickable = Boolean(onClick)

  const currentSrc = resolvedUrl || effectiveUrl

  return (
    <div
      onClick={onClick}
      className={`relative inline-flex flex-shrink-0 items-center justify-center rounded-full select-none ${sizeClass} ${
        isClickable ? 'cursor-pointer hover:opacity-90 transition-opacity' : ''
      } ${className}`}
    >
      {currentSrc && !imgError ? (
        <img
          src={currentSrc}
          alt={name || 'Avatar'}
          onError={handleImgError}
          className="w-full h-full object-cover rounded-full shadow-sm"
        />
      ) : (
        <div
          className={`w-full h-full rounded-full bg-gradient-to-tr ${gradient} flex items-center justify-center text-white font-medium shadow-sm`}
        >
          {initials}
        </div>
      )}

      {status && (
        <span
          className={`absolute bottom-0 right-0 rounded-full ring-zinc-900 ${statusSize} ${
            status === 'online'
              ? 'bg-emerald-500'
              : status === 'away'
              ? 'bg-amber-400'
              : 'bg-zinc-500'
          }`}
        />
      )}
    </div>
  )
}
