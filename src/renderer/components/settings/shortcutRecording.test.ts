import { describe, it, expect } from 'vitest'
import { recordingKeydown, recordingKeyup } from './shortcutRecording'

const e = (
  over: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string }>
) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  key: '',
  ...over
})
const HOLD = { isMac: true, allowHold: true }
const KEYED = { isMac: true, allowHold: false }

describe('recordingKeydown', () => {
  it('a keyed chord commits immediately', () => {
    expect(recordingKeydown({ mods: null }, e({ metaKey: true, key: 'd' }), KEYED)).toEqual({
      kind: 'commit',
      combo: 'Cmd+D'
    })
  })
  it('mac Ctrl rides along in a keyed capture (the PR1 gap, closed)', () => {
    expect(
      recordingKeydown({ mods: null }, e({ metaKey: true, ctrlKey: true, key: 'd' }), KEYED)
    ).toEqual({ kind: 'commit', combo: 'Cmd+Ctrl+D' })
  })
  it('Escape cancels', () => {
    expect(recordingKeydown({ mods: null }, e({ key: 'Escape' }), KEYED)).toEqual({ kind: 'cancel' })
  })
  it('modifier-only keydown is pending: remembered for a hold commit when allowed', () => {
    const r = recordingKeydown({ mods: null }, e({ metaKey: true, altKey: true, key: 'Alt' }), HOLD)
    expect(r.kind).toBe('pending')
    if (r.kind === 'pending') expect(r.state.mods).toEqual({ cmd: true, ctrl: false, alt: true, shift: false })
  })
  it('mac Ctrl is collected into a hold chord (the PR1 gap, closed)', () => {
    const r = recordingKeydown({ mods: null }, e({ metaKey: true, ctrlKey: true, key: 'Control' }), HOLD)
    if (r.kind === 'pending') expect(r.state.mods?.ctrl).toBe(true)
    expect(r.kind).toBe('pending')
  })
  it('non-mac held Super is refused with a hint', () => {
    const r = recordingKeydown({ mods: null }, e({ metaKey: true, ctrlKey: true, key: 'Control' }), {
      isMac: false,
      allowHold: true
    })
    expect(r.kind).toBe('pending')
    if (r.kind === 'pending') {
      expect(r.state.mods).toBeNull()
      expect(r.hint).toContain('Super')
    }
  })
  // Deliberate divergence from the legacy SpeechSection field, which left modsRef untouched here:
  // arm Cmd+Alt, release ⌘ while keeping ⌥, add ⇧ — the baseline still committed Cmd+Alt on the
  // eventual full release, a chord the finished gesture (⌥⇧) could never fire under exact
  // matching. Losing the primary modifier must DISARM.
  it('a modifier-only keydown without the primary disarms an armed hold chord', () => {
    const armed = { mods: { cmd: true, ctrl: false, alt: true, shift: false } }
    const r = recordingKeydown(armed, e({ altKey: true, shiftKey: true, key: 'Shift' }), HOLD)
    expect(r.kind).toBe('pending')
    if (r.kind === 'pending') expect(r.state.mods).toBeNull()
  })
  // Board keys (J/K/Space/arrows) and the bare-key commands (Delete) are bare by default; a
  // recorder that could only capture Cmd+… could never set one back to a single key.
  it('a bare key commits as itself when the command allows bare keys', () => {
    const BARE = { isMac: true, allowHold: false, allowBare: true }
    expect(recordingKeydown({ mods: null }, e({ key: 'j' }), BARE)).toEqual({ kind: 'commit', combo: 'J' })
    expect(recordingKeydown({ mods: null }, e({ key: ' ' }), BARE)).toEqual({ kind: 'commit', combo: 'SPACE' })
    expect(recordingKeydown({ mods: null }, e({ key: 'ArrowDown' }), BARE)).toEqual({ kind: 'commit', combo: 'ARROWDOWN' })
    // Escape still cancels — it is the recorder's own exit, never a capture.
    expect(recordingKeydown({ mods: null }, e({ key: 'Escape' }), BARE)).toEqual({ kind: 'cancel' })
    // A modified press still captures the whole chord.
    expect(recordingKeydown({ mods: null }, e({ metaKey: true, key: 'j' }), BARE)).toEqual({ kind: 'commit', combo: 'Cmd+J' })
  })
  it('a bare key stays refused for every other command', () => {
    expect(recordingKeydown({ mods: null }, e({ key: 'j' }), KEYED).kind).toBe('pending')
  })
  it('modifier-only keydown without allowHold just previews the requirement', () => {
    const r = recordingKeydown({ mods: null }, e({ metaKey: true, key: 'Meta' }), KEYED)
    expect(r.kind).toBe('pending')
    if (r.kind === 'pending') expect(r.state.mods).toBeNull()
  })
})

describe('recordingKeyup', () => {
  it('full release commits the remembered hold chord', () => {
    const armed = { mods: { cmd: true, ctrl: false, alt: true, shift: false } }
    expect(recordingKeyup(armed, e({}), HOLD)).toEqual({ kind: 'commit', combo: 'Cmd+Alt' })
  })
  it('partial release keeps waiting; no remembered mods ignores', () => {
    const armed = { mods: { cmd: true, ctrl: false, alt: true, shift: false } }
    expect(recordingKeyup(armed, e({ metaKey: true }), HOLD)).toEqual({ kind: 'ignored' })
    expect(recordingKeyup({ mods: null }, e({}), HOLD)).toEqual({ kind: 'ignored' })
  })
  // WATCH-2: the legacy SpeechSection `anyModDown` omitted ctrlKey, so a mac hold chord recorded
  // with Ctrl held committed while Ctrl was still down — mis-capturing the gesture. The full
  // release condition must read ALL FOUR modifier flags.
  it('a keyup with only Ctrl still held is ignored (the anyModDown gap, closed)', () => {
    const armed = { mods: { cmd: true, ctrl: true, alt: false, shift: false } }
    expect(recordingKeyup(armed, e({ ctrlKey: true }), HOLD)).toEqual({ kind: 'ignored' })
    expect(recordingKeyup(armed, e({}), HOLD)).toEqual({ kind: 'commit', combo: 'Cmd+Ctrl' })
  })
})
