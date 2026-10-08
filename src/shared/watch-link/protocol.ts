// What travels inside a live link's E2E tunnel, besides raw pty frames and pty:* events.
// The viewer's namespace is `watch:` on purpose: the OWNER's IPC is `watchLink:`, which the relay
// host refuses from every peer as host-only BEFORE any policy runs (src/shared/host-control.ts).

export const WATCH_PROTOCOL_VERSION = 1
export const WATCH_EVENT_PREFIX = 'watch:'
export const WATCH_EVENT = {
  meta: 'watch:meta',
  keyframe: 'watch:keyframe',
  waiting: 'watch:waiting',
  chat: 'watch:chat',
  end: 'watch:end',
  /** To ONE viewer, never a broadcast: its control state, after an unlock or when control changes
   *  under it (turned off, locked). The initial state rides `watch:meta`. */
  control: 'watch:control',
  /** To every joined viewer: who typed in the last few seconds (`WatchTypingEvent`). */
  typing: 'watch:typing'
} as const
/** A viewer's chat line (Commenter and Control links). */
export const WATCH_CHAT_CAST = 'watch:chat'
/** Control links only: `{ name, password }`. Answered to that viewer alone with `watch:control`. */
export const WATCH_UNLOCK_CAST = 'watch:unlock'
/**
 * Control links only, from a controlling viewer: `{ data }`, at most `INPUT_MAX` UTF-16 units.
 *
 * THE PASTE-FRAMING CONTRACT. Both ends keep it; the host trusts nothing else.
 *  - A controlling viewer forces bracketed paste ON in its OWN emulator (`?2004h`, put back after
 *    any reset the stream applies) and frames EVERY paste it sends as `ESC[200~` … `ESC[201~`. It
 *    never decides from the emulator's mode: what the viewer renders is a tmux CLIENT's output,
 *    whose `?2004h` is constant, so that mode says nothing about the application in the pane.
 *  - Before framing, the page removes both paste markers and every ESC from the paste's content: a
 *    paste is text, and a marker inside it would end the frame early and turn the rest into typed
 *    keys.
 *  - The host splits keys from pastes on those frames alone. Everything outside a frame is KEYS,
 *    typed byte for byte (tmux `send-keys -H`). The content of a frame is a PASTE, delivered with
 *    tmux `paste-buffer -p`, so tmux frames it for the pane only when the pane's application asked
 *    for bracketed paste. Where there is no tmux (the Windows session host, a direct Windows pane, a
 *    plain shell) the backend's own path decides the same way, or sends it unframed.
 *  - An emulator's answer to a query in the stream (DA, CPR, an OSC colour) travels ALONE, as its
 *    own cast, never merged with typed input: the host drops a cast that is entirely a terminal
 *    report, and only a whole one.
 *  - Input from a connection that stopped controlling within the last 5 s (it released, or the
 *    owner turned typing off or changed the password, or the link locked) is dropped silently:
 *    keystrokes in flight when control ended are not a breach. After that, or from a connection that
 *    never controlled, input is a policy breach and the host closes the connection.
 */
export const WATCH_INPUT_CAST = 'watch:input'
/** Control links only: drop the sender back to watching. No arguments. */
export const WATCH_RELEASE_CAST = 'watch:release'

/** A Control link (`controller`) is a Commenter link plus typing for whoever unlocks it with the
 *  link's password. Every addition to this protocol is additive, so `WATCH_PROTOCOL_VERSION` stays 1:
 *  an older viewer page ignores the new events and simply cannot take control. */
export type WatchLinkRole = 'viewer' | 'commenter' | 'controller'
/** `attempts`: too many wrong passwords on this connection (it may reconnect through the link). */
export const WATCH_END_REASONS = ['revoked', 'expired', 'node-gone', 'session-ended', 'host-stopping', 'kicked', 'attempts'] as const
export type WatchLinkEndReason = (typeof WATCH_END_REASONS)[number]
export function isWatchEndReason(x: unknown): x is WatchLinkEndReason {
  return typeof x === 'string' && (WATCH_END_REASONS as readonly string[]).includes(x)
}

export interface WatchMeta {
  v: number
  role: WatchLinkRole
  /** Sharer-supplied; render as text, marked as set by the sharer. */
  label: string
  title: string
  /** Epoch ms on the host's clock, corrected to the server's; `null` for a link with no end time. */
  expiresAt: number | null
  cols: number
  rows: number
  /** A Control link's state for THIS viewer at join; absent on every other role. */
  control?: WatchControlEvent
}

/** `controlling`: this viewer may type. `available`: a Control link this viewer may unlock.
 *  `off`: the owner turned typing off. `locked`: too many wrong passwords across the link. */
export type WatchControlState = 'controlling' | 'available' | 'off' | 'locked'
/** Why an unlock was refused or control was taken away: `wrong` password, the link is `locked`,
 *  typing is `off`, an attempt `too-soon` after the last, the terminal is `unsupported`, or some input
 *  was `dropped` — over the rate limit, with no session to type into, or a delivery to the pane that
 *  failed. The host does not say which, so a viewer must not name a cause. */
export type WatchControlReason = 'wrong' | 'locked' | 'off' | 'too-soon' | 'unsupported' | 'dropped'
const CONTROL_STATES: readonly WatchControlState[] = ['controlling', 'available', 'off', 'locked']
const CONTROL_REASONS: readonly WatchControlReason[] = ['wrong', 'locked', 'off', 'too-soon', 'unsupported', 'dropped']
export interface WatchControlEvent {
  state: WatchControlState
  reason?: WatchControlReason
}
export interface WatchTypingEvent {
  /** Self-chosen names: claims, shown as such. */
  names: string[]
}

/** The largest `watch:input` cast, in UTF-16 units. */
export const INPUT_MAX = 16384
/** The longest password the unlock cast carries, in code points. */
export const PASSWORD_MAX = 128
/** The most names one `watch:typing` event carries. */
export const TYPING_NAMES_MAX = 10

/** A `watch:control` payload (or `WatchMeta.control`), or null when it is not one. An unknown reason
 *  is dropped, never the state with it. */
export function readControlEvent(x: unknown): WatchControlEvent | null {
  if (!x || typeof x !== 'object') return null
  const { state, reason } = x as Record<string, unknown>
  if (!(CONTROL_STATES as readonly unknown[]).includes(state)) return null
  const out: WatchControlEvent = { state: state as WatchControlState }
  if ((CONTROL_REASONS as readonly unknown[]).includes(reason)) out.reason = reason as WatchControlReason
  return out
}
/** A `watch:typing` payload's names: each one a clean chat name, deduplicated in order, at most
 *  `TYPING_NAMES_MAX`. Anything else reads as nobody typing. */
export function readTypingNames(x: unknown): string[] {
  if (!x || typeof x !== 'object') return []
  const names = (x as Record<string, unknown>).names
  if (!Array.isArray(names)) return []
  const out: string[] = []
  for (const raw of names) {
    if (out.length >= TYPING_NAMES_MAX) break
    const name = sanitizeChatName(raw)
    if (name !== null && !out.includes(name)) out.push(name)
  }
  return out
}
export interface WatchKeyframe {
  sessionId: string
  /** The visible screen with SGR, or '' when the backend has no visible-only capture. */
  screen: string
  /** tmux paints its client on the alternate screen; the viewer must switch to it BEFORE painting,
   *  or every tmux redraw scrolls into the viewer's history (CLAUDE.md, co-attach seeding). */
  altScreen: boolean
  /** The host's cursor when the screen was captured, 0-based (tmux `cursor_x` / `cursor_y`). tmux's
   *  following stream moves the cursor RELATIVE to where it believes the tty cursor is, and a capture
   *  trims trailing blanks, so without this every keyframe offsets what is typed next. Absent when
   *  the host could not read it; the viewer then leaves the cursor where the screen text ends. */
  cursor?: { x: number; y: number }
}
export interface WatchChatMessage {
  id: string
  name: string
  text: string
  at: number
  from: 'viewer' | 'sharer'
}

/** Chat caps, in UTF-16 units (what an input's `maxLength` counts), never cutting a code point. */
export const CHAT_TEXT_MAX = 500
export const CHAT_NAME_MAX = 32
// C0 and C1 controls, DEL, and the ESC that starts every sequence. A newline becomes a space: chat
// is one line, and a pasted multi-line block must not reflow the owner's popover.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g
// The directional formatting characters: ALM (U+061C), LRM/RLM (U+200E/F), the embeddings and
// overrides (U+202A–E) and the isolates (U+2066–9). Chat is text one stranger wrote for the owner and
// every other viewer to read; an RLO reorders everything drawn after it. Escaped, never literal (a
// literal one is invisible in review). The same set as @shared/presence's BIDI_CONTROL_CHARS — this
// directory imports nothing from outside itself (it is vendored byte for byte into nodeterm-web), so
// the class is restated here and src/core/watch-link/wire.test.ts pins the two equal.
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
/** How much of a raw value the cleaning chain may look at, as a multiple of the cap: a cast is
 *  attacker-sized, and the regex chain must not run over megabytes to keep 500 units of it. Generous
 *  enough that whitespace and controls collapsing away never empty an honest message. */
const RAW_FACTOR = 4

/** At most `max` UTF-16 units, cut BETWEEN code points: a plain `slice` can split a surrogate pair
 *  and leave a lone surrogate, which renders as a replacement glyph. Stops reading at the cap. */
function capUnits(s: string, max: number): string {
  if (s.length <= max) return s
  let out = ''
  for (const ch of s) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out
}

function clean(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  // Bound the input BEFORE the regex chain (by code point), then cap the cleaned text the same way.
  const bounded = capUnits(raw, max * RAW_FACTOR)
  const cleaned = bounded
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CONTROLS, '')
    .replace(BIDI_CONTROLS, '')
    .replace(/\s+/g, ' ')
    .trim()
  const s = capUnits(cleaned, max).trim()
  return s ? s : null
}
export const sanitizeChatText = (raw: unknown): string | null => clean(raw, CHAT_TEXT_MAX)
export const sanitizeChatName = (raw: unknown): string | null => clean(raw, CHAT_NAME_MAX)
