/**
 * Answer export helpers: Markdown, plain text, and the clipboard.
 *
 * `downloadMarkdown` and `safeFilename` went with the two Download buttons (§7.6).
 * Worth recording why, so they are not restored as a missing feature: a
 * script-driven `<a download>` is blocked in many embedded-iframe contexts, and
 * every reader of this app is inside a portal iframe — so those buttons may have been
 * failing silently rather than being unused. Copy is the capability that survives,
 * and it works everywhere.
 */

import type { ChatMessageView } from './client'

/**
 * Markdown for one answer, with its sources listed underneath.
 *
 * Inline citations are already `[Document, Page N]` in the answer text, so the
 * exported copy stays verifiable outside the app.
 */
export function answerToMarkdown(message: ChatMessageView): string {
  const lines = [message.content.trim()]

  if (message.citations.length > 0) {
    lines.push('', '**Sources**', '')
    for (const citation of message.citations) {
      const section = citation.sectionTitle ? ` — ${citation.sectionTitle}` : ''
      lines.push(`- ${citation.documentName}, page ${citation.page}${section}`)
    }
  }
  return lines.join('\n')
}

/** A whole transcript as Markdown, for exporting a session. */
export function transcriptToMarkdown(messages: ChatMessageView[], title: string): string {
  const lines = [`# ${title}`, '']

  for (const message of messages) {
    if (message.role === 'user') {
      lines.push(`## ${message.content.trim()}`, '')
    } else if (message.role === 'assistant') {
      lines.push(answerToMarkdown(message), '')
    }
  }
  return lines.join('\n').trimEnd() + '\n'
}

/** Strip Markdown emphasis for a plain-text copy; citations are kept intact. */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '• ')
    .trim()
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Trigger a client-side download of a Markdown file. */
/** Filesystem-safe slug for a download filename. */