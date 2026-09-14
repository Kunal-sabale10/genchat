import React, { useState, useEffect } from 'react'
import {
  Smartphone,
  QrCode,
  X,
  Copy,
  Check,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Key,
} from 'lucide-react'
import {
  initiateDeviceLinking,
  checkDeviceLinkingStatus,
  DeviceLinkingInitResult,
} from '../lib/device-linking'

interface DeviceLinkingModalProps {
  isOpen: boolean
  onClose: () => void
  authToken: string
}

export const DeviceLinkingModal: React.FC<DeviceLinkingModalProps> = ({
  isOpen,
  onClose,
  authToken,
}) => {
  const [initResult, setInitResult] = useState<DeviceLinkingInitResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [sessionStatus, setSessionStatus] = useState<string>('pending')

  useEffect(() => {
    if (isOpen && authToken) {
      startInitiation()
    } else {
      setInitResult(null)
      setSessionStatus('pending')
    }
  }, [isOpen, authToken])

  const startInitiation = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await initiateDeviceLinking(authToken)
      setInitResult(res)
      setSessionStatus('pending')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to initiate linking session')
    } finally {
      setLoading(false)
    }
  }

  // Poll for status while session is active
  useEffect(() => {
    if (!isOpen || !authToken || !initResult || sessionStatus === 'consumed') return

    const interval = setInterval(async () => {
      try {
        const s = await checkDeviceLinkingStatus(authToken, initResult.sessionId)
        setSessionStatus(s.status)
      } catch {
        // Ignored
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [isOpen, authToken, initResult, sessionStatus])

  if (!isOpen) return null

  const handleCopyCode = () => {
    if (initResult) {
      navigator.clipboard.writeText(initResult.confirmationCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-center justify-between pb-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Smartphone className="h-6 w-6 text-primary" />
            <h2 className="text-xl font-bold text-foreground">Link Another Device</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="my-4 text-xs text-muted-foreground">
          Scan the QR code or enter the 6-digit confirmation code on your secondary device to securely transfer identity keys and MLS state.
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-destructive/15 p-3 text-sm text-destructive border border-destructive/20">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center py-10 gap-3">
            <RefreshCw className="h-8 w-8 animate-spin text-primary" />
            <span className="text-sm text-muted-foreground">Generating ephemeral ECDH keypair...</span>
          </div>
        ) : initResult ? (
          <div className="space-y-5">
            {/* Visual Pairing Card */}
            <div className="flex flex-col items-center justify-center rounded-xl bg-accent/20 p-6 border border-border">
              <QrCode className="h-28 w-28 text-foreground/80 mb-4" />
              <span className="text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wider">
                Pairing Confirmation Code
              </span>
              <div className="flex items-center gap-3">
                <span className="text-3xl font-mono font-bold tracking-widest text-primary">
                  {initResult.confirmationCode.slice(0, 3)} {initResult.confirmationCode.slice(3)}
                </span>
                <button
                  type="button"
                  onClick={handleCopyCode}
                  className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                  title="Copy code"
                >
                  {copied ? <Check className="h-5 w-5 text-emerald-500" /> : <Copy className="h-5 w-5" />}
                </button>
              </div>
            </div>

            {/* Status indicator */}
            <div className="rounded-lg border border-border bg-card p-3 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <Key className="h-4 w-4 text-primary" />
                <span>Status:</span>
              </div>
              <span className="font-medium capitalize text-foreground flex items-center gap-1.5">
                {sessionStatus === 'consumed' ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Linked Successfully
                  </>
                ) : (
                  <>
                    <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                    Waiting for device ({sessionStatus})
                  </>
                )}
              </span>
            </div>

            <button
              type="button"
              onClick={startInitiation}
              className="w-full flex items-center justify-center gap-2 rounded-lg border border-border py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              Generate New Pairing Code
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
