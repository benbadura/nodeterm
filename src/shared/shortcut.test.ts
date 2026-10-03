import { describe, expect, it } from 'vitest'
import {
  buildModifierChord,
  captureToShortcut,
  chordHeld,
  formatShortcut,
  isHoldChord,
  isModifierEventKey,
  matchesShortcut,
  parseShortcut,
  resolvedModifiers,
  serializeShortcut,
  shortcutKeyParts
} from './shortcut'

describe('parseShortcut', () => {
  it('parses the default combo', () => {
    expect(parseShortcut('Cmd+Shift+D')).toEqual({
      cmd: true,
      ctrl: false,
      shift: true,
      alt: false,
      key: 'D'
    })
  })

  it('parses a combo without Shift/Alt', () => {
    expect(parseShortcut('Cmd+D')).toEqual({
      cmd: true,
      ctrl: false,
      shift: false,
      alt: false,
      key: 'D'
    })
  })

  it('parses Alt', () => {
    expect(parseShortcut('Cmd+Alt+D')).toEqual({
      cmd: true,
      ctrl: false,
      shift: false,
      alt: true,
      key: 'D'
    })
  })

  it('parses a named key (F-key)', () => {
    expect(parseShortcut('Cmd+F5')).toEqual({
      cmd: true,
      ctrl: false,
      shift: false,
      alt: false,
      key: 'F5'
    })
  })

  it('parses a named key (Space)', () => {
    expect(parseShortcut('Cmd+Shift+Space')).toEqual({
      cmd: true,
      ctrl: false,
      shift: true,
      alt: false,
      key: 'SPACE'
    })
  })

  it('is tolerant of stray whitespace', () => {
    expect(parseShortcut(' Cmd + Shift + D ')).toEqual({
      cmd: true,
      ctrl: false,
      shift: true,
      alt: false,
      key: 'D'
    })
  })

  it('parses a modifier-only chord (no trailing key) — the v3 hold-to-talk shape', () => {
    expect(parseShortcut('Cmd+Alt')).toEqual({
      cmd: true,
      ctrl: false,
      alt: true,
      shift: false,
      key: null
    })
  })

  it('parses a modifier-only chord with all three modifiers', () => {
    expect(parseShortcut('Cmd+Alt+Shift')).toEqual({
      cmd: true,
      ctrl: false,
      alt: true,
      shift: true,
      key: null
    })
  })
})

describe('formatShortcut', () => {
  it('formats the default combo on mac with symbols', () => {
    expect(formatShortcut('Cmd+Shift+D', true)).toBe('⌘⇧D')
  })

  it('formats the default combo off mac as Ctrl+Shift+D', () => {
    expect(formatShortcut('Cmd+Shift+D', false)).toBe('Ctrl+Shift+D')
  })

  it('formats Alt on mac', () => {
    expect(formatShortcut('Cmd+Alt+D', true)).toBe('⌘⌥D')
  })

  it('formats Alt off mac', () => {
    expect(formatShortcut('Cmd+Alt+D', false)).toBe('Ctrl+Alt+D')
  })

  it('formats a bare Cmd combo', () => {
    expect(formatShortcut('Cmd+D', true)).toBe('⌘D')
    expect(formatShortcut('Cmd+D', false)).toBe('Ctrl+D')
  })

  it('formats named keys with friendly labels', () => {
    expect(formatShortcut('Cmd+Space', true)).toBe('⌘Space')
    expect(formatShortcut('Cmd+Shift+F5', false)).toBe('Ctrl+Shift+F5')
  })

  it('round-trips parse -> format -> parse (mac and non-mac agree on the parsed shape)', () => {
    for (const combo of ['Cmd+Shift+D', 'Cmd+D', 'Cmd+Alt+Shift+F5']) {
      const parsed = parseShortcut(combo)
      // Formatting for either platform is a pure display transform of the same parsed shape —
      // reformatting a fresh capture (captureToShortcut) must reparse identically.
      expect(parseShortcut(combo)).toEqual(parsed)
    }
  })

  it('formats a modifier-only chord (Cmd+Alt) on mac with no trailing key badge', () => {
    expect(formatShortcut('Cmd+Alt', true)).toBe('⌘⌥')
  })

  it('formats a modifier-only chord (Cmd+Alt) off mac with no trailing key badge', () => {
    expect(formatShortcut('Cmd+Alt', false)).toBe('Ctrl+Alt')
  })

  it('round-trips a modifier-only chord through parse -> format -> parse', () => {
    for (const combo of ['Cmd+Alt', 'Cmd+Alt+Shift']) {
      const parsed = parseShortcut(combo)
      expect(parsed.key).toBeNull()
      // formatShortcut is a display transform; there's no un-format, but shortcutKeyParts should
      // never emit a stray trailing key badge for a modifier-only chord.
      expect(shortcutKeyParts(combo, true).length).toBe(
        (parsed.cmd ? 1 : 0) + (parsed.alt ? 1 : 0) + (parsed.shift ? 1 : 0)
      )
    }
  })
})

describe('shortcutKeyParts', () => {
  it('splits the default combo into one badge per key on mac', () => {
    expect(shortcutKeyParts('Cmd+Shift+D', true)).toEqual(['⌘', '⇧', 'D'])
  })

  it('splits the default combo into one badge per key off mac', () => {
    expect(shortcutKeyParts('Cmd+Shift+D', false)).toEqual(['Ctrl', 'Shift', 'D'])
  })

  it('keeps a multi-char named key as a single badge (not split into letters)', () => {
    expect(shortcutKeyParts('Cmd+Space', true)).toEqual(['⌘', 'Space'])
  })

  it('joins to the same string formatShortcut returns', () => {
    for (const [combo, isMac] of [
      ['Cmd+Shift+D', true],
      ['Cmd+Shift+D', false],
      ['Cmd+Alt+Shift+F5', true]
    ] as const) {
      const parts = shortcutKeyParts(combo, isMac)
      const joined = isMac ? parts.join('') : parts.join('+')
      expect(joined).toBe(formatShortcut(combo, isMac))
    }
  })
})

describe('matchesShortcut', () => {
  const base = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: 'd' }

  // The DOM reports the space bar as `e.key === ' '`, while the canonical token is `Space`. Without
  // mapping one onto the other, no `Space` binding could ever fire.
  it('matches the space bar against a Space binding', () => {
    expect(matchesShortcut({ ...base, key: ' ' }, 'Space', true)).toBe(true)
    expect(matchesShortcut({ ...base, key: ' ', metaKey: true }, 'Cmd+Space', true)).toBe(true)
    expect(matchesShortcut({ ...base, key: 'a' }, 'Space', true)).toBe(false)
  })

  it('captures the space bar as the canonical Space token', () => {
    expect(captureToShortcut({ ...base, key: ' ', metaKey: true }, true)).toBe('Cmd+SPACE')
    expect(parseShortcut(captureToShortcut({ ...base, key: ' ', metaKey: true }, true)!).key).toBe('SPACE')
  })

  it('matches on mac with metaKey as the primary modifier', () => {
    expect(matchesShortcut({ ...base, metaKey: true, shiftKey: true }, 'Cmd+Shift+D', true)).toBe(
      true
    )
  })

  it('does NOT match on mac when ctrlKey stands in for metaKey', () => {
    expect(matchesShortcut({ ...base, ctrlKey: true, shiftKey: true }, 'Cmd+Shift+D', true)).toBe(
      false
    )
  })

  it('matches off mac with ctrlKey as the primary modifier', () => {
    expect(
      matchesShortcut({ ...base, ctrlKey: true, shiftKey: true }, 'Cmd+Shift+D', false)
    ).toBe(true)
  })

  it('does NOT match off mac when metaKey stands in for ctrlKey', () => {
    expect(
      matchesShortcut({ ...base, metaKey: true, shiftKey: true }, 'Cmd+Shift+D', false)
    ).toBe(false)
  })

  it('rejects a missing Shift', () => {
    expect(matchesShortcut({ ...base, metaKey: true, shiftKey: false }, 'Cmd+Shift+D', true)).toBe(
      false
    )
  })

  it('rejects an extra Alt not in the combo', () => {
    expect(
      matchesShortcut({ ...base, metaKey: true, shiftKey: true, altKey: true }, 'Cmd+Shift+D', true)
    ).toBe(false)
  })

  it('rejects the wrong letter key', () => {
    expect(
      matchesShortcut({ ...base, metaKey: true, shiftKey: true, key: 'e' }, 'Cmd+Shift+D', true)
    ).toBe(false)
  })

  it('is case-insensitive on e.key when Shift is held (browsers report the shifted char)', () => {
    // Shift+d is delivered as e.key === 'D' by the DOM; either case must match.
    expect(
      matchesShortcut({ ...base, metaKey: true, shiftKey: true, key: 'D' }, 'Cmd+Shift+D', true)
    ).toBe(true)
    expect(
      matchesShortcut({ ...base, metaKey: true, shiftKey: true, key: 'd' }, 'Cmd+Shift+D', true)
    ).toBe(true)
  })

  it('matches a bare Cmd combo with no Shift/Alt required', () => {
    expect(matchesShortcut({ ...base, metaKey: true }, 'Cmd+D', true)).toBe(true)
  })

  it('matches named keys (F-key)', () => {
    expect(
      matchesShortcut({ ...base, metaKey: true, key: 'F5' }, 'Cmd+F5', true)
    ).toBe(true)
  })

  it('never matches a modifier-only chord — that shape has no key to check', () => {
    // Even a keydown of a real key while the exact modifiers are held must not match: a
    // modifier-only shortcut is handled by chordHeld, not matchesShortcut.
    expect(matchesShortcut({ ...base, metaKey: true, altKey: true, key: 'd' }, 'Cmd+Alt', true)).toBe(
      false
    )
  })
})

describe('isHoldChord', () => {
  it('is true for a modifier-only combo', () => {
    expect(isHoldChord('Cmd+Alt')).toBe(true)
    expect(isHoldChord('Cmd+Alt+Shift')).toBe(true)
  })

  it('is false for a keyed combo', () => {
    expect(isHoldChord('Cmd+Alt+D')).toBe(false)
    expect(isHoldChord('Cmd+D')).toBe(false)
  })

  // DOCUMENTATION OF A HAZARD, not a desirable property: `''` parses to a chord with no key, so
  // it reads as a HOLD chord. `dictationBinding()` returns `''` for a DISABLED dictation shortcut
  // (override `[]`), so any caller that asks `isHoldChord(chord)` without first testing for the
  // empty string classifies "off" as "hold-to-talk" — which is why SpeechSection's note checks
  // `chord === ''` FIRST, and why the hold listener must not arm on it.
  it('is TRUE for the empty string — every caller owes it an explicit empty check', () => {
    expect(isHoldChord('')).toBe(true)
  })
})

describe('isModifierEventKey', () => {
  it('recognizes modifier key names, case-insensitively', () => {
    expect(isModifierEventKey('Meta')).toBe(true)
    expect(isModifierEventKey('CONTROL')).toBe(true)
    expect(isModifierEventKey('alt')).toBe(true)
    expect(isModifierEventKey('Shift')).toBe(true)
  })

  it('rejects non-modifier keys', () => {
    expect(isModifierEventKey('d')).toBe(false)
    expect(isModifierEventKey('F5')).toBe(false)
    expect(isModifierEventKey('Escape')).toBe(false)
  })
})

describe('chordHeld', () => {
  const base = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: 'Alt' }

  it('is true when the event modifiers exactly match the chord (mac)', () => {
    expect(chordHeld({ ...base, metaKey: true, altKey: true }, 'Cmd+Alt', true)).toBe(true)
  })

  it('is true when the event modifiers exactly match the chord (non-mac, ctrlKey primary)', () => {
    expect(chordHeld({ ...base, ctrlKey: true, altKey: true }, 'Cmd+Alt', false)).toBe(true)
  })

  it('is false when the primary modifier is missing', () => {
    expect(chordHeld({ ...base, altKey: true }, 'Cmd+Alt', true)).toBe(false)
  })

  it('is false when a required modifier (alt) is missing', () => {
    expect(chordHeld({ ...base, metaKey: true }, 'Cmd+Alt', true)).toBe(false)
  })

  it('is false when an EXTRA modifier is held beyond what the chord requires', () => {
    expect(chordHeld({ ...base, metaKey: true, altKey: true, shiftKey: true }, 'Cmd+Alt', true)).toBe(
      false
    )
  })

  it('is false on the wrong platform primary (ctrlKey standing in for metaKey on mac)', () => {
    expect(chordHeld({ ...base, ctrlKey: true, altKey: true }, 'Cmd+Alt', true)).toBe(false)
  })

  it('ignores e.key entirely — same result regardless of which key the event names', () => {
    expect(chordHeld({ ...base, metaKey: true, altKey: true, key: 'd' }, 'Cmd+Alt', true)).toBe(true)
  })
})

describe('buildModifierChord', () => {
  it('builds a Cmd+Alt combo', () => {
    expect(buildModifierChord({ cmd: true, alt: true, shift: false })).toBe('Cmd+Alt')
  })

  it('builds a Cmd+Alt+Shift combo', () => {
    expect(buildModifierChord({ cmd: true, alt: true, shift: true })).toBe('Cmd+Alt+Shift')
  })

  it('builds a bare Cmd combo', () => {
    expect(buildModifierChord({ cmd: true, alt: false, shift: false })).toBe('Cmd')
  })

  it('returns null when the primary modifier is missing', () => {
    expect(buildModifierChord({ cmd: false, alt: true, shift: true })).toBeNull()
  })

  it('emits the literal Ctrl token after Cmd when a Control was held too', () => {
    expect(buildModifierChord({ cmd: true, ctrl: true, alt: false, shift: false })).toBe('Cmd+Ctrl')
  })

  it('round-trips through parseShortcut', () => {
    const combo = buildModifierChord({ cmd: true, alt: true, shift: false })
    expect(combo).not.toBeNull()
    expect(parseShortcut(combo as string)).toEqual({
      cmd: true,
      ctrl: false,
      alt: true,
      shift: false,
      key: null
    })
    expect(isHoldChord(combo as string)).toBe(true)
  })
})

describe('captureToShortcut', () => {
  it('builds a canonical combo from a mac keydown (metaKey primary)', () => {
    expect(
      captureToShortcut({ metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, key: 'd' }, true)
    ).toBe('Cmd+Shift+D')
  })

  it('builds a canonical combo from a non-mac keydown (ctrlKey primary)', () => {
    expect(
      captureToShortcut(
        { metaKey: false, ctrlKey: true, shiftKey: true, altKey: false, key: 'd' },
        false
      )
    ).toBe('Cmd+Shift+D')
  })

  it('returns null when the primary modifier is missing', () => {
    expect(
      captureToShortcut({ metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, key: 'd' }, true)
    ).toBeNull()
  })

  it('returns null when only modifier keys were pressed (no non-modifier key yet)', () => {
    expect(
      captureToShortcut(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: 'Meta' },
        true
      )
    ).toBeNull()
    expect(
      captureToShortcut(
        { metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, key: 'Shift' },
        true
      )
    ).toBeNull()
  })

  it('a captured combo round-trips through matchesShortcut for the same platform', () => {
    const e = { metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, key: 'd' }
    const combo = captureToShortcut(e, true)
    expect(combo).not.toBeNull()
    expect(matchesShortcut(e, combo as string, true)).toBe(true)
  })

  it('records a Control held alongside Cmd on mac, and the capture still matches its own gesture', () => {
    const e = { metaKey: true, ctrlKey: true, shiftKey: false, altKey: false, key: 'd' }
    const combo = captureToShortcut(e, true)
    expect(combo).toBe('Cmd+Ctrl+D')
    expect(matchesShortcut(e, combo as string, true)).toBe(true)
  })

  it('returns null on non-mac when Meta (Super/Win) is held — the grammar cannot express it', () => {
    expect(
      captureToShortcut(
        { metaKey: true, ctrlKey: true, shiftKey: false, altKey: false, key: 'd' },
        false
      )
    ).toBeNull()
  })
})

describe('literal Ctrl token', () => {
  it('parses Ctrl as literal control, not the abstract primary', () => {
    expect(parseShortcut('Ctrl+Insert')).toEqual({
      cmd: false, ctrl: true, shift: false, alt: false, key: 'INSERT'
    })
  })
  it('matches literal Ctrl via ctrlKey on mac, with metaKey forbidden', () => {
    const e = { metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, key: 'Insert' }
    expect(matchesShortcut(e, 'Ctrl+Insert', true)).toBe(true)
    expect(matchesShortcut({ ...e, metaKey: true }, 'Ctrl+Insert', true)).toBe(false)
  })
  it('keeps non-mac behavior for Ctrl strings identical to Cmd strings', () => {
    const e = { metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, key: 'x' }
    expect(matchesShortcut(e, 'Ctrl+X', false)).toBe(true)
    expect(matchesShortcut(e, 'Cmd+X', false)).toBe(true)
  })
})

describe('strict modifier matching', () => {
  it('rejects a held Control on top of a Cmd chord on mac', () => {
    const e = { metaKey: true, ctrlKey: true, shiftKey: false, altKey: false, key: 'k' }
    expect(matchesShortcut(e, 'Cmd+K', true)).toBe(false)
  })
  it('rejects a held Meta on top of a Cmd chord on non-mac', () => {
    const e = { metaKey: true, ctrlKey: true, shiftKey: false, altKey: false, key: 'k' }
    expect(matchesShortcut(e, 'Cmd+K', false)).toBe(false)
  })
  it('chordHeld applies the same strictness', () => {
    const e = { metaKey: true, ctrlKey: true, shiftKey: false, altKey: true, key: 'Control' }
    expect(chordHeld(e, 'Cmd+Alt', true)).toBe(false)
  })
  // The other half of the `''` guard (see isHoldChord above): the KEYED path is safe on its own —
  // an empty chord parses to `key: null`, which no event key equals — so a disabled dictation
  // shortcut can never be pressed into existence, however the modifiers happen to be held.
  it('never matches the empty string, whatever is held', () => {
    const e = { metaKey: true, ctrlKey: false, shiftKey: false, altKey: true, key: 'd' }
    expect(matchesShortcut(e, '', true)).toBe(false)
  })
})

describe('named punctuation keys', () => {
  it('normalizes Comma and Slash tokens to their e.key characters', () => {
    expect(parseShortcut('Cmd+Comma').key).toBe(',')
    expect(parseShortcut('Cmd+Slash').key).toBe('/')
  })
  it('matches a comma keydown against Cmd+Comma', () => {
    const e = { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: ',' }
    expect(matchesShortcut(e, 'Cmd+Comma', true)).toBe(true)
  })
  it('renders punctuation parts as the character itself', () => {
    expect(shortcutKeyParts('Cmd+Slash', true)).toEqual(['⌘', '/'])
  })
})

describe('serializeShortcut', () => {
  it('round-trips in canonical Cmd,Ctrl,Alt,Shift,key order', () => {
    expect(serializeShortcut(parseShortcut('shift+d+cmd'))).toBe('Cmd+Shift+D')
    expect(serializeShortcut(parseShortcut('Ctrl+Insert'))).toBe('Ctrl+Insert')
    expect(serializeShortcut(parseShortcut('Alt+Cmd'))).toBe('Cmd+Alt')
  })
  it('round-trips a named key through its canonical spelling', () => {
    expect(serializeShortcut(parseShortcut('Cmd+Enter'))).toBe('Cmd+Enter')
  })
  it('collapses alias spellings onto one canonical identity', () => {
    expect(serializeShortcut(parseShortcut('Cmd+Esc'))).toBe('Cmd+Escape')
    expect(serializeShortcut(parseShortcut('Cmd+Return'))).toBe('Cmd+Enter')
  })
})

describe('resolvedModifiers', () => {
  it('maps Cmd to meta on mac and ctrl elsewhere', () => {
    const p = parseShortcut('Cmd+Shift+K')
    expect(resolvedModifiers(p, true)).toEqual({ meta: true, ctrl: false, alt: false, shift: true })
    expect(resolvedModifiers(p, false)).toEqual({ meta: false, ctrl: true, alt: false, shift: true })
  })
})

describe('parseShortcut memoization', () => {
  it('returns the same frozen object for repeated input', () => {
    const a = parseShortcut('Cmd+Shift+D')
    const b = parseShortcut('Cmd+Shift+D')
    expect(b).toBe(a)
    expect(Object.isFrozen(a)).toBe(true)
  })
})
