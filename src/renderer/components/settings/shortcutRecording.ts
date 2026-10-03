/**
 * The pure capture state machine behind the Settings shortcut recorder. Generalizes the legacy
 * SpeechSection `ShortcutCaptureField` (one hard-wired dictation chord) into a decision function
 * any command row can drive, and closes the two gaps that field shipped with.
 *
 * `ShortcutCaptureField` and its `anyModDown` helper were both REMOVED in this series — they are
 * named below only to record which bug each gap was; there is nothing left in the tree to grep.
 *
 * Two commit shapes, exactly as the v3 chord grammar defines them:
 *  - A KEYED chord (primary modifier + a non-modifier key) commits IMMEDIATELY on keydown.
 *  - A HOLD chord (modifier keys only — permitted only when `allowHold`, i.e. the command's
 *    `allowHoldChord`) commits on KEYUP once every key is released. The keyup event no longer
 *    carries the modifier state that was held, so each modifier keydown along the way remembers
 *    it in `RecordingState.mods` (see `buildModifierChord`'s doc in @shared/shortcut).
 * Escape cancels. The caller cancels on blur.
 *
 * The gaps this closes, both instances of "a capture must describe the WHOLE gesture" (matching is
 * exact on all four modifier flags, so a chord that omits a modifier the user was holding can
 * never fire again):
 *  1. **mac Ctrl is collected**, in BOTH paths — the keyed path via `captureToShortcut`, the hold
 *     path via `ChordModifiers.ctrl` here. The legacy field built `{cmd, alt, shift}` and dropped
 *     a held ⌃ on the floor.
 *  2. **Full release reads ALL FOUR flags.** The legacy `anyModDown` was
 *     `(isMac ? metaKey : ctrlKey) || altKey || shiftKey` — no `ctrlKey`, so a mac chord recorded
 *     with Ctrl held committed while Ctrl was still down, recording a chord the user never
 *     finished making.
 * A non-mac held Meta (Super/Win) is REFUSED rather than recorded as a bare `Cmd+…`: that gesture
 * has no spelling in this grammar (same rule `captureToShortcut` already applies to keyed
 * captures, here extended to the hold path).
 *
 * **Deliberate divergence from the legacy field — losing the primary modifier DISARMS.** When a
 * modifier-only keydown arrives with the primary modifier NOT pressed, the legacy field showed the
 * `Hold ⌘…` hint and returned, leaving `modsRef` holding whatever it had armed earlier. That let a
 * gesture commit a chord the user was no longer making: arm `Cmd+Alt`, release ⌘ while keeping ⌥,
 * add ⇧ — the ⇧ keydown left `{cmd:true, alt:true}` armed, and the eventual full release committed
 * `Cmd+Alt` even though the user finished on ⌥⇧. Under exact matching that stored chord then never
 * fires from the gesture that recorded it. Here the same event clears `mods`, so a hold chord is
 * only ever committed from a state where the primary was observed down alongside it; the user
 * simply presses the chord again. (`recordingKeydown` still preserves an armed chord across a
 * REFUSED KEYED press — see the `captureToShortcut` fall-through below — because that path cannot
 * lose the primary without a modifier keyup/keydown passing through here first.)
 *
 * Pure: no DOM, no React, no clock. The component owns `RecordingState` in a ref and the caller
 * validates the committed combo through `normalizeBindingForCommand` — this module decides only
 * what the gesture MEANT, never whether the command accepts it.
 */
import {
  buildModifierChord,
  captureBareKey,
  captureToShortcut,
  formatShortcut,
  isModifierEventKey,
  type ChordModifiers,
  type ShortcutKeyEvent
} from '@shared/shortcut'

/** What the recorder remembers between events: the strongest modifier-only state seen so far,
 *  or `null` while no hold chord is armed. */
export interface RecordingState {
  mods: ChordModifiers | null
}

export type RecordingAction =
  /** A complete gesture. The combo is canonical but NOT yet validated for the command. */
  | { kind: 'commit'; combo: string }
  /** Escape — stop recording, change nothing. */
  | { kind: 'cancel' }
  /** Still recording: adopt `state` and show `hint`. */
  | { kind: 'pending'; state: RecordingState; hint: string }
  /** Nothing to do (and nothing to show) — leave the recorder exactly as it was. */
  | { kind: 'ignored' }

export interface RecordingOptions {
  isMac: boolean
  /** The command's `allowHoldChord`. When false, a modifier-only gesture can never commit — it
   *  only previews the requirement, and the user must go on to press a real key. */
  allowHold: boolean
  /** The command may be bound to a bare key (a board key, a bare-key canvas command): an
   *  unmodified press commits as itself. Optional so every existing caller keeps its behavior. */
  allowBare?: boolean
}

/** Non-mac Meta (Super/Win): unspellable in this grammar, in both the keyed and hold paths. */
const SUPER_UNSUPPORTED = 'The Super key is not supported.'

const holdPrimaryHint = (isMac: boolean): string => (isMac ? 'Hold ⌘…' : 'Hold Ctrl…')
const keyedPrimaryHint = (isMac: boolean): string =>
  isMac ? 'Hold ⌘ and press a key' : 'Hold Ctrl and press a key'

/** Decide what a keydown during recording means. `state` is the recorder's current state; the
 *  returned `pending` state replaces it (a `commit`/`cancel`/`ignored` leaves it to the caller,
 *  which stops recording on the first two). */
export function recordingKeydown(
  state: RecordingState,
  e: ShortcutKeyEvent & { key: string },
  opts: RecordingOptions
): RecordingAction {
  const { isMac, allowHold } = opts
  if (e.key === 'Escape') return { kind: 'cancel' }

  if (isModifierEventKey(e.key)) {
    // Only modifier keys are down so far. When the command permits a hold chord this is a
    // candidate commit-on-release; otherwise it is purely a preview of what is still missing.
    if (!allowHold) return { kind: 'pending', state: { mods: null }, hint: keyedPrimaryHint(isMac) }
    if (!isMac && e.metaKey) return { kind: 'pending', state: { mods: null }, hint: SUPER_UNSUPPORTED }
    const primaryPressed = isMac ? e.metaKey : e.ctrlKey
    if (!primaryPressed) {
      return { kind: 'pending', state: { mods: null }, hint: holdPrimaryHint(isMac) }
    }
    // A literal ⌃ beside the primary is part of the gesture on mac; off-mac `Cmd` already IS
    // ctrlKey, so recording both would be the chord keybindings.ts validation forbids.
    const mods: ChordModifiers = {
      cmd: true,
      ctrl: isMac && e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey
    }
    const preview = buildModifierChord(mods)
    return {
      kind: 'pending',
      state: { mods },
      hint: preview ? `Release for ${formatShortcut(preview, isMac)} — or press a key` : ''
    }
  }

  if (opts.allowBare) {
    const bare = captureBareKey(e)
    if (bare) return { kind: 'commit', combo: bare }
  }
  const combo = captureToShortcut(e, isMac)
  if (combo) return { kind: 'commit', combo }
  // Refused: either the primary modifier is missing, or (off-mac) Super is held. Keep whatever
  // hold chord was armed — the user may still complete it by releasing everything.
  return {
    kind: 'pending',
    state,
    hint: !isMac && e.metaKey ? SUPER_UNSUPPORTED : keyedPrimaryHint(isMac)
  }
}

/** Decide what a keyup during recording means: a hold chord commits once EVERY modifier is up. */
export function recordingKeyup(
  state: RecordingState,
  e: ShortcutKeyEvent,
  opts: RecordingOptions
): RecordingAction {
  if (!opts.allowHold || !state.mods) return { kind: 'ignored' }
  // All four flags. `ctrlKey` is the one the legacy field forgot — see the module doc. The keyup
  // event's own flags already exclude the key just released, so "no flag set" means fully up.
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return { kind: 'ignored' }
  const combo = buildModifierChord(state.mods)
  if (!combo) return { kind: 'ignored' }
  return { kind: 'commit', combo }
}
