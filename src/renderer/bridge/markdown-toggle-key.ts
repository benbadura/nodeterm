// The Server Edition's `onMarkdownToggle`: the browser half of the ⌘/Ctrl+M chord.
//
// On the DESKTOP the chord never reaches the page — `main/keydown-intercept.ts` claims it in
// `before-input-event` (it is `{role:'minimize'}`'s accelerator otherwise) and forwards
// `app:toggle-markdown` over IPC, which is what `window.nodeTerminal.onMarkdownToggle` subscribes
// to there. A browser tab has no main process, so the stub used to be `noopUnsub` and the chord did
// nothing at all in the Server Edition (the view was reachable only from the context menu). This is
// the replacement: ONE window `keydown` listener, installed lazily on the first subscription, that
// matches the user's effective `node.toggleMarkdown` bindings, `preventDefault`s a match and fans
// out to every subscriber — the same contract the IPC event has, so TerminalNode / EditorNode /
// Canvas's capture notice (and the kanban card modal) need no browser branch.
//
// **It cannot fire twice on desktop**: it is only reachable through `buildStubApi`, which the
// desktop's own `window.nodeTerminal` (the preload) never uses. The relay tab also builds a stub
// surface but takes `onMarkdownToggle` from the LOCAL preload (`...local`), and the lazy install
// means merely building the stub registers nothing.
//
// Semantics mirror the desktop intercept:
// - **terminal-first** stands it down while a terminal has focus (`policyStandsDown`, the SAME
//   predicate main uses). Focus comes from the DOM exactly as the renderer's dispatcher decides
//   it (`isTerminalTarget` — xterm's helper textarea), not from a mirror: there is nothing to
//   mirror to in a browser, and the live answer is the only honest one.
// - **auto-repeat is swallowed, never re-toggled**: a held chord would otherwise strobe the view.
//   Still `preventDefault`ed so the held key keeps being ours — exactly what `keydownIntercept`
//   does for a repeated toggle-markdown chord on the desktop (the held-⌘0 shape).
// - One addition with no desktop counterpart: an event a child handler already claimed
//   (`defaultPrevented`) is left alone, the same first rule `dispatchGlobalKeydown` applies (main
//   sees the key before any page handler, so it has nothing to defer to).
//
// Bubble phase on purpose, like the window dispatcher: the Settings shortcut recorder's
// `stopPropagation` on an armed capture is what keeps a chord being RECORDED from firing the
// command it is being bound to, and a capture-phase listener would run before it. The price is
// that a surface which consumes the key itself never lets it reach the window: xterm would (it
// writes \r and cancels), which is why `terminalChordBubbles` lets this command bubble out of a
// focused terminal; Monaco binds Ctrl+M to "toggle tab-key focus mode" off-mac and still does
// inside a focused editor. Hover the node with focus elsewhere to toggle an editor from the key.
//
// **macOS Chrome reserves ⌘M for window minimize** — the browser takes it above the page, so the
// default chord only reaches us on Linux/Windows (where it is Ctrl+M) or after a remap in
// Settings → Keyboard Shortcuts. The context menu's "Markdown view" works everywhere.

import { matchesShortcut, type ShortcutKeyEvent } from '../../shared/shortcut'
import { policyStandsDown, type TerminalShortcutPolicy } from '../../shared/keybindings'
import { isTerminalTarget, type ContextElement } from '../lib/keyContext'

/** The keydown fields the decision reads (structural, so node-env tests need no DOM). */
export interface MarkdownToggleKeyEvent extends ShortcutKeyEvent {
  repeat: boolean
  defaultPrevented: boolean
}

/** `toggle` = claim and forward; `swallow` = claim, forward nothing (a held chord); `null` = not
 *  ours — no `preventDefault`, the key goes on to the page. */
export type MarkdownToggleKeyVerdict = 'toggle' | 'swallow' | null

/** PURE. What this keydown means for the markdown toggle. */
export function markdownToggleKeyVerdict(
  e: MarkdownToggleKeyEvent,
  ctx: {
    bindings: readonly string[]
    isMac: boolean
    policy: TerminalShortcutPolicy
    terminalFocused: boolean
  }
): MarkdownToggleKeyVerdict {
  if (e.defaultPrevented) return null
  if (policyStandsDown(ctx.policy, ctx.terminalFocused)) return null
  // `[]` (the user disabled the command) matches nothing, which is the "do not claim" answer.
  if (!ctx.bindings.some((s) => matchesShortcut(e, s, ctx.isMac))) return null
  return e.repeat ? 'swallow' : 'toggle'
}

/** Minimal EventTarget shape (the real `window` in production, a fake in tests). */
export interface KeydownTarget {
  addEventListener(type: 'keydown', listener: (e: KeyboardEvent) => void): void
  removeEventListener(type: 'keydown', listener: (e: KeyboardEvent) => void): void
}

/** Everything is a thunk and read PER KEYSTROKE: a remap or a policy change applies on the next
 *  key without resubscribing, exactly as the window dispatcher reads them. */
export interface MarkdownToggleSourceDeps {
  target: KeydownTarget
  bindings: () => readonly string[]
  isMac: () => boolean
  policy: () => TerminalShortcutPolicy
  activeElement: () => ContextElement | null
}

/** An `onMarkdownToggle`-shaped subscribe function backed by ONE shared window listener, which
 *  exists exactly while at least one subscriber does. */
export function createMarkdownToggleSource(
  deps: MarkdownToggleSourceDeps
): (listener: () => void) => () => void {
  const subscribers = new Set<() => void>()
  const onKeydown = (e: KeyboardEvent): void => {
    const verdict = markdownToggleKeyVerdict(e, {
      bindings: deps.bindings(),
      isMac: deps.isMac(),
      policy: deps.policy(),
      terminalFocused: isTerminalTarget(deps.activeElement())
    })
    if (verdict === null) return
    e.preventDefault()
    if (verdict === 'swallow') return
    // Snapshot: a subscriber that unsubscribes (or mounts another) mid-fan-out must not skip or
    // double-call a sibling.
    for (const fn of [...subscribers]) fn()
  }
  return (listener) => {
    // A wrapper per subscription so the same function subscribed twice is two subscriptions —
    // the IPC-backed desktop version behaves that way too.
    const entry = (): void => listener()
    if (subscribers.size === 0) deps.target.addEventListener('keydown', onKeydown)
    subscribers.add(entry)
    return () => {
      if (!subscribers.delete(entry)) return
      if (subscribers.size === 0) deps.target.removeEventListener('keydown', onKeydown)
    }
  }
}
