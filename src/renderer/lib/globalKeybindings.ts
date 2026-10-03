/**
 * The single window-keydown dispatcher for registry commands plus the registry-less gestures
 * Canvas carries (keyed dictation, Cmd+0 / Shift+1 zoom, Cmd+1-9 project jump, Cmd+C copy). One
 * pass, documented order; an unclaimed chord falls through to the focused surface / PTY — never to
 * another command. Pure so node-env tests can drive it without a DOM; Canvas supplies the live
 * accessors and handler closures.
 *
 * Two contracts this module exists to state, both load-bearing:
 *
 * 1. **Gesture order.** Keyed dictation runs BEFORE the registry (a custom keyed chord may
 *    deliberately collide with a registry default and must keep winning — it predates the
 *    registry), and zoom → projectJump → copy run AFTER a registry miss, in that exact order.
 *    This mirrors today's if-chain ORDERING in Canvas, so consolidation changes no ordering
 *    outcome; the typing-guard delta is separate and deliberate (see the registry's
 *    `allowWhileTyping` flags — app-scope rows lack it, so typing now blocks them too).
 *
 * 2. **Claim protocol.** `preventDefault()` is called ONLY when a handler actually claims the key
 *    (returns true). A command that resolved but whose handler declined — or that has no handler
 *    registered at all — falls through to the PLATFORM (the focused surface, the terminal, the
 *    browser/main-process accelerator), and NEVER to a gesture that could reinterpret the same
 *    chord as something else.
 *
 *    The third fall-through path is the one to watch: a chord BLOCKED by the resolver's context
 *    gates (typing, terminal, kanban) returns null exactly like an unbound chord, so the two are
 *    indistinguishable here and BOTH reach the trailing gestures — Cmd+Z while typing misses the
 *    registry and is offered to zoom → projectJump → copy. Those gestures receive the RAW event
 *    with no context, so **each trailing gesture closure owes its own focus/typing guard**; keyed
 *    dictation is the only gesture this module guards.
 *
 * 3. **The terminal-shortcut policy is applied in TWO places, because the gestures bypass the
 *    resolver.** `resolveCommandForKeyEvent` honors `ctx.terminalFirst` for registry commands;
 *    the trailing gestures never go through it, so this module gates them separately. A future
 *    gesture appended to that chain inherits the gate for free — one added ABOVE the registry
 *    (as keyed dictation is) does not, and owes its own.
 */
import {
  resolveCommandForKeyEvent, COMMANDS_BY_ID,
  type CommandId, type KeybindingOverrides
} from '@shared/keybindings'
import { isChatComposerTarget, keyDispatchContextFor, type ContextElement } from './keyContext'

/** Structural key event so node-env tests need no DOM (a real KeyboardEvent satisfies it). */
export interface GlobalKeyEvent {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  key: string
  defaultPrevented: boolean
  preventDefault(): void
}

/** A handler returns true when it CLAIMED the key; false leaves the chord to the platform. */
export type CommandHandlers = Partial<Record<CommandId, () => boolean>>

export interface GlobalKeydownDeps {
  activeElement: () => ContextElement | null
  kanbanOpen: () => boolean
  overrides: () => KeybindingOverrides
  isMac: boolean
  /** The user's `terminalShortcutPolicy`, read live: true = 'terminal-first'. A thunk, not a
   *  value, so a policy change takes effect on the next keystroke without re-registering the
   *  window listener. */
  terminalFirst: () => boolean
  handlers: CommandHandlers
  /** Called when a registry handler CLAIMS a chord that a focused terminal would otherwise
   *  have received — i.e. app-first took it. Terminal-scope claims and terminal-first are not
   *  captures (see the call site). Optional: a caller that shows no notice omits it. */
  onTerminalCapture?: (id: CommandId) => void
  /** Registry-less chords, tried in this exact order (matches today's if-chain order):
   *  keyed dictation BEFORE the registry (a custom keyed chord may collide with a default
   *  and must keep winning), zoom/projectJump/copy AFTER a registry miss. Each returns true
   *  when it claimed the key (and did its own preventDefault where it needs one). */
  gestures: {
    keyedDictation: (e: GlobalKeyEvent) => boolean
    zoom: (e: GlobalKeyEvent) => boolean
    projectJump: (e: GlobalKeyEvent) => boolean
    copy: (e: GlobalKeyEvent) => boolean
  }
}

export function dispatchGlobalKeydown(e: GlobalKeyEvent, deps: GlobalKeydownDeps): boolean {
  // A child handler (find bar, dialogs, terminal) that already claimed the key wins outright.
  if (e.defaultPrevented) return false
  const active = deps.activeElement()
  const ctx = keyDispatchContextFor(active, deps.kanbanOpen(), deps.terminalFirst())
  // Keyed dictation predates the registry and may deliberately collide with a default; it
  // keeps first claim, but only in plain app focus (its old guard blocked inputs AND xterm) —
  // or in the ⌘M chat composer, the one text field dictation fills (the take goes into it).
  const dictationFocus = !ctx.typing || isChatComposerTarget(active)
  if (dictationFocus && !ctx.terminal && !ctx.kanbanOpen && deps.gestures.keyedDictation(e)) return true
  const id = resolveCommandForKeyEvent(e, ctx, deps.overrides(), deps.isMac)
  if (id) {
    const handler = deps.handlers[id]
    if (handler && handler()) {
      e.preventDefault()
      // App-first just took this chord from a focused terminal: the once-per-command notice.
      // The scope check is the load-bearing one — a terminal-scope claim (find, copy) is the
      // terminal's OWN key, not a capture, and gating on the policy alone would report ⌘F as
      // stolen. `!ctx.terminalFirst` is deliberate redundancy: the RESOLVER already refuses
      // every non-terminal-scope command under terminal-first, so no test can distinguish it
      // today (measured — removing it leaves the suite green). It STATES the condition here so
      // the notice stays honest if that resolver rule is ever loosened, the same way the
      // resolver's own isHoldChord skip states a contract it does not currently need.
      if (ctx.terminal && !ctx.terminalFirst && COMMANDS_BY_ID.get(id)?.scope !== 'terminal') {
        deps.onTerminalCapture?.(id)
      }
      return true
    }
    // Resolved but unhandled/declined: fall through to the platform, never to a gesture that
    // could reinterpret the same chord.
    return false
  }
  // terminal-first: the trailing gestures are APP gestures (zoom, project jump, copy) and the
  // resolver never saw them, so the policy has to be applied here too — otherwise Cmd+0 still
  // zooms out from under a user who reserved every chord for the shell. Each gesture keeps its
  // own guards for the app-first case; this is an additional gate, not a replacement.
  if (ctx.terminal && ctx.terminalFirst) return false
  if (deps.gestures.zoom(e)) return true
  if (deps.gestures.projectJump(e)) return true
  if (deps.gestures.copy(e)) return true
  return false
}
