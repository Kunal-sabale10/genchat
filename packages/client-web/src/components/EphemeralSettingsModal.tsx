import React, { useState } from 'react'
import { Timer, X, Flame, Zap, Clock, Hourglass, Calendar, Ban, ShieldCheck, Check } from 'lucide-react'

interface EphemeralSettingsModalProps {
  isOpen: boolean
  currentTtlSec: number
  channelName: string
  onClose: () => void
  onSave: (ttlSec: number) => void
}

interface DurationTier {
  value: number
  label: string
  sublabel: string
  icon: React.FC<{ className?: string }>
}

const DURATION_TIERS: DurationTier[] = [
  {
    value: 0,
    label: 'Off',
    sublabel: 'Messages are stored until manually cleared',
    icon: Ban,
  },
  {
    value: 30,
    label: '30 Seconds',
    sublabel: 'Rapid self-destruction for ultra-sensitive verification',
    icon: Zap,
  },
  {
    value: 300,
    label: '5 Minutes',
    sublabel: 'Quick transient questions & short conversations',
    icon: Flame,
  },
  {
    value: 3600,
    label: '1 Hour',
    sublabel: 'Temporary coordination & daily task exchanges',
    icon: Clock,
  },
  {
    value: 86400,
    label: '24 Hours',
    sublabel: 'Recommended Signal-grade privacy cycle',
    icon: Hourglass,
  },
  {
    value: 604800,
    label: '7 Days',
    sublabel: 'Weekly cleanup for casual ongoing chats',
    icon: Calendar,
  },
]

export const EphemeralSettingsModal: React.FC<EphemeralSettingsModalProps> = ({
  isOpen,
  currentTtlSec,
  channelName,
  onClose,
  onSave,
}) => {
  const [selectedTtl, setSelectedTtl] = useState<number>(currentTtlSec)

  if (!isOpen) return null

  const handleApply = () => {
    onSave(selectedTtl)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-md flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/90">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-amber-500 to-orange-600 flex items-center justify-center shadow-lg shadow-amber-500/20">
              <Timer className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-white text-base">Disappearing Messages</h3>
              <p className="text-xs text-slate-400 truncate max-w-[260px]">{channelName}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Security / Privacy Banner */}
        <div className="px-6 py-3 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2.5 text-xs text-amber-300">
          <ShieldCheck className="w-4 h-4 shrink-0 text-amber-400" />
          <span>
            When enabled, all new messages self-destruct for everyone after the chosen timer. Zero-trace client erasure.
          </span>
        </div>

        {/* Tiers List */}
        <div className="p-5 space-y-2 overflow-y-auto max-h-[380px]">
          {DURATION_TIERS.map((tier) => {
            const isSelected = selectedTtl === tier.value
            const Icon = tier.icon
            return (
              <button
                key={tier.value}
                type="button"
                onClick={() => setSelectedTtl(tier.value)}
                className={`w-full text-left p-3.5 rounded-xl border transition-all flex items-center justify-between ${
                  isSelected
                    ? 'bg-amber-500/15 border-amber-500/50 text-white shadow-md shadow-amber-500/10'
                    : 'bg-slate-800/40 border-slate-800 hover:bg-slate-800/80 hover:border-slate-700 text-slate-300'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                      isSelected
                        ? 'bg-amber-500 text-slate-950 font-bold'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-sm font-medium flex items-center gap-2">
                      <span>{tier.label}</span>
                      {tier.value === 86400 && (
                        <span className="text-[10px] uppercase font-mono tracking-wider px-1.5 py-0.2 bg-amber-400/20 text-amber-300 border border-amber-400/40 rounded-full">
                          Standard
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">{tier.sublabel}</div>
                  </div>
                </div>
                {isSelected && (
                  <div className="w-5 h-5 rounded-full bg-amber-400 flex items-center justify-center text-slate-950 shrink-0">
                    <Check className="w-3.5 h-3.5 stroke-[3]" />
                  </div>
                )}
              </button>
            )
          })}
        </div>

        {/* Footer actions */}
        <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-end gap-3 bg-slate-900/60">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="px-5 py-2 text-xs font-medium text-slate-950 bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-400 rounded-xl shadow-lg shadow-amber-500/20 transition-all font-semibold"
          >
            Set Timer
          </button>
        </div>
      </div>
    </div>
  )
}
