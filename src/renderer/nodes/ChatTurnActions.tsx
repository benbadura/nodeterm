import { useEffect, useState } from 'react'
import { IconCheck, IconCopy } from '../components/icons'
import { chatAbsoluteTime, chatRelativeTime } from '../lib/chatThread'

/**
 * The quiet row under an assistant turn in the ⌘M thread (claude.ai look): Copy + relative time.
 * Hidden until the message is hovered or the row takes keyboard focus, and always shown on the
 * latest turn (CSS: `.term-chat__actions--latest`). No thumbs / read-aloud / retry: none of them has
 * a terminal equivalent.
 */
export function ChatTurnActions({
  copyText,
  at,
  now,
  latest
}: {
  /** The turn's text parts as markdown source; '' = no Copy (a turn of tool calls only). */
  copyText: string
  at?: number
  /** The clock the relative time is read against; ChatPanel ticks it, not each row. */
  now: number
  latest: boolean
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  if (!copyText && at === undefined) return null
  return (
    <div className={`term-chat__actions${latest ? ' term-chat__actions--latest' : ''}`}>
      {copyText && (
        <button
          type="button"
          className="term-chat__action"
          aria-label="Copy message"
          title={copied ? 'Copied' : 'Copy message (markdown)'}
          onClick={() => {
            // The app's own clipboard channel, not `navigator.clipboard`: it never rejects, and the
            // Server Edition bridge falls back to execCommand and raises its own banner on failure.
            window.nodeTerminal.clipboard.writeText(copyText)
            setCopied(true)
          }}
        >
          {copied ? <IconCheck /> : <IconCopy />}
          {copied && <span className="term-chat__action-note">Copied</span>}
        </button>
      )}
      {at !== undefined && (
        <time className="term-chat__time" dateTime={new Date(at).toISOString()} title={chatAbsoluteTime(at)}>
          {chatRelativeTime(at, now)}
        </time>
      )}
    </div>
  )
}
