import React, { useState, useMemo } from 'react'
import { Sparkles, X, CheckSquare, Calendar, Clock, Copy, Check, ShieldCheck, Tag } from 'lucide-react'
import { LocalIntelligence, ConversationSummary } from '../lib/local-intelligence'

interface SummaryModalProps {
  isOpen: boolean
  onClose: () => void
  channelName: string
  messages: Array<{ text: string; sender?: string }>
}

export const SummaryModal: React.FC<SummaryModalProps> = ({
  isOpen,
  onClose,
  channelName,
  messages,
}) => {
  const [copied, setCopied] = useState(false)
  const [completedItems, setCompletedItems] = useState<Record<string, boolean>>({})

  const summary: ConversationSummary = useMemo(() => {
    return LocalIntelligence.summarizeConversation(messages)
  }, [messages])

  if (!isOpen) return null

  const toggleItem = (text: string) => {
    setCompletedItems(prev => ({
      ...prev,
      [text]: !prev[text],
    }))
  }

  const handleCopyMarkdown = async () => {
    let md = `# Conversation Summary: ${channelName}\n\n`
    md += `**Key Topics:** ${summary.keyTopics.join(', ')}\n\n`
    md += `### Highlights\n`
    summary.summaryBullets.forEach(b => {
      md += `- ${b}\n`
    })
    md += `\n### Action Items\n`
    summary.actionItems.forEach(item => {
      const isDone = completedItems[item.text] ? 'x' : ' '
      md += `- [${isDone}] [${item.actionType.toUpperCase()}] ${item.text}\n`
    })
    md += `\n*Generated 100% on-device with zero server data leakage.*`

    const ok = await LocalIntelligence.copyToClipboard(md)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/90">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-purple-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-purple-500/20">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-white text-base">Conversation Summary</h3>
              <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Zero-Knowledge On-Device AI • 0 Server Leakage</span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 text-sm text-slate-300">
          {/* Channel Name Banner */}
          <div className="text-xs font-mono text-slate-400 bg-slate-800/60 px-3 py-1.5 rounded-lg border border-slate-700/50 flex items-center justify-between">
            <span>Channel: <strong className="text-slate-200">{channelName}</strong></span>
            <span>{messages.length} Decrypted Messages Analyzed</span>
          </div>

          {/* Key Topics */}
          {summary.keyTopics.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5" />
                Key Topics
              </h4>
              <div className="flex flex-wrap gap-2">
                {summary.keyTopics.map((topic, i) => (
                  <span
                    key={i}
                    className="px-2.5 py-1 rounded-full text-xs font-medium bg-purple-500/10 text-purple-300 border border-purple-500/20"
                  >
                    {topic}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Key Highlights / Summary Bullets */}
          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Discussion Highlights
            </h4>
            {summary.summaryBullets.length === 0 ? (
              <p className="text-xs text-slate-500 italic">No significant conversation history to summarize yet.</p>
            ) : (
              <ul className="space-y-2">
                {summary.summaryBullets.map((bullet, i) => (
                  <li key={i} className="flex items-start gap-2 text-slate-200">
                    <span className="text-indigo-400 text-base leading-none">•</span>
                    <span className="leading-relaxed">{bullet}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Action Items & Tasks */}
          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center justify-between">
              <span>Action Items & Commitments ({summary.actionItems.length})</span>
            </h4>
            {summary.actionItems.length === 0 ? (
              <p className="text-xs text-slate-500 italic">No tasks, meetings, or deadlines detected in this chat.</p>
            ) : (
              <div className="space-y-2">
                {summary.actionItems.map((item, i) => {
                  const isDone = Boolean(completedItems[item.text])
                  return (
                    <div
                      key={i}
                      onClick={() => toggleItem(item.text)}
                      className={`flex items-start gap-3 p-2.5 rounded-xl border transition-all cursor-pointer ${
                        isDone
                          ? 'bg-emerald-500/5 border-emerald-500/20 text-slate-400'
                          : 'bg-slate-800/40 border-slate-700/60 hover:bg-slate-800/70 text-slate-200'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isDone}
                        onChange={() => {}} // Handled by div click
                        className="mt-1 rounded bg-slate-900 border-slate-600 text-indigo-500 focus:ring-0 cursor-pointer"
                      />
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          {item.actionType === 'todo' && (
                            <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-amber-500/20 text-amber-300">
                              TODO
                            </span>
                          )}
                          {item.actionType === 'meeting' && (
                            <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-indigo-500/20 text-indigo-300">
                              MEETING
                            </span>
                          )}
                          {item.actionType === 'deadline' && (
                            <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-rose-500/20 text-rose-300">
                              DEADLINE
                            </span>
                          )}
                          <span className="text-[10px] text-slate-500 font-mono">
                            {Math.round(item.confidence * 100)}% conf
                          </span>
                        </div>
                        <p className={`text-xs ${isDone ? 'line-through text-slate-400' : 'text-slate-200'}`}>
                          {item.text}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-900/90 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            Encrypted client-side memory
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopyMarkdown}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 hover:text-white transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied to Clipboard!' : 'Copy Summary'}</span>
            </button>
            <button
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
