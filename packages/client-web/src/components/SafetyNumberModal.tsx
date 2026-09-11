import React, { useState, useEffect, useRef, useMemo } from 'react'
import {
  ShieldCheck,
  ShieldAlert,
  X,
  Copy,
  Check,
  QrCode,
  Camera,
  RefreshCw,
  AlertTriangle,
  Lock,
} from 'lucide-react'
import {
  SafetyNumberManager,
  QrCodeSvgGenerator,
  TrustRecord,
} from '@/lib/safety-numbers'

interface SafetyNumberModalProps {
  isOpen: boolean
  onClose: () => void
  currentUserId: string
  peerId: string
  peerName?: string
  safetyNumber: string
  onVerificationChange?: (isVerified: boolean) => void
}

export const SafetyNumberModal: React.FC<SafetyNumberModalProps> = ({
  isOpen,
  onClose,
  currentUserId,
  peerId,
  peerName,
  safetyNumber,
  onVerificationChange,
}) => {
  const [activeTab, setActiveTab] = useState<'view' | 'scan'>('view')
  const [copied, setCopied] = useState(false)
  const [trustRecord, setTrustRecord] = useState<TrustRecord>(() =>
    SafetyNumberManager.getTrustRecord(peerId, safetyNumber)
  )

  // Camera scanner state
  const videoRef = useRef<HTMLVideoElement>(null)
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [scanResult, setScanResult] = useState<{ success: boolean; message: string } | null>(null)
  const scanIntervalRef = useRef<number | null>(null)

  // Refresh trust record when peerId or safetyNumber changes
  useEffect(() => {
    setTrustRecord(SafetyNumberManager.getTrustRecord(peerId, safetyNumber))
  }, [peerId, safetyNumber])

  // Generate QR payload and SVG
  const qrPayload = useMemo(() => {
    return SafetyNumberManager.generateQrPayload(currentUserId, peerId, safetyNumber)
  }, [currentUserId, peerId, safetyNumber])

  const qrSvg = useMemo(() => {
    return QrCodeSvgGenerator.generateSvg(qrPayload, 200, 2)
  }, [qrPayload])

  // 12 blocks of 5 digits
  const numberBlocks = useMemo(() => {
    return safetyNumber.trim().split(/\s+/)
  }, [safetyNumber])

  const handleCopy = () => {
    navigator.clipboard.writeText(safetyNumber)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleToggleVerified = () => {
    if (trustRecord.isVerified) {
      SafetyNumberManager.revokeVerification(peerId)
      const updated = SafetyNumberManager.getTrustRecord(peerId, safetyNumber)
      setTrustRecord(updated)
      onVerificationChange?.(false)
    } else {
      SafetyNumberManager.setVerified(peerId, safetyNumber)
      const updated = SafetyNumberManager.getTrustRecord(peerId, safetyNumber)
      setTrustRecord(updated)
      onVerificationChange?.(true)
    }
  }

  // Camera Scanner Logic
  const startCamera = async () => {
    setCameraError(null)
    setScanResult(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
      })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        setCameraActive(true)

        // Start scanning loop if BarcodeDetector is supported
        if ('BarcodeDetector' in window) {
          // @ts-ignore - BarcodeDetector standard web API
          const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
          scanIntervalRef.current = window.setInterval(async () => {
            if (!videoRef.current || videoRef.current.readyState < 2) return
            try {
              const barcodes = await detector.detect(videoRef.current)
              if (barcodes.length > 0) {
                const scannedRaw = barcodes[0].rawValue
                handleScannedPayload(scannedRaw)
              }
            } catch {
              // Ignore frame detection hiccups
            }
          }, 400)
        }
      }
    } catch (err: any) {
      console.error('[SafetyNumberModal] Camera access error:', err)
      setCameraError('Camera access denied or unavailable. Please grant camera permission.')
      setCameraActive(false)
    }
  }

  const stopCamera = () => {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current)
      scanIntervalRef.current = null
    }
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream
      stream.getTracks().forEach((t) => t.stop())
      videoRef.current.srcObject = null
    }
    setCameraActive(false)
  }

  const handleScannedPayload = (scannedText: string) => {
    const result = SafetyNumberManager.parseAndVerifyQrPayload(
      scannedText,
      currentUserId,
      peerId,
      safetyNumber
    )

    if (result.isValid) {
      stopCamera()
      SafetyNumberManager.setVerified(peerId, safetyNumber)
      setTrustRecord(SafetyNumberManager.getTrustRecord(peerId, safetyNumber))
      onVerificationChange?.(true)
      setScanResult({
        success: true,
        message: '✓ Safety Numbers Match! Contact successfully marked as verified.',
      })
      setTimeout(() => {
        setActiveTab('view')
      }, 1500)
    } else {
      setScanResult({
        success: false,
        message: result.error || 'Scanned code does not match',
      })
    }
  }

  // Handle tab switch
  const handleSwitchTab = (tab: 'view' | 'scan') => {
    setActiveTab(tab)
    if (tab === 'scan') {
      startCamera()
    } else {
      stopCamera()
    }
  }

  // Stop camera on unmount or modal close
  useEffect(() => {
    return () => {
      stopCamera()
    }
  }, [])

  if (!isOpen) return null

  const displayName = peerName || peerId.slice(0, 8)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl flex flex-col max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center space-x-2.5">
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-xl ${
                trustRecord.hasChanged
                  ? 'bg-amber-500/20 text-amber-400'
                  : trustRecord.isVerified
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : 'bg-indigo-600/20 text-indigo-400'
              }`}
            >
              {trustRecord.hasChanged ? (
                <AlertTriangle className="h-5 w-5" />
              ) : trustRecord.isVerified ? (
                <ShieldCheck className="h-5 w-5" />
              ) : (
                <Lock className="h-5 w-5" />
              )}
            </div>
            <div>
              <h3 className="font-semibold text-slate-100 text-sm">
                Verify Safety Number
              </h3>
              <p className="text-xs text-slate-400">
                End-to-End Cryptographic Identity
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Key Change Warning Banner */}
        {trustRecord.hasChanged && (
          <div className="mt-4 rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 flex items-start space-x-3 text-amber-300">
            <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-amber-400" />
            <div className="text-xs space-y-1">
              <p className="font-semibold">Security Number has changed!</p>
              <p className="text-amber-300/80 leading-relaxed">
                The cryptographic keys for <strong>@{displayName}</strong> have changed since your last verification. This usually happens when they reinstalled GenChat or switched devices. Compare the numbers below before marking as verified.
              </p>
            </div>
          </div>
        )}

        {/* Tab Selector */}
        <div className="mt-4 flex rounded-xl bg-slate-950 p-1 border border-slate-800">
          <button
            onClick={() => handleSwitchTab('view')}
            className={`flex-1 flex items-center justify-center space-x-2 py-2 text-xs font-medium rounded-lg transition ${
              activeTab === 'view'
                ? 'bg-slate-800 text-slate-100 shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <QrCode className="h-3.5 w-3.5" />
            <span>Safety Number & QR</span>
          </button>
          <button
            onClick={() => handleSwitchTab('scan')}
            className={`flex-1 flex items-center justify-center space-x-2 py-2 text-xs font-medium rounded-lg transition ${
              activeTab === 'scan'
                ? 'bg-slate-800 text-slate-100 shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Camera className="h-3.5 w-3.5" />
            <span>Scan Peer's Code</span>
          </button>
        </div>

        {/* Tab 1: View Safety Number & QR Code */}
        {activeTab === 'view' && (
          <div className="mt-5 space-y-5">
            <p className="text-xs text-slate-400 text-center leading-relaxed">
              If you wish to confirm that your end-to-end encryption is securely verified with{' '}
              <span className="text-indigo-300 font-semibold">@{displayName}</span>, compare the numbers below or scan their code.
            </p>

            {/* QR Code Container */}
            <div className="flex flex-col items-center justify-center">
              <div
                className="p-3 bg-white rounded-2xl shadow-xl transition hover:scale-[1.02]"
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
              <span className="mt-2 text-[11px] text-slate-500 font-mono">
                Scan with peer device
              </span>
            </div>

            {/* 60-digit Numeric Matrix (12 blocks of 5 digits) */}
            <div className="rounded-xl bg-slate-950 border border-slate-800 p-4">
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 text-center font-mono text-xs font-semibold text-emerald-400 tracking-wider">
                {numberBlocks.map((block, idx) => (
                  <div
                    key={idx}
                    className="py-1.5 px-1 bg-slate-900/80 rounded border border-slate-800/80 select-all hover:border-emerald-500/40 transition"
                  >
                    {block}
                  </div>
                ))}
              </div>
            </div>

            {/* Copy Button & Status Bar */}
            <div className="flex items-center justify-between text-xs pt-1">
              <button
                onClick={handleCopy}
                className="flex items-center space-x-1.5 text-slate-400 hover:text-indigo-300 transition py-1 px-2 rounded-lg hover:bg-slate-800/60"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                <span>{copied ? 'Copied to clipboard' : 'Copy Number'}</span>
              </button>

              <div className="flex items-center space-x-1.5">
                {trustRecord.isVerified ? (
                  <span className="flex items-center space-x-1 text-emerald-400 font-medium">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    <span>Verified</span>
                  </span>
                ) : (
                  <span className="flex items-center space-x-1 text-slate-500">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    <span>Not Verified</span>
                  </span>
                )}
              </div>
            </div>

            {/* Verification Toggle Action */}
            <div className="pt-2 border-t border-slate-800 flex justify-end space-x-3">
              {trustRecord.isVerified ? (
                <button
                  onClick={handleToggleVerified}
                  className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs font-medium text-red-300 hover:bg-red-500/20 transition"
                >
                  Clear Verification
                </button>
              ) : (
                <button
                  onClick={handleToggleVerified}
                  className="flex items-center space-x-1.5 rounded-xl bg-emerald-600 px-5 py-2 text-xs font-medium text-white hover:bg-emerald-500 transition shadow-lg shadow-emerald-600/20"
                >
                  <ShieldCheck className="h-4 w-4" />
                  <span>Mark as Verified</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Tab 2: Camera Scanner */}
        {activeTab === 'scan' && (
          <div className="mt-5 space-y-4">
            <p className="text-xs text-slate-400 text-center">
              Point your camera at <span className="text-indigo-300 font-semibold">@{displayName}'s</span> QR code to instantly verify encryption keys.
            </p>

            <div className="relative aspect-square w-full max-w-[280px] mx-auto rounded-2xl overflow-hidden bg-slate-950 border border-slate-800 flex items-center justify-center">
              {cameraActive ? (
                <>
                  <video
                    ref={videoRef}
                    className="h-full w-full object-cover"
                    autoPlay
                    playsInline
                    muted
                  />
                  {/* Scanner overlay viewfinder reticle */}
                  <div className="absolute inset-0 border-2 border-emerald-400/60 m-8 rounded-xl pointer-events-none animate-pulse" />
                </>
              ) : cameraError ? (
                <div className="p-4 text-center text-xs text-red-400 space-y-2">
                  <AlertTriangle className="h-8 w-8 mx-auto text-red-400" />
                  <p>{cameraError}</p>
                  <button
                    onClick={startCamera}
                    className="mt-2 inline-flex items-center space-x-1 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 text-xs hover:bg-slate-700"
                  >
                    <RefreshCw className="h-3 w-3" />
                    <span>Try Again</span>
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center text-slate-500 text-xs space-y-2">
                  <Camera className="h-8 w-8 text-slate-600" />
                  <span>Initializing camera...</span>
                </div>
              )}
            </div>

            {/* Scan Feedback Result */}
            {scanResult && (
              <div
                className={`p-3 rounded-xl border text-xs text-center font-medium ${
                  scanResult.success
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-red-500/10 border-red-500/30 text-red-300'
                }`}
              >
                {scanResult.message}
              </div>
            )}

            <div className="pt-2 border-t border-slate-800 flex justify-between items-center text-xs text-slate-400">
              <span>Align QR code within the frame</span>
              <button
                onClick={() => handleSwitchTab('view')}
                className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700 transition"
              >
                Back to QR Code
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
