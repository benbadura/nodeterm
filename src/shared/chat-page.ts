// The paging contract of `chat:read-transcript` (the ⌘M ChatPanel). Shared so the renderer that
// ASKS for a window and the core that SERVES it agree on the same bounds.
//
// Why paging exists: the legacy read always parses the last 5 MB of a transcript, and on an SSH
// project it pulls those 5 MB over ssh — on every panel open AND every turn-end reload. The panel
// only ever shows the newest screenful first, so the first read is now a small window ending at
// the end of the file, and older history is fetched a window at a time as the user scrolls up.

/** Smallest window a caller may ask for. A tinier one would mostly be one partial line. */
export const CHAT_PAGE_MIN_BYTES = 64 * 1024
/** Largest window — the legacy read's cap, so no paged read can cost more than an unpaged one. */
export const CHAT_PAGE_MAX_BYTES = 5 * 1024 * 1024
/** Window size when the caller names none. */
export const CHAT_PAGE_DEFAULT_BYTES = 256 * 1024

/** What the renderer sends: a window of at most `maxBytes` ending at byte offset `before`
 *  (absent = end of file). Pass the previous result's `olderCursor` as `before` to page back. */
export interface ChatTranscriptPageRequest {
  before?: number
  maxBytes?: number
  /** A live refresh the panel issued on its own (a hook event), not an open or a Retry the user
   *  asked for. Readers whose read is expensive (opencode's `export`) may space these out; a
   *  reader that ignores it answers exactly as before. */
  background?: boolean
}

/** A validated page: `before: null` = end of file. */
export interface ChatTranscriptPage {
  before: number | null
  maxBytes: number
  /** Present (and `true`) only for a background live refresh — see the request field. */
  background?: true
}

/**
 * Validate the page argument. It crosses IPC / the WS bridge, so it is untrusted, and `before` in
 * particular ends up on a remote shell command line (`transcriptPageCommand`) — the type is only a
 * compile-time promise.
 *
 * `undefined` / `null` ⇒ `null`: the caller did not ask for paging, and the legacy read runs
 * byte-for-byte. A bad `maxBytes` is harmless and takes the default (it is only a size); a bad
 * `before` THROWS rather than being coerced to "end of file", because silently answering with a
 * different window than the one asked for would splice the wrong history into the panel.
 */
export function normalizeChatPage(page: unknown): ChatTranscriptPage | null {
  if (page === undefined || page === null) return null
  if (typeof page !== 'object') throw new Error('Invalid transcript page')
  const { before, maxBytes } = page as { before?: unknown; maxBytes?: unknown }
  let b: number | null = null
  if (before !== undefined) {
    if (typeof before !== 'number' || !Number.isSafeInteger(before) || before < 0) {
      throw new Error('Invalid transcript page')
    }
    b = before
  }
  let m = CHAT_PAGE_DEFAULT_BYTES
  if (typeof maxBytes === 'number' && Number.isFinite(maxBytes)) {
    m = Math.min(CHAT_PAGE_MAX_BYTES, Math.max(CHAT_PAGE_MIN_BYTES, Math.floor(maxBytes)))
  }
  const { background } = page as { background?: unknown }
  return background === true ? { before: b, maxBytes: m, background: true } : { before: b, maxBytes: m }
}

/**
 * What a grok chat read says when its session id names MORE than one session on an SSH host
 * (`core/remote-grok-chat.ts` refuses to pick one). It travels as a REJECTION's message — the
 * result shape is a locked wire format, and over Electron IPC a rejection keeps only its message
 * (wrapped in Electron's own prefix, the `code` dropped) — so it is matched by substring. Retry can
 * never fix it, which is why it is not `unreadable`.
 */
export const GROK_AMBIGUOUS_SESSION_MESSAGE = 'This session id matches more than one grok session on the host.'

/** Is `e` the rejection carrying `GROK_AMBIGUOUS_SESSION_MESSAGE` (Electron-wrapped or not)? */
export function isGrokAmbiguousSessionError(e: unknown): boolean {
  const m = e && typeof e === 'object' ? (e as { message?: unknown }).message : undefined
  return typeof m === 'string' && m.includes(GROK_AMBIGUOUS_SESSION_MESSAGE)
}
