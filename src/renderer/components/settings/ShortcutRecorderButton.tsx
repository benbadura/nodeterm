/**
 * Generalized shortcut recorder: click to arm, press a chord. Keyed chords commit on keydown;
 * for allowHoldChord commands a modifier-only chord commits on full release (hold-to-talk).
 *
 * **Two separate mechanisms hold the keys off, one per process.** In the RENDERER it is this
 * component's own `preventDefault` + `stopPropagation` on every key it sees — the window
 * dispatcher bails on `defaultPrevented`, so nothing else in the page acts on the chord. The
 * `data-shortcut-recording` attribute is NOT part of that path: nothing reads it, and it is kept
 * only as the DOM-visible signal that the recorder is armed (tests, debugging, styling hooks). In
 * MAIN it is `shortcuts.setRecording`, because a chord the window intercepts in
 * `before-input-event` (⌘W, ⌘M, ⌘0) never reaches the page at all — no amount of renderer-side
 * preventing can catch a key the page was never given. Recording ⌘W without it DELETES THE
 * SELECTED NODES.
 *
 * **The main-process bit is GLOBAL, so it owes an unmount release.** Chromium does not reliably
 * fire `blur` on a focused element that is REMOVED from the DOM, so closing Settings while the
 * recorder is armed can skip `onBlur` entirely — leaving the bit set with no component left to
 * clear it, suppressing ⌘W/⌘M/⌘0 app-wide until the next arm/disarm cycle. `release` (below) is
 * the teardown both `stop()` and the unmount cleanup run; it touches refs only, so it is stable.
 * It is safe to run from an instance that was never armed because it CHECKS (`armedRef`) — not
 * because the send would be harmless. One global bit, many instances: an unconditional release
 * would let a sibling unmounting for unrelated reasons clear the armed recorder's bit.
 *
 * **A menu accelerator needs a THIRD mechanism, and it now has one.** The main-process bit above
 * only stops nodeterm's own `before-input-event` intercepts; the application menu's accelerators
 * are handled above the page regardless. So main also DISABLES the command-style menu items in
 * `menuItemIdsToSuspend` while this bit is set (`menuStandsDown` → `syncMenuForStandDown` in
 * `src/main/index.ts`) — a disabled item suppresses its accelerator, which is what lets ⌘M
 * (Window ▸ Minimize), ⌘⇧B (Toggle Kanban Board), ⌘, (Settings) and, off-mac, Ctrl+W (Window ▸
 * Close) reach this component instead of acting. Pressing ⌘⇧B or ⌘, into an armed recorder used to
 * FIRE — opening the board behind the Settings dialog, or re-opening Settings.
 *
 * **What stays out of reach**, deliberately: **Reload** (⌘R / ⌘⇧R) is excluded from that list as
 * the crash-recovery lever, so it can never be recorded. And the list only covers the items the
 * policy stand-down needed — the always-on app roles (`quit` ⌘Q, `hide`/`hideOthers`,
 * `toggleDevTools`, `togglefullscreen`) are NOT suspended, so those chords still act while a
 * recorder is armed. See `menuItemIdsToSuspend` in `src/main/keydown-intercept.ts`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { COMMANDS_BY_ID, normalizeBindingForCommand, type CommandId } from '@shared/keybindings'
import { isMacPlatform } from '@shared/platform-utils'
import { recordingKeydown, recordingKeyup, type RecordingState } from './shortcutRecording'
import { IconRecordKey } from './ShortcutRowIcons'
import { Tooltip } from '../Tooltip'

const isMac = isMacPlatform()

export function ShortcutRecorderButton({
  commandId,
  idleLabel,
  onCommit,
  appearance = 'button',
  label,
  idleIcon,
  tooltip
}: {
  commandId: CommandId
  idleLabel: string
  onCommit: (combo: string) => void
  appearance?: 'button' | 'icon'
  label?: string
  /** Hover-tooltip text for the IDLE `appearance="icon"` button (the app's custom Tooltip, not
   *  the OS-delayed native one). The icon is the whole visible label, so this is where "replace"
   *  vs "add another" gets said. Omitted ⇒ the accessible label. */
  tooltip?: string
  /** The glyph the IDLE `appearance="icon"` button shows — presentational only, and it changes
   *  nothing else about the recorder. It exists because a row can carry two recorders (Record and
   *  Add) side by side in one label-less cluster, where the icon IS the label and two identical
   *  keycaps would leave the pair unreadable. Omitted ⇒ the keycap, so every existing call site
   *  renders exactly what it did before. */
  idleIcon?: React.ReactNode
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [hint, setHint] = useState('')
  const stateRef = useRef<RecordingState>({ mods: null })
  // Did THIS instance arm the (global) main-process bit? See `release`.
  const armedRef = useRef(false)
  const def = COMMANDS_BY_ID.get(commandId)!
  const opts = {
    isMac,
    allowHold: def.allowHoldChord === true,
    // Bare keys only where the registry lets the command have one; normalizeBindingForCommand
    // (below) still refuses a bare key a command's flags do not permit (e.g. Delete's SAFE set).
    allowBare: def.scope === 'board' || def.allowBareKey === true
  }

  // Refs only ⇒ stable with no deps, so the mount-time cleanup below cannot capture stale state,
  // and idempotent ⇒ running it twice, or on an unmount that was never armed, does nothing.
  //
  // **`armedRef` is what makes it safe to run from every instance.** The main-process bit is ONE
  // global boolean while this component is rendered once per command, so a sibling unmounting for
  // reasons that have nothing to do with recording must not speak for the armed one. That is not
  // hypothetical in this page: settings rows are wrapped in `SearchableRow`, which returns `null`
  // for every row the filter box does not match — so typing there unmounts a batch of recorders at
  // once. An unconditional `setRecording(false)` in that cleanup would clear the ARMED recorder's
  // bit from under it, re-arming ⌘W/⌘M mid-capture: the original bug, reached by a different door.
  // Only the instance that sent `true` may send `false`.
  const release = useCallback((): void => {
    stateRef.current = { mods: null }
    if (!armedRef.current) return
    armedRef.current = false
    window.nodeTerminal.shortcuts.setRecording(false)
  }, [])
  // The unmount leg — the one that matters most (Settings closed mid-recording fires no blur).
  useEffect(() => release, [release])

  const stop = (): void => {
    setCapturing(false)
    setHint('')
    release()
  }
  const start = (): void => {
    stateRef.current = { mods: null }
    setCapturing(true)
    setHint('')
    armedRef.current = true
    window.nodeTerminal.shortcuts.setRecording(true)
  }
  const commit = (combo: string): void => {
    const r = normalizeBindingForCommand(def, combo, isMac)
    if (!r.ok) {
      setHint(r.error)
      return
    }
    onCommit(r.value)
    stop()
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!capturing) return
    e.preventDefault()
    e.stopPropagation()
    const action = recordingKeydown(stateRef.current, e, opts)
    if (action.kind === 'cancel') stop()
    else if (action.kind === 'commit') commit(action.combo)
    else if (action.kind === 'pending') {
      stateRef.current = action.state
      setHint(action.hint)
    }
  }
  const onKeyUp = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!capturing) return
    const action = recordingKeyup(stateRef.current, e, opts)
    if (action.kind === 'commit') commit(action.combo)
  }
  const effectiveLabel = label ?? idleLabel
  // ARMED look is the design spec's accent pill, identical for both appearances — an armed
  // recorder should look the same everywhere. Idle look depends on `appearance`; the 'button'
  // idle branch is byte-identical to the pre-appearance markup.
  const className = capturing
    ? 'min-w-[140px] rounded-md border border-accent bg-[color:var(--accent)]/10 px-3 py-1 text-[12px] text-text ring-1 ring-[color:var(--accent)]/40'
    : appearance === 'icon'
      ? // No Tailwind preflight in this repo: `border-0 bg-transparent p-0` must be explicit or
        // the browser's native button chrome (border + fill + padding) renders around the glyph.
        'flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted hover:bg-fill-weak hover:text-text focus-visible:text-text'
      : 'min-w-[120px] cursor-pointer rounded-md border border-border bg-panel-header px-3 py-1.5 text-[13px] font-medium text-text outline-none hover:bg-[rgba(255,255,255,0.06)]'
  const btn = (
    <button
      type="button"
      // Observability only — no dispatcher reads it (see the header). Keeps the armed state
      // visible to tests and to anyone inspecting the DOM.
      data-shortcut-recording={capturing || undefined}
      className={className}
      onClick={start}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={stop}
      // The icon button has no text in EITHER state, so the label is its only accessible name —
      // and it must survive arming. Dropping it on capture (as this did) left a screen-reader
      // user with a button whose name flipped to the hint text mid-interaction, i.e. no way to
      // tell which command is being recorded for. The 'button' appearance keeps its own text and
      // is deliberately untouched. There is no native `title`: the icon appearance carries the
      // app's custom Tooltip below instead, and two tooltips for one hover is noise.
      aria-label={appearance === 'icon' ? effectiveLabel : undefined}
    >
      {capturing ? (
        <>
          <span className="mr-1.5 inline-block size-1.5 rounded-full bg-accent animate-pulse" />
          {hint || 'Press keys…'}
        </>
      ) : appearance === 'icon' ? (
        (idleIcon ?? <IconRecordKey />)
      ) : (
        idleLabel
      )}
    </button>
  )
  // Only the icon appearance gets the custom tooltip — the 'button' appearance has visible text,
  // and wrapping it would change its markup. `appearance` is fixed per instance, so the wrapper
  // never appears/disappears mid-capture (that would remount the armed button and kill capture).
  if (appearance !== 'icon') return btn
  return (
    <Tooltip label={capturing ? 'Press the new shortcut · Esc cancels' : (tooltip ?? effectiveLabel)}>
      {btn}
    </Tooltip>
  )
}
