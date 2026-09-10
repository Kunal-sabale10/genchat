import React, { useState, useEffect } from 'react'
import { Users, UserPlus, UserMinus, LogOut, ShieldCheck, X, Crown, Shield, User, Loader2, AlertCircle } from 'lucide-react'
import { MlsGroupManager, MlsLocalGroupState } from '../lib/mls-group-manager'

interface ChannelMemberInfo {
  userId: string
  role?: string
  leafIndex?: number
  isOwner?: boolean
}

interface GroupMembersModalProps {
  isOpen: boolean
  onClose: () => void
  channelId: string
  channelName: string
  currentUserId: string
  accessToken: string
  wsSend?: (frame: any) => void
  onLeftGroup?: () => void
}

export const GroupMembersModal: React.FC<GroupMembersModalProps> = ({
  isOpen,
  onClose,
  channelId,
  channelName,
  currentUserId,
  accessToken,
  wsSend,
  onLeftGroup,
}) => {
  const [groupState, setGroupState] = useState<MlsLocalGroupState | null>(null)
  const [serverMembers, setServerMembers] = useState<any[]>([])
  const [newUserId, setNewUserId] = useState('')
  const [loading, setLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const loadGroupData = React.useCallback(async () => {
    if (!channelId) return
    setLoading(true)

    // 1. Load local MLS group state
    const local = MlsGroupManager.getLocalGroupState(channelId)
    setGroupState(local)

    // 2. Fetch server channel members
    try {
      const cleanId = channelId.replace('chan_', '')
      const res = await fetch(`/chat.v1.ChannelService/GetChannelMembers?channel_id=${encodeURIComponent(cleanId)}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      })
      if (res.ok) {
        const data = await res.json()
        setServerMembers(data.members || [])
      }
    } catch (err) {
      console.warn('[GroupMembersModal] Failed to fetch server members:', err)
    } finally {
      setLoading(false)
    }
  }, [channelId, accessToken])

  useEffect(() => {
    if (isOpen) {
      loadGroupData()
      setStatusMessage(null)
      setNewUserId('')
    }
  }, [isOpen, loadGroupData])

  if (!isOpen) return null

  // Combine local MLS ratchet members with server roles
  const combinedMembers: ChannelMemberInfo[] = []
  const seenUsers = new Set<string>()

  // Start with local MLS ratchet tree members
  if (groupState?.members) {
    for (const m of groupState.members) {
      seenUsers.add(m.userId)
      const sMember = serverMembers.find(sm => sm.user_id === m.userId || sm.userId === m.userId)
      combinedMembers.push({
        userId: m.userId,
        leafIndex: m.leafIndex,
        role: sMember?.role === 1 || sMember?.role === 'owner' ? 'owner' : sMember?.role === 2 || sMember?.role === 'admin' ? 'admin' : 'member',
        isOwner: m.leafIndex === 0 || sMember?.role === 1 || sMember?.role === 'owner',
      })
    }
  }

  // Include any remaining server members not yet in local ratchet
  for (const sm of serverMembers) {
    const uid = sm.user_id || sm.userId
    if (!seenUsers.has(uid)) {
      seenUsers.add(uid)
      combinedMembers.push({
        userId: uid,
        role: sm.role === 1 || sm.role === 'owner' ? 'owner' : sm.role === 2 || sm.role === 'admin' ? 'admin' : 'member',
        isOwner: sm.role === 1 || sm.role === 'owner',
      })
    }
  }

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault()
    const target = newUserId.trim()
    if (!target) return

    if (combinedMembers.some(m => m.userId.toLowerCase() === target.toLowerCase())) {
      setStatusMessage({ type: 'error', text: 'User is already a member of this group.' })
      return
    }

    setActionLoading('add')
    setStatusMessage(null)

    try {
      const updatedState = await MlsGroupManager.addMember(
        channelId,
        target,
        currentUserId,
        accessToken,
        wsSend
      )

      if (updatedState) {
        setGroupState(updatedState)
        setNewUserId('')
        setStatusMessage({
          type: 'success',
          text: `Added ${target} to group (MLS Epoch advanced to ${updatedState.epoch}).`,
        })
        await loadGroupData()
      } else {
        setStatusMessage({ type: 'error', text: 'Failed to add member to MLS group.' })
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err?.message || 'Error adding member.' })
    } finally {
      setActionLoading(null)
    }
  }

  const handleRemoveMember = async (targetUserId: string) => {
    if (!window.confirm(`Are you sure you want to remove ${targetUserId} from this group?`)) {
      return
    }

    setActionLoading(`remove_${targetUserId}`)
    setStatusMessage(null)

    try {
      const updatedState = await MlsGroupManager.removeMember(
        channelId,
        currentUserId,
        targetUserId,
        accessToken,
        wsSend
      )

      if (updatedState) {
        setGroupState(updatedState)
        setStatusMessage({
          type: 'success',
          text: `Removed ${targetUserId} from group (MLS Epoch advanced to ${updatedState.epoch}).`,
        })
        await loadGroupData()
      } else {
        setStatusMessage({ type: 'error', text: 'Failed to remove member from group.' })
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err?.message || 'Error removing member.' })
    } finally {
      setActionLoading(null)
    }
  }

  const handleLeaveGroup = async () => {
    if (!window.confirm('Are you sure you want to leave this group? You will no longer receive new messages.')) {
      return
    }

    setActionLoading('leave')
    try {
      const ok = await MlsGroupManager.leaveGroup(channelId, currentUserId, accessToken, wsSend)
      if (ok) {
        onClose()
        if (onLeftGroup) onLeftGroup()
      } else {
        setStatusMessage({ type: 'error', text: 'Failed to leave channel.' })
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err?.message || 'Error leaving group.' })
    } finally {
      setActionLoading(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/90">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Users className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-white text-base">Group Information & Members</h3>
              <p className="text-xs text-slate-400 truncate max-w-[280px]">{channelName}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status / MLS Security Badge */}
        <div className="px-6 py-3 bg-slate-800/40 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-emerald-400 font-medium">
            <ShieldCheck className="w-4 h-4" />
            <span>RFC 9420 MLS TreeKEM Active</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
              Epoch: {groupState ? groupState.epoch : 0}
            </span>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-indigo-500/10 text-indigo-300 border border-indigo-500/30">
              {combinedMembers.length} {combinedMembers.length === 1 ? 'member' : 'members'}
            </span>
          </div>
        </div>

        {/* Feedback Alert */}
        {statusMessage && (
          <div
            className={`mx-6 mt-4 p-3 rounded-xl text-xs flex items-center gap-2 border ${
              statusMessage.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
            }`}
          >
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{statusMessage.text}</span>
          </div>
        )}

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1">
          {/* Add Member Form */}
          <form onSubmit={handleAddMember} className="space-y-2">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">
              Add New Member to MLS Group
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={newUserId}
                onChange={e => setNewUserId(e.target.value)}
                placeholder="Enter user UUID or username..."
                disabled={actionLoading === 'add'}
                className="flex-1 px-3.5 py-2 rounded-xl text-xs bg-slate-800/70 border border-slate-700 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
              <button
                type="submit"
                disabled={!newUserId.trim() || actionLoading === 'add'}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0 shadow-sm"
              >
                {actionLoading === 'add' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <UserPlus className="w-3.5 h-3.5" />
                )}
                <span>Add Member</span>
              </button>
            </div>
          </form>

          {/* Members List */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Current Ratchet Tree Members
              </span>
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
            </div>

            <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
              {combinedMembers.map((member) => {
                const isMe = member.userId === currentUserId
                const isRemoving = actionLoading === `remove_${member.userId}`

                return (
                  <div
                    key={member.userId}
                    className="flex items-center justify-between p-2.5 rounded-xl bg-slate-800/40 border border-slate-700/50 hover:bg-slate-800/60 transition-colors"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-slate-700/60 border border-slate-600/50 flex items-center justify-center shrink-0">
                        {member.isOwner ? (
                          <Crown className="w-4 h-4 text-amber-400" />
                        ) : member.role === 'admin' ? (
                          <Shield className="w-4 h-4 text-indigo-400" />
                        ) : (
                          <User className="w-4 h-4 text-slate-400" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium text-slate-200 truncate">
                            {member.userId}
                          </span>
                          {isMe && (
                            <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-cyan-500/20 text-cyan-300">
                              You
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-slate-500">
                          {member.leafIndex !== undefined && (
                            <span>Tree Leaf #{member.leafIndex}</span>
                          )}
                          <span>•</span>
                          <span className="capitalize">{member.role || 'Member'}</span>
                        </div>
                      </div>
                    </div>

                    {!isMe && (
                      <button
                        onClick={() => handleRemoveMember(member.userId)}
                        disabled={Boolean(actionLoading)}
                        title="Remove member from MLS group"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors shrink-0 disabled:opacity-50"
                      >
                        {isRemoving ? (
                          <Loader2 className="w-4 h-4 animate-spin text-rose-400" />
                        ) : (
                          <UserMinus className="w-4 h-4" />
                        )}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-900/90 flex items-center justify-between">
          <button
            onClick={handleLeaveGroup}
            disabled={Boolean(actionLoading)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors disabled:opacity-50"
          >
            {actionLoading === 'leave' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <LogOut className="w-3.5 h-3.5" />
            )}
            <span>Leave Group</span>
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
