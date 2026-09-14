import React, { useState, useEffect } from 'react'

interface SecurityDashboardModalProps {
  isOpen: boolean
  onClose: () => void
}

interface SecurityMetrics {
  cryptoFallback: number
  unauthorizedDelete: number
  unauthorizedEdit: number
  unauthorizedPin: number
  blockedMessageDrop: number
  rateLimitExceeded: number
  deviceLinkFailed: number
}

export const SecurityDashboardModal: React.FC<SecurityDashboardModalProps> = ({ isOpen, onClose }) => {
  const [metrics, setMetrics] = useState<SecurityMetrics>({
    cryptoFallback: 0,
    unauthorizedDelete: 0,
    unauthorizedEdit: 0,
    unauthorizedPin: 0,
    blockedMessageDrop: 0,
    rateLimitExceeded: 0,
    deviceLinkFailed: 0,
  })
  const [loading, setLoading] = useState(false)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)

  const fetchMetrics = async () => {
    setLoading(true)
    try {
      const res = await fetch('/metrics')
      if (res.ok) {
        const text = await res.text()
        const parseMetric = (type: string): number => {
          const match = text.match(new RegExp(`security_anomalies_total\\{type="${type}"\\}\\s+(\\d+)`))
          return match ? parseInt(match[1], 10) : 0
        }
        setMetrics({
          cryptoFallback: parseMetric('crypto_fallback'),
          unauthorizedDelete: parseMetric('unauthorized_delete'),
          unauthorizedEdit: parseMetric('unauthorized_edit'),
          unauthorizedPin: parseMetric('unauthorized_pin'),
          blockedMessageDrop: parseMetric('blocked_message_drop'),
          rateLimitExceeded: parseMetric('rate_limit_exceeded'),
          deviceLinkFailed: parseMetric('device_link_failed'),
        })
        setLastRefreshed(new Date())
      }
    } catch {
      // Fallback display if /metrics endpoint is proxied differently
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isOpen) {
      fetchMetrics()
      const interval = setInterval(fetchMetrics, 5000)
      return () => clearInterval(interval)
    }
  }, [isOpen])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl max-w-2xl w-full p-6 text-slate-100 flex flex-col space-y-6">
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-indigo-950 border border-indigo-500/30 rounded-lg text-indigo-400">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                />
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">Live Security Telemetry & Audit Trail</h2>
              <p className="text-xs text-slate-400">
                Real-time anomaly monitoring & fail-closed cryptographic defenses
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-slate-800"
          >
            ✕
          </button>
        </div>

        {/* Status Highlights */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-3">
            <span className="text-xs text-slate-400 block">PQXDH Session</span>
            <span className="text-sm font-semibold text-emerald-400 flex items-center mt-1">
              <span className="w-2 h-2 rounded-full bg-emerald-400 mr-2 animate-pulse"></span>
              ML-KEM-768
            </span>
          </div>
          <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-3">
            <span className="text-xs text-slate-400 block">Group MLS Mode</span>
            <span className="text-sm font-semibold text-emerald-400 flex items-center mt-1">
              <span className="w-2 h-2 rounded-full bg-emerald-400 mr-2"></span>
              RFC 9420 TreeKEM
            </span>
          </div>
          <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-3">
            <span className="text-xs text-slate-400 block">Relay Policy</span>
            <span className="text-sm font-semibold text-blue-400 flex items-center mt-1">
              Fail-Closed
            </span>
          </div>
          <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-3">
            <span className="text-xs text-slate-400 block">Telemetry Sync</span>
            <span className="text-xs text-slate-300 block mt-1">
              {loading ? 'Refreshing...' : lastRefreshed ? lastRefreshed.toLocaleTimeString() : 'Active'}
            </span>
          </div>
        </div>

        {/* Security Anomaly Counters */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
            Detected Security Anomaly Metrics
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex items-center justify-between p-3 bg-slate-800/40 border border-slate-700/40 rounded-lg">
              <div>
                <span className="text-sm font-medium text-slate-200">Crypto Fallback Rate</span>
                <span className="text-xs text-slate-400 block">Must remain 0 in production</span>
              </div>
              <span
                className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                  metrics.cryptoFallback === 0
                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/50'
                    : 'bg-rose-950 text-rose-400 border border-rose-800/50 animate-bounce'
                }`}
              >
                {metrics.cryptoFallback}
              </span>
            </div>

            <div className="flex items-center justify-between p-3 bg-slate-800/40 border border-slate-700/40 rounded-lg">
              <div>
                <span className="text-sm font-medium text-slate-200">Blocked Message Drops</span>
                <span className="text-xs text-slate-400 block">Signal privacy drop-to-blocker</span>
              </div>
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-indigo-950 text-indigo-400 border border-indigo-800/50">
                {metrics.blockedMessageDrop}
              </span>
            </div>

            <div className="flex items-center justify-between p-3 bg-slate-800/40 border border-slate-700/40 rounded-lg">
              <div>
                <span className="text-sm font-medium text-slate-200">Unauthorized Deletions Blocked</span>
                <span className="text-xs text-slate-400 block">Fail-closed author ownership checks</span>
              </div>
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-950 text-amber-400 border border-amber-800/50">
                {metrics.unauthorizedDelete}
              </span>
            </div>

            <div className="flex items-center justify-between p-3 bg-slate-800/40 border border-slate-700/40 rounded-lg">
              <div>
                <span className="text-sm font-medium text-slate-200">Unauthorized Edits & Pins</span>
                <span className="text-xs text-slate-400 block">Imposter rejections by Gateway</span>
              </div>
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-950 text-amber-400 border border-amber-800/50">
                {metrics.unauthorizedEdit + metrics.unauthorizedPin}
              </span>
            </div>

            <div className="flex items-center justify-between p-3 bg-slate-800/40 border border-slate-700/40 rounded-lg">
              <div>
                <span className="text-sm font-medium text-slate-200">Rate Limit Exceeded Events</span>
                <span className="text-xs text-slate-400 block">Token-bucket tiered defenses</span>
              </div>
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-slate-800 text-slate-300 border border-slate-600">
                {metrics.rateLimitExceeded}
              </span>
            </div>

            <div className="flex items-center justify-between p-3 bg-slate-800/40 border border-slate-700/40 rounded-lg">
              <div>
                <span className="text-sm font-medium text-slate-200">Failed Device Linkings</span>
                <span className="text-xs text-slate-400 block">Auth code mismatches / brute-force</span>
              </div>
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-rose-950 text-rose-300 border border-rose-800/50">
                {metrics.deviceLinkFailed}
              </span>
            </div>
          </div>
        </div>

        <div className="flex justify-end space-x-3 pt-2">
          <button
            onClick={fetchMetrics}
            disabled={loading}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm font-medium transition-colors"
          >
            {loading ? 'Refreshing...' : 'Refresh Metrics'}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
