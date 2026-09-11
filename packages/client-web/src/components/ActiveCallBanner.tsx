import React from 'react'
import { Phone, Users, Video } from 'lucide-react'

export interface ActiveCallBannerProps {
  channelName: string
  callType: 'audio' | 'video'
  participantCount: number
  onJoin: () => void
}

export const ActiveCallBanner: React.FC<ActiveCallBannerProps> = ({
  channelName,
  callType,
  participantCount,
  onJoin,
}) => {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-emerald-950/80 via-indigo-950/70 to-slate-900 border-b border-emerald-500/30 backdrop-blur-md animate-in fade-in slide-in-from-top-1">
      <div className="flex items-center space-x-3">
        <div className="relative flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shadow-xs">
          {callType === 'video' ? (
            <Video className="h-4 w-4 animate-pulse" />
          ) : (
            <Phone className="h-4 w-4 animate-pulse" />
          )}
          <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
          </span>
        </div>

        <div>
          <p className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
            <span>Group {callType === 'video' ? 'Video' : 'Voice'} Call Active</span>
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded-full text-[10px] bg-emerald-500/20 border border-emerald-500/30 text-emerald-200">
              <Users className="w-2.5 h-2.5" />
              {participantCount} {participantCount === 1 ? 'participant' : 'participants'}
            </span>
          </p>
          <p className="text-[11px] text-slate-400">
            Ongoing conversation in #{channelName}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={onJoin}
        className="inline-flex items-center space-x-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white shadow-md shadow-emerald-900/30 transition transform active:scale-95"
      >
        <Phone className="h-3.5 w-3.5" />
        <span>Join Call</span>
      </button>
    </div>
  )
}
