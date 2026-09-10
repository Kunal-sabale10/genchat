/**
 * LocalIntelligence — Zero-Knowledge On-Device AI Engine
 *
 * Guarantees zero data leakage:
 * - All heuristics, parsing, classification, and summarization run 100% locally
 *   inside the browser runtime on decrypted plaintext.
 * - ZERO decrypted messages or plaintext tokens are ever sent to the server,
 *   third-party LLMs, or telemetry endpoints.
 * - Directly mirrors genchat-crypto/src/intelligence.rs.
 */

export type ActionType = 'todo' | 'meeting' | 'deadline' | 'link' | 'question'

export interface ActionItem {
  actionType: ActionType
  text: string
  context: string
  confidence: number
}

export interface ConversationSummary {
  keyTopics: string[]
  summaryBullets: string[]
  actionItems: ActionItem[]
}

export class LocalIntelligence {
  /**
   * Extract action items, tasks, meetings, deadlines, links, and questions locally
   */
  public static extractActionItems(text: string): ActionItem[] {
    if (!text || typeof text !== 'string') return []

    const items: ActionItem[] = []

    // Split text into meaningful lines/sentences while preserving trailing punctuation
    const lines = text.split('\n')
    const sentences: string[] = []

    for (const line of lines) {
      const trimmedLine = line.trim()
      if (!trimmedLine) continue

      // If line has a URL, keep it intact
      if (trimmedLine.includes('http://') || trimmedLine.includes('https://')) {
        sentences.push(trimmedLine)
        continue
      }

      // Match sentences while retaining trailing punctuation (!, ?, .)
      const matches = trimmedLine.match(/[^.!?;\n]+(?:[.!?;]+|$)/g)
      if (matches && matches.length > 0) {
        for (const m of matches) {
          const s = m.trim()
          if (s.length > 0) sentences.push(s)
        }
      } else {
        sentences.push(trimmedLine)
      }
    }

    for (const sentence of sentences) {
      const lower = sentence.toLowerCase()

      // 1. TODO / Task detection
      if (
        lower.includes('todo:') ||
        lower.startsWith('todo') ||
        lower.startsWith('task:') ||
        lower.startsWith('- [ ]') ||
        lower.startsWith('[ ]') ||
        lower.includes('please make sure to') ||
        lower.includes('need to') ||
        lower.includes('action item:') ||
        lower.includes("don't forget to") ||
        lower.includes('remember to')
      ) {
        items.push({
          actionType: 'todo',
          text: sentence,
          context: sentence,
          confidence: 0.95,
        })
      }

      // 2. Meeting / Call detection
      if (
        lower.includes('meet') ||
        lower.includes('meeting') ||
        lower.includes('sync') ||
        lower.includes('call at') ||
        lower.includes('huddle') ||
        lower.includes('standup') ||
        lower.includes('quick chat')
      ) {
        items.push({
          actionType: 'meeting',
          text: sentence,
          context: sentence,
          confidence: 0.9,
        })
      }

      // 3. Deadline / Due date detection
      if (
        lower.includes('deadline') ||
        lower.includes('due ') ||
        lower.includes('due:') ||
        lower.includes('due by') ||
        lower.includes('before eod') ||
        lower.includes('by tomorrow') ||
        lower.includes('by friday') ||
        lower.includes('by monday') ||
        lower.includes('by end of day') ||
        lower.includes('by eod') ||
        /\bby\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight)\b/i.test(sentence)
      ) {
        items.push({
          actionType: 'deadline',
          text: sentence,
          context: sentence,
          confidence: 0.92,
        })
      }

      // 4. Link detection
      const urlMatch = sentence.match(/https?:\/\/[^\s<>'"]+/g)
      if (urlMatch) {
        for (const url of urlMatch) {
          items.push({
            actionType: 'link',
            text: url,
            context: sentence,
            confidence: 0.99,
          })
        }
      }

      // 5. Question detection
      if (sentence.includes('?') && sentence.length > 5) {
        items.push({
          actionType: 'question',
          text: sentence,
          context: sentence,
          confidence: 0.88,
        })
      }
    }

    // Deduplicate items with identical type and text
    const unique = items.filter(
      (item, idx, arr) =>
        arr.findIndex(o => o.actionType === item.actionType && o.text === item.text) === idx
    )

    return unique
  }

  /**
   * Suggest 3 contextual smart replies based on the last incoming message
   */
  public static suggestSmartReplies(lastMessage: string): string[] {
    if (!lastMessage || typeof lastMessage !== 'string') {
      return ['Sounds good!', 'Got it, thanks!', 'I will check on that.']
    }

    const lower = lastMessage.toLowerCase().trim()

    if (lower.includes('how are you') || lower.includes("how's it going") || lower.includes("what's up")) {
      return [
        "I'm doing well, thanks! How about you?",
        "All good on my end! What's up?",
        'Great! Ready to dive in.',
      ]
    }

    if (lower.includes('thank') || lower.includes('thanks') || lower.includes('appreciate')) {
      return [
        "You're welcome!",
        'No problem at all!',
        'Glad to help!',
      ]
    }

    if (
      lower.includes('can you') ||
      lower.includes('could you') ||
      lower.includes('please') ||
      lower.includes('would you')
    ) {
      return [
        'On it right now!',
        "Sure thing, I'll take care of it.",
        'Will do shortly.',
      ]
    }

    if (
      lower.includes('are you available') ||
      lower.includes('free to talk') ||
      lower.includes('jump on a call') ||
      lower.includes('quick call')
    ) {
      return [
        'Yes, free now!',
        'Give me 5 minutes.',
        'Can we connect in an hour?',
      ]
    }

    if (lower.includes('?')) {
      return [
        'Let me check and get back to you.',
        'Yes, absolutely.',
        'Sounds good to me!',
      ]
    }

    if (lower.includes('done') || lower.includes('finished') || lower.includes('merged')) {
      return [
        'Awesome work!',
        'Looks great, thank you!',
        'Sweet, moving to the next item.',
      ]
    }

    return [
      'Sounds good!',
      'Got it, thanks for the update.',
      'Let me know if you need anything else.',
    ]
  }

  /**
   * Extractive conversation summarizer across local message history
   */
  public static summarizeConversation(
    messages: Array<{ text: string; sender?: string }>
  ): ConversationSummary {
    const keyTopics: string[] = []
    const summaryBullets: string[] = []
    const allActions: ActionItem[] = []

    for (const m of messages) {
      if (!m.text) continue
      const actions = this.extractActionItems(m.text)
      allActions.push(...actions)

      const trimmed = m.text.trim()
      // Filter out low-information messages
      const isShort = trimmed.length < 12
      const isTrivial =
        trimmed.toLowerCase().startsWith('ok') ||
        trimmed.toLowerCase().startsWith('thanks') ||
        trimmed.toLowerCase().startsWith('sounds good')

      if (!isShort && !isTrivial && summaryBullets.length < 8) {
        const prefix = m.sender ? `${m.sender}: ` : ''
        summaryBullets.push(`${prefix}${trimmed}`)
      }
    }

    // Identify topics
    if (allActions.some(a => a.actionType === 'todo' || a.actionType === 'deadline')) {
      keyTopics.push('Action Items & Deadlines')
    }
    if (allActions.some(a => a.actionType === 'meeting')) {
      keyTopics.push('Meetings & Coordination')
    }
    if (allActions.some(a => a.actionType === 'link')) {
      keyTopics.push('Shared Resources & Links')
    }
    if (allActions.some(a => a.actionType === 'question')) {
      keyTopics.push('Q&A & Clarifications')
    }
    if (keyTopics.length === 0) {
      keyTopics.push('General Discussion')
    }

    // Deduplicate action items
    const uniqueActions = allActions.filter(
      (item, idx, arr) =>
        arr.findIndex(o => o.actionType === item.actionType && o.text === item.text) === idx
    )

    return {
      keyTopics,
      summaryBullets,
      actionItems: uniqueActions,
    }
  }

  /**
   * Generates and downloads an iCalendar (.ics) file for meeting invitations
   */
  public static downloadCalendarEvent(title: string, description: string): void {
    const now = new Date()
    const start = new Date(now.getTime() + 60 * 60 * 1000) // 1 hour from now
    const end = new Date(start.getTime() + 30 * 60 * 1000) // 30 min duration

    const formatDate = (d: Date) =>
      d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'

    const icsData = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//GenChat//E2EE Smart Action//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:genchat-${Date.now()}@local`,
      `DTSTAMP:${formatDate(now)}`,
      `DTSTART:${formatDate(start)}`,
      `DTEND:${formatDate(end)}`,
      `SUMMARY:${title.replace(/\n/g, ' ')}`,
      `DESCRIPTION:${description.replace(/\n/g, ' ')} (Created via GenChat On-Device AI)`,
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')

    const blob = new Blob([icsData], { type: 'text/calendar;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `genchat-event-${Date.now()}.ics`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  /**
   * Helper to safely copy text to the clipboard
   */
  public static async copyToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      const success = document.execCommand('copy')
      document.body.removeChild(ta)
      return success
    } catch {
      return false
    }
  }
}
