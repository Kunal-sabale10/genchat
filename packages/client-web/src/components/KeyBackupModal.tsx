import React, { useState, useEffect } from 'react'
import {
  ShieldCheck,
  Shield,
  X,
  Lock,
  Download,
  Upload,
  AlertCircle,
  CheckCircle2,
  Trash2,
  KeyRound,
} from 'lucide-react'
import {
  createEncryptedBackup,
  restoreEncryptedBackup,
  uploadKeyBackup,
  fetchKeyBackup,
  deleteKeyBackup,
  BackupPayload,
} from '../lib/key-backup'

interface KeyBackupModalProps {
  isOpen: boolean
  onClose: () => void
  authToken: string
  onBackupRestored?: (recoveredData: Record<string, unknown>) => void
}

export const KeyBackupModal: React.FC<KeyBackupModalProps> = ({
  isOpen,
  onClose,
  authToken,
  onBackupRestored,
}) => {
  const [activeTab, setActiveTab] = useState<'backup' | 'restore'>('backup')
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [existingBackup, setExistingBackup] = useState<BackupPayload | null>(null)

  useEffect(() => {
    if (isOpen && authToken) {
      loadExistingBackup()
    }
  }, [isOpen, authToken])

  const loadExistingBackup = async () => {
    try {
      const b = await fetchKeyBackup(authToken)
      setExistingBackup(b)
    } catch {
      // Ignored
    }
  }

  if (!isOpen) return null

  const handleCreateBackup = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (passphrase.length < 6) {
      setError('Passphrase must be at least 6 characters long.')
      return
    }
    if (passphrase !== confirmPassphrase) {
      setError('Passphrases do not match.')
      return
    }

    setLoading(true)
    try {
      // Collect local identity keys from localStorage / indexedDB
      const rawIdentity = localStorage.getItem('genchat_identity_bundle')
      const identityBundle = rawIdentity
        ? JSON.parse(rawIdentity)
        : {
            identity_key_ed25519_pub_hex: localStorage.getItem('genchat_identity_pub') || 'dev_identity',
            identity_key_ed25519_priv_hex: 'dev_priv',
          }

      const backupPayload = await createEncryptedBackup(identityBundle, passphrase)
      await uploadKeyBackup(authToken, backupPayload)

      setSuccess('Zero-knowledge backup encrypted and uploaded successfully!')
      setExistingBackup(backupPayload)
      setPassphrase('')
      setConfirmPassphrase('')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create encrypted backup')
    } finally {
      setLoading(false)
    }
  }

  const handleRestoreBackup = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (!passphrase) {
      setError('Please enter your backup passphrase.')
      return
    }

    setLoading(true)
    try {
      const backup = existingBackup || (await fetchKeyBackup(authToken))
      if (!backup) {
        throw new Error('No encrypted backup found on server.')
      }

      const restored = await restoreEncryptedBackup(backup, passphrase)
      setSuccess('Backup successfully decrypted and verified!')
      if (onBackupRestored) {
        onBackupRestored(restored as unknown as Record<string, unknown>)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to restore backup')
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteBackup = async () => {
    if (!confirm('Are you sure you want to permanently delete your key backup?')) {
      return
    }
    setLoading(true)
    try {
      await deleteKeyBackup(authToken)
      setExistingBackup(null)
      setSuccess('Backup removed from server.')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete backup')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-center justify-between pb-4 border-b border-border">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" />
            <h2 className="text-xl font-bold text-foreground">Encrypted Key Backup</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border my-4">
          <button
            type="button"
            onClick={() => {
              setActiveTab('backup')
              setError(null)
              setSuccess(null)
            }}
            className={`flex-1 py-2 text-center text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'backup'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Upload className="inline-block h-4 w-4 mr-1.5" />
            Create Backup
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('restore')
              setError(null)
              setSuccess(null)
            }}
            className={`flex-1 py-2 text-center text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'restore'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Download className="inline-block h-4 w-4 mr-1.5" />
            Restore Backup
          </button>
        </div>

        <div className="rounded-lg bg-accent/40 p-3 mb-4 text-xs text-muted-foreground flex gap-2">
          <Shield className="h-4 w-4 text-primary shrink-0 mt-0.5" />
          <span>
            <strong>Zero-Knowledge:</strong> Keys are derived with PBKDF2 (600k rounds) + AES-256-GCM entirely in your browser. The server never sees your passphrase or unencrypted keys.
          </span>
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-destructive/15 p-3 text-sm text-destructive border border-destructive/20">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-emerald-500/15 p-3 text-sm text-emerald-600 border border-emerald-500/20">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{success}</span>
          </div>
        )}

        {activeTab === 'backup' ? (
          <form onSubmit={handleCreateBackup} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                Master Backup Passphrase / PIN
              </label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Enter a strong passphrase"
                  className="w-full rounded-lg border border-border bg-background pl-9 pr-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                Confirm Passphrase / PIN
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  type="password"
                  value={confirmPassphrase}
                  onChange={(e) => setConfirmPassphrase(e.target.value)}
                  placeholder="Repeat passphrase"
                  className="w-full rounded-lg border border-border bg-background pl-9 pr-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                  required
                />
              </div>
            </div>

            {existingBackup && (
              <div className="flex items-center justify-between text-xs text-muted-foreground bg-accent/20 p-2.5 rounded-lg border border-border">
                <span>Backup exists on server (v{existingBackup.bundle_version})</span>
                <button
                  type="button"
                  onClick={handleDeleteBackup}
                  className="text-destructive hover:underline flex items-center gap-1"
                >
                  <Trash2 className="h-3 w-3" />
                  Delete
                </button>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Deriving & Encrypting...' : 'Encrypt & Upload Backup'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleRestoreBackup} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                Enter Backup Passphrase / PIN
              </label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Enter your backup passphrase"
                  className="w-full rounded-lg border border-border bg-background pl-9 pr-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Decrypting & Verifying...' : 'Restore & Verify Keys'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
