import React, { useState, useRef } from 'react'
import { X, Upload, Check, Copy, User, Camera, Sparkles, Loader2, Trash2 } from 'lucide-react'
import { UserAvatar } from './UserAvatar'
import { AuthService } from '@/lib/grpc-client'
import { MediaClient } from '@/lib/media-client'

export interface ProfileModalProps {
  isOpen: boolean
  onClose: () => void
  currentUserId: string
  currentDeviceId?: string
  currentDisplayName?: string
  currentAvatarUrl?: string
  accessToken: string | null
  onProfileUpdated: (updates: { displayName: string; avatarUrl: string }) => void
}

const AVATAR_PRESETS = [
  { id: 'bottts-1', name: 'Bot Blue', url: 'https://api.dicebear.com/7.x/bottts/svg?seed=Cosmo' },
  { id: 'bottts-2', name: 'Bot Neon', url: 'https://api.dicebear.com/7.x/bottts/svg?seed=Cyber' },
  { id: 'adv-1', name: 'Adventurer Alex', url: 'https://api.dicebear.com/7.x/adventurer/svg?seed=Alex' },
  { id: 'adv-2', name: 'Adventurer Sam', url: 'https://api.dicebear.com/7.x/adventurer/svg?seed=Sam' },
  { id: 'lor-1', name: 'Lorelei Maya', url: 'https://api.dicebear.com/7.x/lorelei/svg?seed=Maya' },
  { id: 'lor-2', name: 'Lorelei Leo', url: 'https://api.dicebear.com/7.x/lorelei/svg?seed=Leo' },
  { id: 'mic-1', name: 'Micah Luna', url: 'https://api.dicebear.com/7.x/micah/svg?seed=Luna' },
  { id: 'mic-2', name: 'Micah Kai', url: 'https://api.dicebear.com/7.x/micah/svg?seed=Kai' },
]

export const ProfileModal: React.FC<ProfileModalProps> = ({
  isOpen,
  onClose,
  currentUserId,
  currentDeviceId,
  currentDisplayName = '',
  currentAvatarUrl = '',
  accessToken,
  onProfileUpdated,
}) => {
  const [displayName, setDisplayName] = useState(currentDisplayName)
  const [avatarUrl, setAvatarUrl] = useState(currentAvatarUrl)
  const [isUploading, setIsUploading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const mediaClient = useRef(new MediaClient()).current

  if (!isOpen) return null

  const handleCopyUserId = async () => {
    try {
      await navigator.clipboard.writeText(currentUserId)
      setCopiedId(true)
      setTimeout(() => setCopiedId(false), 2000)
    } catch {
      // ignore
    }
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      setErrorMessage('Please select a valid image file (PNG, JPEG, WebP, etc.).')
      return
    }

    // Limit avatar size to 10MB
    if (file.size > 10 * 1024 * 1024) {
      setErrorMessage('Avatar image size must be under 10MB.')
      return
    }

    try {
      setIsUploading(true)
      setErrorMessage(null)
      const uploadedUrl = await mediaClient.uploadAvatar(file)
      setAvatarUrl(uploadedUrl)
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to upload avatar image.')
    } finally {
      setIsUploading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!accessToken) {
      setErrorMessage('You are not authenticated.')
      return
    }

    try {
      setIsSaving(true)
      setErrorMessage(null)
      const res = await AuthService.updateProfile(
        {
          displayName: displayName.trim(),
          avatarUrl: avatarUrl.trim(),
        },
        accessToken
      )

      onProfileUpdated({
        displayName: res.displayName || displayName.trim(),
        avatarUrl: res.avatarUrl !== undefined ? res.avatarUrl : avatarUrl.trim(),
      })
      onClose()
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to update profile.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/50">
          <div className="flex items-center gap-2">
            <User className="w-5 h-5 text-indigo-400" />
            <h2 className="text-lg font-semibold text-zinc-100">User Profile</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSave} className="p-6 overflow-y-auto space-y-6">
          {errorMessage && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-xs text-rose-400">
              {errorMessage}
            </div>
          )}

          {/* Avatar Preview & Upload */}
          <div className="flex flex-col items-center gap-3">
            <div className="relative group">
              <UserAvatar
                name={displayName || currentUserId}
                avatarUrl={avatarUrl}
                size="xl"
                className="ring-4 ring-zinc-800 shadow-xl"
              />

              {isUploading ? (
                <div className="absolute inset-0 bg-black/60 rounded-full flex items-center justify-center">
                  <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="absolute inset-0 bg-black/40 rounded-full flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer text-white"
                  title="Upload profile photo"
                >
                  <Camera className="w-6 h-6 drop-shadow-md" />
                  <span className="text-[10px] font-medium mt-1">Upload</span>
                </button>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileUpload}
            />

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5 transition-colors"
              >
                <Upload className="w-3.5 h-3.5 text-indigo-400" />
                {isUploading ? 'Uploading...' : 'Upload Photo'}
              </button>

              {avatarUrl && (
                <button
                  type="button"
                  onClick={() => setAvatarUrl('')}
                  className="px-3 py-1.5 rounded-lg bg-zinc-800/60 hover:bg-rose-950/40 hover:text-rose-300 text-xs font-medium text-zinc-400 flex items-center gap-1.5 transition-colors border border-transparent hover:border-rose-800/40"
                  title="Remove custom photo and use colorful initials"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Reset
                </button>
              )}
            </div>
          </div>

          {/* Preset Avatars */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              Or Pick an Avatar Preset
            </label>
            <div className="grid grid-cols-4 gap-2.5 p-3 bg-zinc-950/40 rounded-xl border border-zinc-800/60">
              {AVATAR_PRESETS.map((preset) => {
                const isSelected = avatarUrl === preset.url
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setAvatarUrl(preset.url)}
                    className={`relative p-1.5 rounded-xl flex flex-col items-center gap-1 transition-all ${
                      isSelected
                        ? 'bg-indigo-600/20 ring-2 ring-indigo-500 scale-105'
                        : 'bg-zinc-800/40 hover:bg-zinc-800 hover:scale-105'
                    }`}
                  >
                    <img
                      src={preset.url}
                      alt={preset.name}
                      className="w-10 h-10 rounded-full bg-zinc-900 object-cover"
                    />
                    <span className="text-[10px] text-zinc-400 truncate max-w-full font-medium">
                      {preset.name.split(' ')[0]}
                    </span>
                    {isSelected && (
                      <span className="absolute -top-1 -right-1 bg-indigo-500 rounded-full p-0.5 text-white shadow">
                        <Check className="w-2.5 h-2.5" />
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Display Name Field */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-300">Display Name</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Alice Cooper"
              maxLength={64}
              className="w-full px-3.5 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
            />
          </div>

          {/* Account Identifiers */}
          <div className="p-3 bg-zinc-950/60 border border-zinc-800/80 rounded-xl space-y-2 text-xs">
            <div className="flex items-center justify-between text-zinc-400">
              <span className="font-medium">User ID:</span>
              <div className="flex items-center gap-1.5">
                <code className="text-[11px] font-mono text-zinc-300 truncate max-w-[190px]">
                  {currentUserId}
                </code>
                <button
                  type="button"
                  onClick={handleCopyUserId}
                  className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200 transition-colors"
                  title="Copy User ID"
                >
                  {copiedId ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>

            {currentDeviceId && (
              <div className="flex items-center justify-between text-zinc-400">
                <span className="font-medium">Device ID:</span>
                <code className="text-[11px] font-mono text-zinc-500 truncate max-w-[190px]">
                  {currentDeviceId}
                </code>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving || isUploading}
              className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-sm font-medium shadow-lg shadow-indigo-600/25 flex items-center gap-2 transition-all"
            >
              {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
