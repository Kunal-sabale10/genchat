import React, { useState, useEffect } from 'react'
import {
  Shield,
  Smartphone,
  Laptop,
  Monitor,
  Trash2,
  X,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Loader2,
  Clock,
  KeyRound,
} from 'lucide-react'

export interface ActiveSession {
  id: string
  user_id: string
  device_id: string
  device_label: string
  created_at: string
  last_seen_at: string
  expires_at: string
  is_current: boolean
}

export interface ActiveSessionsModalProps {
  isOpen: boolean
  onClose: () => void
  authToken: string | null
  currentDeviceId?: string
}

export const ActiveSessionsModal: React.FC<ActiveSessionsModalProps> = ({
  isOpen,
  onClose,
  authToken,
  currentDeviceId,
}) => {
  const [sessions, setSessions] = useState<ActiveSession[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const authBaseUrl = (import.meta as any).env?.VITE_AUTH_URL || ''

  const fetchSessions = async () => {
    if (!authToken) return
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch(`${authBaseUrl}/api/v1/sessions`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      })
      if (!resp.ok) {
        throw new Error(`Failed to load sessions: ${resp.status} ${resp.statusText}`)
      }
      const data = await resp.json()
      const rawSessions: ActiveSession[] = data.sessions || []
      const mapped = rawSessions.map((s) => ({
        ...s,
        is_current: currentDeviceId ? s.device_id === currentDeviceId : s.is_current,
      }))
      setSessions(mapped)
    } catch (err: any) {
      setError(err?.message || 'Could not fetch active sessions')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isOpen && authToken) {
      fetchSessions()
      setConfirmRevokeId(null)
      setSuccessMessage(null)
    } else {
      setSessions([])
      setError(null)
    }
  }, [isOpen, authToken])

  if (!isOpen) return null

  const handleRevokeSession = async (sessionId: string) => {
    if (!authToken) return
    setRevokingId(sessionId)
    setError(null)
    setSuccessMessage(null)
    try {
      const resp = await fetch(`${authBaseUrl}/api/v1/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      })
      if (!resp.ok) {
        const postResp = await fetch(`${authBaseUrl}/api/v1/sessions/revoke`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ session_id: sessionId }),
        })
        if (!postResp.ok) {
          throw new Error(`Failed to revoke session (${resp.status})`)
        }
      }
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
      setConfirmRevokeId(null)
      setSuccessMessage('Session revoked successfully.')
      setTimeout(() => setSuccessMessage(null), 3000)
    } catch (err: any) {
      setError(err?.message || 'Failed to revoke session')
    } finally {
      setRevokingId(null)
    }
  }

  const getDeviceIcon = (label: string) => {
    const l = (label || '').toLowerCase()
    if (l.includes('phone') || l.includes('mobile') || l.includes('iphone') || l.includes('android')) {
      return <Smartphone className="w-5 h-5 text-indigo-400" />
    }
    if (l.includes('mac') || l.includes('laptop') || l.includes('pc') || l.includes('desktop') || l.includes('windows')) {
      return <Laptop className="w-5 h-5 text-emerald-400" />
    }
    return <Monitor className="w-5 h-5 text-zinc-400" />
  }

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr)
      if (isNaN(d.getTime())) return dateStr
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return dateStr
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-indigo-500/10 text-indigo-400 rounded-xl border border-indigo-500/20">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-100">Active Sessions & Devices</h2>
              <p className="text-xs text-zinc-400">Manage authenticated devices and revoke access</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={fetchSessions}
              disabled={loading}
              className="p-2 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 rounded-xl transition-colors disabled:opacity-40"
              title="Refresh sessions"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 rounded-xl transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 overflow-y-auto flex-1">
          {error && (
            <div className="p-3 bg-red-950/40 border border-red-800/60 rounded-xl text-xs text-red-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {successMessage && (
            <div className="p-3 bg-emerald-950/40 border border-emerald-800/60 rounded-xl text-xs text-emerald-300 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              <span>{successMessage}</span>
            </div>
          )}

          <div className="p-3 bg-zinc-950/60 border border-zinc-800/80 rounded-xl space-y-1.5 text-xs text-zinc-400">
            <div className="flex items-center gap-1.5 font-medium text-zinc-300">
              <KeyRound className="w-4 h-4 text-indigo-400" />
              <span>Session Security & Device Cap</span>
            </div>
            <p className="text-[11px] leading-relaxed">
              Your account allows up to 5 concurrent active devices. Revoking a session immediately terminates its WebSocket connection, invalidates its refresh token, and purges cryptographic access keys.
            </p>
          </div>

          {loading && sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-zinc-500 gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
              <span className="text-xs">Fetching active sessions...</span>
            </div>
          ) : sessions.length === 0 ? (
            <div className="text-center py-8 text-zinc-500 text-xs">
              No active sessions found.
            </div>
          ) : (
            <div className="space-y-2.5">
              {sessions.map((sess) => (
                <div
                  key={sess.id}
                  className={`p-3.5 rounded-xl border transition-all ${
                    sess.is_current
                      ? 'bg-indigo-950/20 border-indigo-500/30'
                      : 'bg-zinc-950/40 border-zinc-800/70 hover:border-zinc-700/80'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-zinc-800/60 rounded-xl border border-zinc-700/40 mt-0.5">
                        {getDeviceIcon(sess.device_label)}
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-zinc-200">
                            {sess.device_label || 'Linked Device'}
                          </span>
                          {sess.is_current && (
                            <span className="px-2 py-0.5 text-[10px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded-full">
                              This Device
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-zinc-400 flex items-center gap-2 flex-wrap">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3 text-zinc-500" />
                            Active {formatDate(sess.last_seen_at || sess.created_at)}
                          </span>
                          <span className="text-zinc-600">•</span>
                          <code className="text-[10px] font-mono text-zinc-500">
                            {sess.device_id ? sess.device_id.slice(0, 8) + '...' : ''}
                          </code>
                        </div>
                      </div>
                    </div>

                    {!sess.is_current && (
                      <div className="flex items-center">
                        {confirmRevokeId === sess.id ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleRevokeSession(sess.id)}
                              disabled={revokingId === sess.id}
                              className="px-2.5 py-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                            >
                              {revokingId === sess.id ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                'Confirm'
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmRevokeId(null)}
                              className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmRevokeId(sess.id)}
                            className="p-2 text-zinc-400 hover:text-red-400 hover:bg-red-950/20 rounded-xl transition-colors"
                            title="Revoke session"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-zinc-800/80 bg-zinc-900/50 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl text-xs font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
