/**
 * The renderer's single read path for shortcut overrides: sanitize once per settings change
 * (memoized by the raw object's reference — `useSettings.update` replaces the settings object
 * but keeps untouched sub-objects), warn once, and serve effective bindings + display strings
 * from it. Everything that shows or matches a registry chord goes through here so dispatch,
 * ShortcutsPanel, and tooltips cannot disagree.
 */
import {
  getEffectiveBindings, sanitizeKeybindingOverrides, normalizeTerminalShortcutPolicy,
  resolveCommandForKeyEvent, COMMANDS_BY_ID, MAIN_INTERCEPTED_COMMAND_IDS,
  type CommandId, type KeybindingOverrides, type TerminalShortcutPolicy
} from '@shared/keybindings'
import type { ShortcutKeyEvent } from '@shared/shortcut'
import { shortcutKeyParts } from '@shared/shortcut'
import { isMacPlatform } from '@shared/platform-utils'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from '../state/settings'

const UNSET = Symbol('unset')
let lastRaw: unknown = UNSET
let lastSanitized: KeybindingOverrides = {}

export function activeKeybindingOverrides(): KeybindingOverrides {
  const raw = useSettings.getState().settings.keybindings
  if (raw === lastRaw) return lastSanitized
  const { overrides, warnings } = sanitizeKeybindingOverrides(raw, isMacPlatform())
  if (warnings.length) console.warn(`[keybindings] ${warnings.join(' ')}`)
  lastRaw = raw
  lastSanitized = overrides
  return overrides
}

export function effectiveBindings(id: CommandId): readonly string[] {
  return getEffectiveBindings(id, activeKeybindingOverrides(), isMacPlatform())
}

/** Display parts of the command's first effective binding; [] when unbound. */
export function commandKeys(id: CommandId, isMac: boolean = isMacPlatform()): string[] {
  const first = getEffectiveBindings(id, activeKeybindingOverrides(), isMac)[0]
  return first ? shortcutKeyParts(first, isMac) : []
}

/** `('Sessions', 'panel.sessions')` -> `'Sessions (⌘⇧L)'` (mac) / `'Sessions (Ctrl+Shift+L)'`
 *  — the same strings hintLabel produced for the defaults, but following remaps; bare text
 *  when unbound. */
export function commandTooltip(text: string, id: CommandId, isMac: boolean = isMacPlatform()): string {
  const parts = commandKeys(id, isMac)
  if (!parts.length) return text
  return `${text} (${isMac ? parts.join('') : parts.join('+')})`
}

/** The bare chord, as a chip: `'⌘K'` (mac) / `'Ctrl+K'`. **`''` when unbound** — every caller
 *  embeds this in a sentence (`⌘M to exit`, `Message (⌘Enter to commit)`), so they must test it
 *  and fall back to chord-less copy rather than rendering a stray fragment. */
export function chipFor(id: CommandId, isMac: boolean = isMacPlatform()): string {
  const parts = commandKeys(id, isMac)
  return isMac ? parts.join('') : parts.join('+')
}

/** The single WRITE path for overrides. `null` = reset (delete the key, defaults return);
 *  `[]` = disabled. Values are stored as given — callers pass canonical strings from
 *  `normalizeBindingForCommand`; the read path's sanitizer remains the safety net for
 *  hand-edited files. `speech.dictation` also mirrors its first binding into the legacy
 *  `speech.shortcut` field for one release, so a downgraded build keeps the user's chord.
 *  On DISABLE (`[]`) `bindings?.[0]` is `undefined`, so the mirror falls back to the DEFAULT
 *  chord rather than an empty string: a downgraded build then gets default dictation instead
 *  of a broken value it cannot parse.
 *
 *  **Raw in, sanitized out — the two maps are not the same map.** This writes into the RAW
 *  `settings.keybindings` object, while every UI gate (the chips, Disable/Reset visibility,
 *  `commitCandidate`'s conflict check) reads the SANITIZED one. So a hand-edited entry the
 *  sanitizer drops — an unknown id, an invalid chord, a conflict participant — is invisible to
 *  the gate yet still sitting on disk, and it stays there until a UI write for that command, or
 *  a Reset, replaces the map. */
export function setKeybindingOverride(id: CommandId, bindings: readonly string[] | null): void {
  const state = useSettings.getState()
  const next: KeybindingOverrides = { ...(state.settings.keybindings ?? {}) }
  if (bindings === null) delete next[id]
  else next[id] = [...bindings]
  if (id === 'speech.dictation') {
    const mirror = bindings?.[0] ?? DEFAULT_SETTINGS.speech.shortcut
    state.update({
      keybindings: next,
      speech: { ...state.settings.speech, shortcut: mirror }
    })
    return
  }
  state.update({ keybindings: next })
}

/** Display parts for EVERY effective binding (the panel shows the first; the Settings section
 *  shows them all). [] when unbound/disabled. */
export function commandKeysFor(id: CommandId, isMac: boolean = isMacPlatform()): string[][] {
  return getEffectiveBindings(id, activeKeybindingOverrides(), isMac).map((b) =>
    shortcutKeyParts(b, isMac)
  )
}

/** The dictation chord's single source: the first effective `speech.dictation` binding.
 *  `''` = the user disabled it (dictation shortcut off; the mic button still works). */
export function dictationBinding(): string {
  return effectiveBindings('speech.dictation')[0] ?? ''
}

/** Who wins while an xterm has focus. Read through the normalizer, NOT as the raw field: the
 *  setting is hand-editable JSON, so its compile-time type is not a runtime guarantee, and an
 *  unknown value must degrade to `app-first` (today's behavior) rather than reach dispatch. */
export function terminalShortcutPolicy(): TerminalShortcutPolicy {
  return normalizeTerminalShortcutPolicy(useSettings.getState().settings.terminalShortcutPolicy)
}

/** Should this keydown, seen INSIDE a focused terminal, bypass xterm and bubble to the window
 *  dispatcher? True only when the live registry resolves it to an app/canvas command that is
 *  allowed in terminals. This is the caller-side matcher for `terminalKeyAction`'s `registryOwns`
 *  (the one-matcher discipline `ownsProjectJump` set): xterm's own keymap CONSUMES some chords —
 *  modified arrows become `CSI 1;N x` and the event is cancelled — so without this, a registry
 *  chord like Ctrl+Shift+Arrow never reaches the dispatcher from the one place it targets.
 *  Everything the resolver already encodes applies for free: under terminal-first the resolver
 *  refuses non-terminal-scope commands (the chord stays with the shell), an unbound/remapped
 *  chord follows the live overrides, and `kanbanOpen` refuses canvas-scope commands so a modal
 *  terminal over the board keeps its bytes. Terminal-SCOPE commands are excluded — their local
 *  listeners own them and this helper must not reroute their chords. Main-intercepted commands
 *  are excluded too: the window dispatcher deliberately has no handlers for them. If the main
 *  process stands down (notably Ctrl+W in a focused Linux/Windows terminal), xterm must retain the
 *  chord so the control byte reaches the pty.
 *
 *  **Except `node.toggleMarkdown`, which bubbles.** Its Server Edition owner is a WINDOW keydown
 *  listener (`bridge/markdown-toggle-key.ts` — a browser has no main process to intercept it), and
 *  xterm would turn Ctrl+M into a \r write and cancel the event, leaving ⌘M dead in exactly the
 *  terminal the user is looking at. On desktop this changes nothing: under app-first main claims
 *  the chord above the page so this never runs for it, under terminal-first the resolver above
 *  already refuses it (`null` — the byte stays with the shell), and the one other main stand-down
 *  (an armed shortcut recorder) has the recorder, not a terminal, focused. Unlike Ctrl+W there is
 *  no terminal-focus stand-down in main for it, so there is no desktop case where xterm must keep
 *  it. */
export function terminalChordBubbles(e: ShortcutKeyEvent, kanbanOpen: boolean): boolean {
  const id = resolveCommandForKeyEvent(
    e,
    {
      typing: false,
      terminal: true,
      terminalFirst: terminalShortcutPolicy() === 'terminal-first',
      kanbanOpen
    },
    activeKeybindingOverrides(),
    isMacPlatform()
  )
  if (id === null) return false
  if (id !== 'node.toggleMarkdown' && MAIN_INTERCEPTED_COMMAND_IDS.includes(id)) return false
  return COMMANDS_BY_ID.get(id)?.scope !== 'terminal'
}

/** Once per command, ever (persisted in settings so Server Edition shares it): record that
 *  app-first captured this command's chord from a focused terminal, and tell the banner.
 *  Silent under terminal-first — nothing is being taken from the terminal there.
 *
 *  `seenShortcutCaptureNotices` is hand-editable too, so its SHAPE is guarded before use: a
 *  string would make `.includes` answer true for any substring (swallowing the first notice),
 *  and a number/object would throw inside a keydown handler. Anything that is not an array of
 *  strings is treated as empty and REPLACED by a clean array on the next write.
 *
 *  The event is window-guarded because this module is imported by node-environment unit
 *  tests (the same guard `state/settings.ts` carries for its save timer); the settings write
 *  is the durable half and happens either way. */
export function noteTerminalCapture(id: CommandId): void {
  if (terminalShortcutPolicy() !== 'app-first') return
  const state = useSettings.getState()
  const raw = state.settings.seenShortcutCaptureNotices
  const seen = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  if (seen.includes(id)) return
  state.update({ seenShortcutCaptureNotices: [...seen, id] })
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('nodeterm:shortcut-captured', { detail: { commandId: id } }))
  }
}
