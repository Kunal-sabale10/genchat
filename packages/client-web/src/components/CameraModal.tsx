import React, { useState, useEffect, useRef } from 'react'
import { Camera, RefreshCw, X, Check, AlertCircle, Sparkles } from 'lucide-react'

interface CameraModalProps {
  isOpen: boolean
  onClose: () => void
  onCapture: (file: File) => void
}

export function CameraModal({ isOpen, onClose, onCapture }: CameraModalProps) {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user')
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isInitializing, setIsInitializing] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // 1. Enumerate video devices
  useEffect(() => {
    if (!isOpen) return

    const getDevices = async () => {
      try {
        const allDevices = await navigator.mediaDevices.enumerateDevices()
        const videoInputs = allDevices.filter((d) => d.kind === 'videoinput')
        setDevices(videoInputs)
        if (videoInputs.length > 0 && !selectedDeviceId) {
          setSelectedDeviceId(videoInputs[0].deviceId)
        }
      } catch (err) {
        console.warn('[Camera] Failed to enumerate devices:', err)
      }
    }

    getDevices()
  }, [isOpen])

  // 2. Start Camera Stream
  useEffect(() => {
    if (!isOpen || capturedBlob) return

    let activeStream: MediaStream | null = null

    const startCamera = async () => {
      setIsInitializing(true)
      setError(null)

      try {
        // Stop any old stream tracks
        if (stream) {
          stream.getTracks().forEach((t) => t.stop())
        }

        const constraints: MediaStreamConstraints = {
          audio: false,
          video: selectedDeviceId
            ? { deviceId: { exact: selectedDeviceId } }
            : { facingMode: facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
        }

        const mediaStream = await navigator.mediaDevices.getUserMedia(constraints)
        activeStream = mediaStream
        setStream(mediaStream)

        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream
          await videoRef.current.play().catch(() => {})
        }
      } catch (err: any) {
        console.error('[Camera] Error starting camera:', err)
        setError(
          err.name === 'NotAllowedError'
            ? 'Camera permission denied. Please allow camera access in your browser settings.'
            : err.name === 'NotFoundError'
            ? 'No camera device found on this system.'
            : 'Unable to start camera. Please check device permissions and try again.'
        )
      } finally {
        setIsInitializing(false)
      }
    }

    startCamera()

    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach((t) => t.stop())
      }
    }
  }, [isOpen, selectedDeviceId, facingMode, capturedBlob])

  // Clean up preview URL when unmounted
  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl)
      }
    }
  }, [previewUrl])

  // Switch facing mode / camera
  const handleSwitchCamera = () => {
    if (devices.length > 1) {
      const currentIndex = devices.findIndex((d) => d.deviceId === selectedDeviceId)
      const nextIndex = (currentIndex + 1) % devices.length
      setSelectedDeviceId(devices[nextIndex].deviceId)
    } else {
      setFacingMode((prev) => (prev === 'user' ? 'environment' : 'user'))
    }
  }

  // Snap Snapshot
  const handleCapture = () => {
    if (!videoRef.current) return

    const video = videoRef.current
    const width = video.videoWidth || 1280
    const height = video.videoHeight || 720

    const canvas = canvasRef.current || document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // If front camera, mirror image for natural selfie orientation
    if (facingMode === 'user' && !selectedDeviceId) {
      ctx.translate(width, 0)
      ctx.scale(-1, 1)
    }

    ctx.drawImage(video, 0, 0, width, height)

    canvas.toBlob(
      (blob) => {
        if (!blob) return
        setCapturedBlob(blob)
        const url = URL.createObjectURL(blob)
        setPreviewUrl(url)

        // Stop camera tracks once captured
        if (stream) {
          stream.getTracks().forEach((t) => t.stop())
          setStream(null)
        }
      },
      'image/jpeg',
      0.92
    )
  }

  // Retake Photo
  const handleRetake = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl)
    }
    setCapturedBlob(null)
    setPreviewUrl(null)
  }

  // Confirm Photo
  const handleConfirm = () => {
    if (!capturedBlob) return

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = new File([capturedBlob], `photo_${timestamp}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    })

    onCapture(file)
    handleClose()
  }

  const handleClose = () => {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop())
      setStream(null)
    }
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl)
    }
    setCapturedBlob(null)
    setPreviewUrl(null)
    setError(null)
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="relative flex flex-col w-full max-w-xl overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-3.5 bg-slate-950/40">
          <div className="flex items-center space-x-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400">
              <Camera className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                {capturedBlob ? 'Review Photo' : 'Take Photo'}
              </h3>
              <p className="text-[11px] text-slate-400">
                {capturedBlob ? 'Confirm or retake before sending' : 'High-resolution snapshot'}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {!capturedBlob && devices.length > 1 && (
              <button
                type="button"
                onClick={handleSwitchCamera}
                className="flex items-center space-x-1 rounded-lg border border-slate-800 bg-slate-800/60 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-white transition"
                title="Switch Camera"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Flip</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Viewport */}
        <div className="relative aspect-4/3 w-full bg-black flex items-center justify-center overflow-hidden">
          {error ? (
            <div className="flex flex-col items-center max-w-sm text-center p-6 space-y-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/10 text-rose-400">
                <AlertCircle className="h-6 w-6" />
              </div>
              <p className="text-sm text-rose-300">{error}</p>
              <button
                type="button"
                onClick={() => {
                  setError(null)
                  setCapturedBlob(null)
                }}
                className="rounded-lg bg-slate-800 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 transition"
              >
                Try Again
              </button>
            </div>
          ) : capturedBlob && previewUrl ? (
            <img
              src={previewUrl}
              alt="Captured preview"
              className="h-full w-full object-contain"
            />
          ) : (
            <>
              <video
                ref={videoRef}
                playsInline
                autoPlay
                muted
                className={`h-full w-full object-cover ${
                  facingMode === 'user' && !selectedDeviceId ? 'scale-x-[-1]' : ''
                }`}
              />
              {isInitializing && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 space-y-2">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
                  <p className="text-xs text-slate-300">Accessing camera...</p>
                </div>
              )}
            </>
          )}

          <canvas ref={canvasRef} className="hidden" />
        </div>

        {/* Controls Footer */}
        <div className="flex items-center justify-between border-t border-slate-800 px-6 py-4 bg-slate-950/60">
          {capturedBlob ? (
            <div className="flex items-center justify-between w-full">
              <button
                type="button"
                onClick={handleRetake}
                className="flex items-center space-x-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-xs font-medium text-slate-200 hover:bg-slate-700 transition"
              >
                <RefreshCw className="h-4 w-4" />
                <span>Retake</span>
              </button>

              <button
                type="button"
                onClick={handleConfirm}
                className="flex items-center space-x-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-500 transition"
              >
                <Check className="h-4 w-4" />
                <span>Use Photo</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-center w-full relative">
              <span className="absolute left-0 text-[11px] text-slate-500 hidden sm:inline">
                Click shutter to snap
              </span>

              <button
                type="button"
                disabled={Boolean(error) || isInitializing}
                onClick={handleCapture}
                className="group relative flex h-16 w-16 items-center justify-center rounded-full border-4 border-white/80 bg-white/20 hover:bg-white/30 disabled:opacity-40 transition"
                title="Capture Photo"
              >
                <div className="h-11 w-11 rounded-full bg-white shadow-md group-hover:scale-95 transition-transform" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
