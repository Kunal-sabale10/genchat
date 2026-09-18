export interface ExportableMessage {
  id: string;
  senderId: string;
  senderName: string;
  channelId: string;
  channelName?: string;
  timestamp: string | Date;
  content: string;
  mediaUrl?: string;
  edited?: boolean;
}

export interface ChatExportOptions {
  format: 'json' | 'markdown';
  channelName: string;
  exportedBy: string;
  includeMediaUrls?: boolean;
}

/**
 * Format messages into a structured JSON export artifact conforming to GDPR data portability standards.
 */
export function formatMessagesJSON(
  channelName: string,
  exportedBy: string,
  messages: ExportableMessage[]
): string {
  const exportPayload = {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    exportedBy,
    channelName,
    messageCount: messages.length,
    messages: messages.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      senderName: m.senderName,
      timestamp: typeof m.timestamp === 'string' ? m.timestamp : m.timestamp.toISOString(),
      content: m.content,
      edited: !!m.edited,
      mediaUrl: m.mediaUrl || null,
    })),
  };
  return JSON.stringify(exportPayload, null, 2);
}

/**
 * Format messages into an easily readable, human-facing Markdown conversation transcript.
 */
export function formatMessagesMarkdown(
  channelName: string,
  exportedBy: string,
  messages: ExportableMessage[]
): string {
  const dateStr = new Date().toUTCString();
  let md = `# Chat Export: ${channelName}\n\n`;
  md += `*Exported on ${dateStr} by ${exportedBy}*\n`;
  md += `*Total Messages: ${messages.length}*\n\n`;
  md += `---\n\n`;

  for (const msg of messages) {
    const timeStr = typeof msg.timestamp === 'string' ? msg.timestamp : msg.timestamp.toUTCString();
    const editedTag = msg.edited ? ' *(edited)*' : '';
    md += `### **${msg.senderName}** — \`${timeStr}\`${editedTag}\n`;
    md += `${msg.content}\n`;
    if (msg.mediaUrl) {
      md += `\n📎 Attachment: [${msg.mediaUrl}](${msg.mediaUrl})\n`;
    }
    md += `\n`;
  }

  return md;
}

/**
 * Trigger client-side browser file download of the exported transcript.
 */
export function downloadFile(filename: string, content: string, mimeType: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
