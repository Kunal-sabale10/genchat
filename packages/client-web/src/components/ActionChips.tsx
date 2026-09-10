import React, { useState } from 'react'
import { CheckSquare, Calendar, Clock, ExternalLink, HelpCircle, Check, Copy } from 'lucide-react'
import { ActionItem, LocalIntelligence } from '../lib/local-intelligence'

interface ActionChipsProps {
  text: string
  className?: string
}

export const ActionChips: React.FC<ActionChipsProps> = ({ text, className = '' }) => {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const items = React.useMemo(() => LocalIntelligence.extractActionItems(text), [text])

  if (!items || items.length === 0) {
    return null
  }

  const handleActionClick = async (item: ActionItem, index: number) => {
    if (item.actionType === 'link') {
      window.open(item.text, '_blank', 'noopener,noreferrer')
      return
    }

    if (item.actionType === 'meeting') {
      LocalIntelligence.downloadCalendarEvent('Meeting from GenChat', item.text)
      setCopiedIndex(index)
      setTimeout(() => setCopiedIndex(null), 2000)
      return
    }

    if (item.actionType === 'todo' || item.actionType === 'deadline' || item.actionType === 'question') {
      const success = await LocalIntelligence.copyToClipboard(item.text)
      if (success) {
        setCopiedIndex(index)
        setTimeout(() => setCopiedIndex(null), 2000)
      }
    }
  }

  return (
    <div className={`flex flex-wrap gap-1.5 mt-2 pt-1.5 border-t border-slate-700/40 ${className}`}>
      {items.map((item, idx) => {
        const isCopied = copiedIndex === idx

        switch (item.actionType) {
          case 'todo':
            return (
              <button
                key={idx}
                onClick={() => handleActionClick(item, idx)}
                title="Click to copy task to clipboard"
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 transition-colors"
              >
                {isCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <CheckSquare className="w-3 h-3" />}
                <span>{isCopied ? 'Task Copied!' : 'Task'}</span>
              </button>
            )

          case 'meeting':
            return (
              <button
                key={idx}
                onClick={() => handleActionClick(item, idx)}
                title="Click to download .ics calendar invite"
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-500/10 text-indigo-300 border border-indigo-500/30 hover:bg-indigo-500/20 transition-colors"
              >
                {isCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <Calendar className="w-3 h-3" />}
                <span>{isCopied ? 'Calendar Event Created!' : 'Add to Calendar'}</span>
              </button>
            )

          case 'deadline':
            return (
              <button
                key={idx}
                onClick={() => handleActionClick(item, idx)}
                title="Click to copy deadline"
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-rose-500/10 text-rose-300 border border-rose-500/30 hover:bg-rose-500/20 transition-colors"
              >
                {isCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <Clock className="w-3 h-3" />}
                <span>{isCopied ? 'Deadline Copied!' : 'Deadline'}</span>
              </button>
            )

          case 'link':
            return (
              <button
                key={idx}
                onClick={() => handleActionClick(item, idx)}
                title="Open link in new tab"
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-sky-500/10 text-sky-300 border border-sky-500/30 hover:bg-sky-500/20 transition-colors max-w-[200px] truncate"
              >
                <ExternalLink className="w-3 h-3 shrink-0" />
                <span className="truncate">{item.text.replace(/^https?:\/\//, '')}</span>
              </button>
            )

          case 'question':
            return (
              <button
                key={idx}
                onClick={() => handleActionClick(item, idx)}
                title="Click to copy question"
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-500/10 text-purple-300 border border-purple-500/30 hover:bg-purple-500/20 transition-colors"
              >
                {isCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <HelpCircle className="w-3 h-3" />}
                <span>{isCopied ? 'Copied!' : 'Question'}</span>
              </button>
            )

          default:
            return null
        }
      })}
    </div>
  )
}
