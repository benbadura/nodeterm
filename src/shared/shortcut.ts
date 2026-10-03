/**
 * Pure keyboard-shortcut parse/match/format helpers, shared by the Canvas listener, the
 * Settings → Speech capture field, the Dock mic tooltip, and ShortcutsPanel.
 *
 * Canonical string shape: modifier tokens joined by "+", optionally ending in one non-modifier
 * key token, e.g. `"Cmd+Shift+D"`, `"Cmd+F5"`, or (v3) a MODIFIER-ONLY chord with no trailing key,
 * e.g. `"Cmd+Alt"`. `Cmd` is a PLATFORM-ABSTRACTED primary modifier — it means "the primary
 * modifier for this platform": metaKey (⌘) on mac, ctrlKey elsewhere. Storing shortcuts in terms
 * of the abstract "Cmd" is what lets one stored string match on every platform via
 * `matchesShortcut(e, s, isMac)`. `Ctrl` is a SEPARATE, LITERAL token meaning ctrlKey on every
 * platform (⌃ on mac) — on non-mac it happens to resolve to the same physical key as `Cmd`, so a
 * `Ctrl+X` string still behaves exactly like `Cmd+X` there.
 *
 * Modifier matching is EXACT on all four flags: a chord matches only when the event's meta/ctrl/
 * alt/shift state is precisely what the chord resolves to, so an extra modifier held on top never
 * fires a shorter binding.
 *
 * A modifier-only chord (`key === null`, see `isHoldChord`) means hold-to-talk: the chord is held
 * down to record and released to stop, instead of toggling on a keyed press. `chordHeld` (not
 * `matchesShortcut`, which requires a trailing key) is what the Canvas hold-mode listener uses to
 * test the held modifier state.
 */

export interface ParsedShortcut {
  /** Primary modifier required: metaKey on mac, ctrlKey elsewhere. */
  cmd: boolean
  /** LITERAL Control required (⌃ on mac). On non-mac `Cmd` already resolves to Control, so a
   *  chord never needs both; validation of both-at-once lives in keybindings.ts. */
  ctrl: boolean
  shift: boolean
  alt: boolean
  /** Uppercased single char (e.g. "D") or named key (e.g. "F5", "SPACE", "ESCAPE"). `null` means
   *  a modifier-only (hold-to-talk) chord — see `isHoldChord`. */
  key: string | null
}

/** Friendly display labels for named (non single-char) keys. Falls back to title-case. */
const KEY_LABELS: Record<string, string> = {
  SPACE: 'Space',
  ENTER: 'Enter',
  RETURN: 'Enter',
  TAB: 'Tab',
  ESCAPE: 'Esc',
  ESC: 'Esc',
  BACKSPACE: 'Backspace',
  DELETE: 'Delete',
  ARROWUP: '↑',
  ARROWDOWN: '↓',
  ARROWLEFT: '←',
  ARROWRIGHT: '→'
}

/** Named tokens for keys whose `e.key` is punctuation, so canonical strings stay readable. */
const KEY_ALIASES: Record<string, string> = { COMMA: ',', SLASH: '/', PERIOD: '.' }

/** Modifier-only `e.key` values — never a valid trailing key on their own. */
const MODIFIER_KEYS = new Set(['META', 'CONTROL', 'CTRL', 'SHIFT', 'ALT', 'ALTGRAPH', 'OS'])

/** `"d"` / `"D"` / `"Escape"` / `"F5"` -> the uppercased canonical key token; a punctuation alias
 *  (`"Comma"`) -> the character `e.key` actually reports (`","`); the space bar (`" "`) -> `SPACE`. */
function normalizeKey(key: string): string {
  // The DOM reports the space bar as a literal ' '; the canonical token is `SPACE` (a `Space`
  // binding could never match otherwise, and a captured space serialized as a trailing blank).
  if (key === ' ') return 'SPACE'
  const upper = key.toUpperCase()
  return KEY_ALIASES[upper] ?? upper
}

/** True when `key` (a raw `e.key`, any case) names a modifier key itself rather than a
 *  printable/named key — e.g. `"Meta"`, `"Alt"`, `"Shift"`. Exported so the Settings capture
 *  field and the Canvas hold-mode listener can classify a keydown/keyup the same way
 *  `captureToShortcut` does internally. */
export function isModifierEventKey(key: string): boolean {
  return MODIFIER_KEYS.has(normalizeKey(key))
}

// Memo: dispatch re-parses every candidate binding on every keydown once the registry sits on
// a window listener; distinct binding strings are few, so a small frozen-value cache removes
// the hot-path cost for every consumer at once. The returned object's IDENTITY is stable only
// until the size-cap clear below — never key a Map/WeakMap or a React dep array off a
// `ParsedShortcut`; compare its fields, or the string it came from.
const parseCache = new Map<string, ParsedShortcut>()

/** Parse a canonical combo string, e.g. `"Cmd+Shift+D"` -> `{cmd:true, ctrl:false, shift:true,
 *  alt:false, key:'D'}`; a modifier-only chord, e.g. `"Cmd+Alt"` -> `{cmd:true, ctrl:false,
 *  shift:false, alt:true, key:null}` (see `isHoldChord`). `Ctrl`/`Control` set the LITERAL `ctrl`
 *  field — they are no longer a spelling of the abstract `Cmd`. */
export function parseShortcut(s: string): ParsedShortcut {
  const hit = parseCache.get(s)
  if (hit) return hit
  const parts = s
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)

  let cmd = false
  let ctrl = false
  let shift = false
  let alt = false
  let key: string | null = null
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'cmd' || lower === 'command') {
      cmd = true
    } else if (lower === 'ctrl' || lower === 'control') {
      ctrl = true
    } else if (lower === 'shift') {
      shift = true
    } else if (lower === 'alt' || lower === 'option') {
      alt = true
    } else {
      key = normalizeKey(part)
    }
  }
  const parsed = Object.freeze({ cmd, ctrl, shift, alt, key })
  if (parseCache.size > 512) parseCache.clear() // hand-edited garbage churn guard
  parseCache.set(s, parsed)
  return parsed
}

/** Canonical spellings for the key tokens that are not a single character. Serializing through
 *  this (rather than emitting the uppercased token) is what makes `serializeShortcut` the exact
 *  inverse of `parseShortcut`: `"Ctrl+Insert"` round-trips instead of becoming `"Ctrl+INSERT"`.
 *  Single letters, digits and F-keys are already canonical and pass through.
 *  The ALIAS spellings `KEY_LABELS` also accepts (`ESC`, `RETURN`) map onto the canonical token,
 *  so `"Cmd+Esc"` and `"Cmd+Escape"` serialize identically — without that, two spellings of one
 *  chord would carry two conflict identities. Serializer-only: neither alias is ever produced by
 *  `normalizeKey` from a real `e.key` (the DOM reports `"Escape"` / `"Enter"`). */
const CANONICAL_KEY_NAMES: Record<string, string> = {
  ENTER: 'Enter',
  DELETE: 'Delete',
  BACKSPACE: 'Backspace',
  INSERT: 'Insert',
  ESCAPE: 'Escape',
  ESC: 'Escape',
  RETURN: 'Enter',
  TAB: 'Tab',
  SPACE: 'Space',
  ARROWUP: 'ArrowUp',
  ARROWDOWN: 'ArrowDown',
  ARROWLEFT: 'ArrowLeft',
  ARROWRIGHT: 'ArrowRight',
  PAGEUP: 'PageUp',
  PAGEDOWN: 'PageDown',
  ',': 'Comma',
  '/': 'Slash',
  '.': 'Period'
}

function keyTokenForSerialize(key: string): string {
  return CANONICAL_KEY_NAMES[key] ?? key
}

/** Canonical string for a parsed chord: `Cmd`,`Ctrl`,`Alt`,`Shift`, then the key token
 *  (punctuation keys serialize back to their named alias). Two spellings of the same chord
 *  always serialize identically — keybindings.ts keys its conflict identities off this. */
export function serializeShortcut(p: ParsedShortcut): string {
  const parts: string[] = []
  if (p.cmd) parts.push('Cmd')
  if (p.ctrl) parts.push('Ctrl')
  if (p.alt) parts.push('Alt')
  if (p.shift) parts.push('Shift')
  if (p.key !== null) parts.push(keyTokenForSerialize(p.key))
  return parts.join('+')
}

/** True when `s` is a modifier-only chord (no trailing key) — the v3 hold-to-talk shape. A
 *  keyed combo (`"Cmd+Alt+D"`) keeps the existing press-to-talk toggle behavior; the mode is
 *  derived from the stored string, not a separate setting. */
export function isHoldChord(s: string): boolean {
  return parseShortcut(s).key === null
}

/** `"D"` -> `"D"`, `"SPACE"` -> `"Space"`, `"F5"` -> `"F5"`, unknown multi-char -> title case. */
function keyLabel(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key]
  if (key.length <= 1) return key
  if (/^F\d{1,2}$/.test(key)) return key
  return key.charAt(0) + key.slice(1).toLowerCase()
}

/** `"Cmd+Shift+D"` + mac -> `["⌘", "⇧", "D"]`; + non-mac -> `["Ctrl", "Shift", "D"]`; a
 *  modifier-only chord (`"Cmd+Alt"`) -> `["⌘", "⌥"]` (no trailing key badge). One badge per
 *  element — used by ShortcutsPanel's `<kbd>` row rendering. The non-mac `cmd || ctrl` collapse
 *  is safe because keybindings.ts validation forbids both in one chord. */
export function shortcutKeyParts(s: string, isMac: boolean): string[] {
  const { cmd, ctrl, shift, alt, key } = parseShortcut(s)
  const parts: string[] = []
  if (isMac) {
    if (cmd) parts.push('⌘')
    if (ctrl) parts.push('⌃')
    if (alt) parts.push('⌥')
    if (shift) parts.push('⇧')
  } else {
    if (cmd || ctrl) parts.push('Ctrl')
    if (alt) parts.push('Alt')
    if (shift) parts.push('Shift')
  }
  if (key !== null) parts.push(keyLabel(key))
  return parts
}

/** `"Cmd+Shift+D"` + mac -> `"⌘⇧D"`; + non-mac -> `"Ctrl+Shift+D"`; a modifier-only chord
 *  (`"Cmd+Alt"`) -> `"⌘⌥"` / `"Ctrl+Alt"`. */
export function formatShortcut(s: string, isMac: boolean): string {
  const parts = shortcutKeyParts(s, isMac)
  return isMac ? parts.join('') : parts.join('+')
}

/** Minimal shape of a KeyboardEvent this module needs — kept structural so callers don't have
 *  to import `KeyboardEvent` (and so it's trivially fakeable in tests). */
export interface ShortcutKeyEvent {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  key: string
}

/** The concrete modifier flags a chord requires on `isMac`. `Cmd` resolves to meta on mac and
 *  ctrl elsewhere; the literal `ctrl` field always demands ctrlKey. */
export function resolvedModifiers(
  p: ParsedShortcut,
  isMac: boolean
): { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean } {
  return {
    meta: isMac && p.cmd,
    ctrl: p.ctrl || (!isMac && p.cmd),
    alt: p.alt,
    shift: p.shift
  }
}

/** Does `e` match the canonical combo `s`? `cmd` in `s` means metaKey on mac, ctrlKey elsewhere;
 *  `ctrl` always means ctrlKey. All four modifier flags must match EXACTLY, so a chord never
 *  fires with an extra modifier held on top of it (a Control held over `Cmd+K` on mac is a
 *  different chord, not a sloppier one). For a keyed combo only — a modifier-only chord
 *  (`isHoldChord(s)`) never matches here (its `key` is `null`, which no `e.key` ever equals); the
 *  Canvas hold-mode listener uses `chordHeld` instead. */
export function matchesShortcut(e: ShortcutKeyEvent, s: string, isMac: boolean): boolean {
  const parsed = parseShortcut(s)
  const need = resolvedModifiers(parsed, isMac)
  if (e.metaKey !== need.meta || e.ctrlKey !== need.ctrl) return false
  if (e.shiftKey !== need.shift || e.altKey !== need.alt) return false
  return parsed.key !== null && normalizeKey(e.key) === parsed.key
}

/** True when `e`'s currently-held modifiers EXACTLY cover `s`'s modifiers (no key check, and no
 *  extra modifier beyond what `s` requires). Used by the Canvas hold-mode listener for a
 *  modifier-only chord: "is the chord fully down" (arm, on keydown) and "did one of the chord's
 *  own modifiers just come up" (release, on keyup — the keyup event's own modifier flags already
 *  reflect the key that was just released). An extra modifier held on top of the chord (e.g.
 *  Shift added to a `Cmd+Alt` chord) makes this false, which is also the "third key" misfire
 *  guard for modifier keys specifically (a non-modifier third key is guarded separately, since
 *  this function ignores `e.key` entirely). */
export function chordHeld(e: ShortcutKeyEvent, s: string, isMac: boolean): boolean {
  const need = resolvedModifiers(parseShortcut(s), isMac)
  return (
    e.metaKey === need.meta &&
    e.ctrlKey === need.ctrl &&
    e.shiftKey === need.shift &&
    e.altKey === need.alt
  )
}

/**
 * Build a canonical combo string from a captured keydown, for the Settings capture field.
 * Requires the platform's primary modifier (Cmd on mac / Ctrl elsewhere) plus a non-modifier
 * key; returns null while only modifier keys have been pressed so far, or when the primary
 * modifier is missing. (A modifier-only chord is captured separately — see `buildModifierChord`
 * below — because it commits on keyUP once every key is released, by which point the keyup
 * event's own modifier flags are already false and can't be read off it directly.)
 *
 * **A capture must describe the whole gesture**, because matching is exact: on mac a Control held
 * beside Cmd is recorded as the literal `Ctrl` token, and on non-mac a held Meta (Super/Win)
 * REFUSES the capture — that chord has no spelling in this grammar, and storing the bare `Cmd+…`
 * would save a binding the same gesture can never fire again.
 */
export function captureToShortcut(e: ShortcutKeyEvent, isMac: boolean): string | null {
  const primaryPressed = isMac ? e.metaKey : e.ctrlKey
  if (!primaryPressed) return null
  if (!isMac && e.metaKey) return null
  const key = normalizeKey(e.key)
  if (MODIFIER_KEYS.has(key)) return null
  const parts = ['Cmd']
  if (isMac && e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

/**
 * A captured keydown with NO modifier held, as its canonical key token (`"j"` -> `"J"`, `" "` ->
 * `"SPACE"`), or null when a modifier is held or the key is itself a modifier. Only for commands
 * whose flags permit a bare binding (the board's keys, the bare-key canvas commands); the caller
 * still validates the result through `normalizeBindingForCommand`.
 */
export function captureBareKey(e: ShortcutKeyEvent): string | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null
  const key = normalizeKey(e.key)
  return MODIFIER_KEYS.has(key) ? null : key
}

/** The modifier state observed while capturing a would-be hold-to-talk chord (see
 *  `buildModifierChord`). */
export interface ChordModifiers {
  cmd: boolean
  /** A literal Control held beside the primary (mac ⌃). OPTIONAL so a caller that does not
   *  collect it keeps its existing behavior — collecting it is the capture field's job. */
  ctrl?: boolean
  alt: boolean
  shift: boolean
}

/** `{cmd:true, alt:true, shift:false}` -> `"Cmd+Alt"`; `{cmd:false, ...}` -> `null` (the primary
 *  modifier is mandatory, same as `captureToShortcut`). A `ctrl` observed beside the primary
 *  becomes the literal `Ctrl` token, for the same reason `captureToShortcut` records it: under
 *  exact matching, a chord that omits a modifier the user was holding can never fire. The Settings
 *  capture field calls this at keyUp, once every key has been released, using the modifier state it
 *  remembered from the last keyDown while only modifier keys had been pressed
 *  (`isModifierEventKey`) — the keyup event itself no longer carries that state. */
export function buildModifierChord(mods: ChordModifiers): string | null {
  if (!mods.cmd) return null
  const parts = ['Cmd']
  if (mods.ctrl) parts.push('Ctrl')
  if (mods.alt) parts.push('Alt')
  if (mods.shift) parts.push('Shift')
  return parts.join('+')
}
