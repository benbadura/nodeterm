import { IPC } from '../shared/ipc'
import {
  getEffectiveBindings,
  policyStandsDown,
  sanitizeKeybindingOverrides,
  type TerminalShortcutPolicy
} from '../shared/keybindings'
import { matchesShortcut } from '../shared/shortcut'

/**
 * The main window's `before-input-event` decision as ONE pure function — the desktop half of the
 * pair whose renderer half is `src/renderer/lib/zoomShortcut.ts` (same shape: a key-state-only
 * input, an action-or-null out, and the refusals as the point of the module).
 *
 * **Why the main process gets a say at all.** A menu accelerator is handled *before* the page sees
 * the key, so a renderer-side listener for one would simply never run on the desktop.
 * `before-input-event`'s `preventDefault` suppresses the menu item AND the page event, which is why
 * each claimed chord has to forward its intent to the renderer over IPC itself rather than letting
 * the key through. The three chords, and who claims them TODAY:
 *
 *   ⌘M → Window ▸ Minimize — a live accelerator on **every** platform (`{role:'minimize'}`).
 *   ⌘W → Window ▸ Close — a live accelerator on **Windows/Linux only**; the mac template has no
 *         `{role:'close'}`, so on macOS this module is now ⌘W's only handler.
 *   ⌘0 → not in any menu at all any more; this module is its only handler, which is exactly why
 *         the View menu's Fit View item deliberately carries NO accelerator.
 *
 * (This paragraph used to say "we never call `Menu.setApplicationMenu`, so Electron installs its
 * DEFAULT menu". That has been false since `buildAppMenu` landed in `index.ts`. The menu is OURS
 * now, so the list above is a fact about `buildAppMenu` — check it there, not against Electron's
 * defaults, and update this comment when you edit that template.)
 *
 * **Why it is pure and lives here rather than in the callback.** Deleting a branch from an inline
 * callback breaks nothing and throws nothing — the shortcut just quietly starts minimizing the
 * window / closing it / resetting the WINDOW's page zoom instead of doing the app's thing. Worse,
 * a modifier test here is what keeps a branch off ordinary typing, so loosening one silently makes
 * this window swallow **bare** keystrokes app-wide, and `index.ts` merges that kind of edit without
 * a conflict. Both failures are invisible to a test that reads the source; they are one assertion
 * each against this function.
 *
 * **This module stays the closed list of main-intercepted chords.** ⌘M and ⌘W are now resolved
 * from the keybinding registry (`node.toggleMarkdown` / `node.close`), so the USER decides which
 * chord they are — but nothing else is intercepted here, because everything else reaches the
 * renderer's dispatcher on its own. The **remappable** half of that list is ALSO written down in
 * `shared/keybindings.ts` as `MAIN_INTERCEPTED_COMMAND_IDS` (the Settings UI's app-wide shadow
 * warning reads it, and cannot derive it from here — main is not importable from the renderer);
 * a third REGISTRY-BACKED intercept added here owes that list an entry, which
 * `keydown-intercept.test.ts` pins. Note what that pin does NOT cover: a hardcoded ⌘0-shaped
 * intercept has no command id, so it cannot appear in the list and the invariant test cannot see
 * it — it would swallow its chord app-wide with the Settings recorder reporting no conflict. If
 * you add one, the Settings UI needs a separate way to know about it.
 *
 * Desktop-only by construction (it exists to fight a native menu), so it stays in `src/main` next
 * to `main-window.ts` rather than moving to `src/core` — the Server Edition's browser shell has no
 * application menu to steal a chord back from.
 */

/** What a claimed chord asks the renderer to do. */
export type KeydownInterceptAction = 'toggle-markdown' | 'close-node' | 'zoom-actual-size'

/** The subset of Electron's `Input` the decision is made from (so tests need no Electron). */
export interface KeydownInterceptInput {
  type: string
  key: string
  code: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
  /** OS auto-repeat: true on every keyDown after the first while the chord is HELD. */
  isAutoRepeat: boolean
}

/**
 * A claimed chord. `preventDefault` is implied by getting one of these at all — the key is ours,
 * so neither the menu nor the page may have it. `action` is separately nullable because a HELD ⌘0
 * must keep being swallowed (the menu is still listening) while forwarding nothing.
 */
export interface KeydownInterceptDecision {
  action: KeydownInterceptAction | null
}

/** The effective chords for the two REMAPPABLE commands this module intercepts. `readonly
 *  string[]` in shortcut.ts's canonical spelling; `[]` means the user unbound the command, which
 *  must read as "do not claim the key" — Electron's own menu item comes back. */
export interface KeydownInterceptBindings {
  closeNode: readonly string[]
  toggleMarkdown: readonly string[]
}

/**
 * Effective M/W chords from raw settings overrides (sanitized here so a hand-edited settings.json
 * cannot crash or hijack the intercept — this runs on the way to `before-input-event`, the one
 * code path where a throw eats every keystroke in the window).
 */
export function resolveInterceptBindings(
  rawOverrides: unknown,
  isMac: boolean
): KeydownInterceptBindings {
  const { overrides } = sanitizeKeybindingOverrides(rawOverrides, isMac)
  return {
    closeNode: getEffectiveBindings('node.close', overrides, isMac),
    toggleMarkdown: getEffectiveBindings('node.toggleMarkdown', overrides, isMac)
  }
}

/** Electron's `Input` flags in the shape `matchesShortcut` reads. */
function toShortcutEvent(input: KeydownInterceptInput): {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  key: string
} {
  return {
    metaKey: input.meta,
    ctrlKey: input.control,
    shiftKey: input.shift,
    altKey: input.alt,
    key: input.key
  }
}

/**
 * PURE. What this `before-input-event` input means, or `null` to leave the key completely alone
 * (no `preventDefault` — the page and, failing that, the menu get it).
 *
 * **Every branch owns its own modifier requirement, and must.** The old shared guard was
 * `type !== 'keyDown' || !(input.meta || input.control)`, which is exactly the check standing
 * between these branches and ordinary typing — `m`, `w` and `0` are all characters a user types.
 * It could not survive user-remappable bindings: an Alt-only chord is VALID per the registry's
 * rules, and this module is its ONLY dispatcher (a chord we claim never reaches the renderer),
 * so a primary-modifier gate above the matchers would make such a remap silently dead everywhere.
 * Who that actually buys something for: **Windows/Linux Alt chords** (`Alt+M`, `Alt+W` — plain
 * letter combos there), and on **macOS the Alt+non-letter ones** (`Alt+F5`, `Alt+ArrowUp`). It is
 * NOT mac Option+letter: macOS composes those into a character, so ⌥M arrives as `key: 'µ'` and an
 * `Alt+M` binding could never match there whatever this gate did.
 * So the two remappable chords are matched EXACTLY (all four modifier flags, `matchesShortcut`),
 * which is a modifier requirement per binding, and the hardcoded `Digit0` branch below carries
 * the `meta || control` test it used to inherit. `keydown-intercept.test.ts` presses each of them
 * bare; keep it that way.
 */
export function keydownIntercept(
  input: KeydownInterceptInput,
  bindings: KeydownInterceptBindings,
  isMac: boolean
): KeydownInterceptDecision | null {
  if (input.type !== 'keyDown') return null
  // Matched against the user's effective bindings (defaults ⌘M / ⌘W). `matchesShortcut` is exact
  // on meta/ctrl/alt/shift, so ⌘⇧M and ⌘⌥M — which the old `key === 'm'` branch also swallowed —
  // are now different chords and go back to the page. Parsing is memoized in shortcut.ts, so this
  // stays cheap on main's input path.
  const ev = toShortcutEvent(input)
  if (bindings.toggleMarkdown.some((s) => matchesShortcut(ev, s, isMac))) {
    // A held chord is still CLAIMED (the menu's Minimize owns this accelerator, so letting a
    // repeat through would minimize the window mid-hold) but forwards nothing: one press, one
    // toggle — the rule the Server Edition's browser listener (`markdown-toggle-key.ts`) applies
    // too, and the same shape as the held ⌘0 below.
    return { action: input.isAutoRepeat ? null : 'toggle-markdown' }
  }
  // Repurpose Cmd/Ctrl+W: the renderer closes the selected node(s); if none are selected it asks
  // us to close the window (the standard behavior). ⇧ is left to the menu's Close All Windows —
  // now by the binding being `Cmd+W` and the match being exact, rather than by a `!input.shift`.
  if (bindings.closeNode.some((s) => matchesShortcut(ev, s, isMac))) {
    return { action: 'close-node' }
  }
  // NOT remappable: this is the renderer's `zoomShortcutChord` half of a canvas gesture, not a
  // registry command. Matched on the physical `code`, like that half: on a non-US layout the zero
  // key's `key` is not necessarily "0". Alt is excluded because AltGr reports as ctrl+alt and must
  // keep typing a real character; `meta || control` is the primary-modifier test it used to
  // inherit from the shared guard, and without it every bare `0` in the app is swallowed (#193).
  if (input.code === 'Digit0' && (input.meta || input.control) && !input.shift && !input.alt) {
    // Auto-repeat is dropped here rather than in the renderer, so a held chord cannot restart the
    // 200ms zoom tween — the same rule `zoomShortcutChord` applies to the keydown path. Still
    // claimed, so a held ⌘0 does not fall through to `resetZoom` on the second repeat.
    return { action: input.isAutoRepeat ? null : 'zoom-actual-size' }
  }
  return null
}

/**
 * PURE. Does this `did-start-navigation` mean the page that armed a shortcut recorder is going
 * away, so the recording bit must be cleared?
 *
 * **Why the bit needs a navigation leg at all.** The recording bit is GLOBAL and lives in the main
 * process, so every way the renderer can stop existing owes it a release. Window `closed` and
 * `render-process-gone` cover two of them. The third is a **reload** — and the app's own View menu
 * restores `{role:'reload'}` / `{role:'forceReload'}`, whose ⌘R/⌘⇧R are ACCELERATORS: they are
 * handled above the page, so the recorder's `preventDefault` cannot stop a user from pressing one
 * while armed. That reload fires no React unmount, no `closed` and no `render-process-gone`; the
 * new page mounts no recorder, and the bit would stay true forever — ⌘W/⌘M/⌘0 dead app-wide with
 * nothing left alive to clear them.
 *
 * The two filters are both refusals, and both matter:
 * - `isSameDocument` (Electron's newer name for the old `isInPlace`) is a `pushState`, a
 *   `replaceState` or a fragment jump — the SAME page, with the recorder still mounted and still
 *   armed. Clearing there would re-arm the intercepts under a live recorder, i.e. re-open the very
 *   bug this feature closes.
 * - A subframe navigating is not this page going away either.
 */
export function navigationClearsRecording(details: {
  isMainFrame: boolean
  isSameDocument: boolean
}): boolean {
  return details.isMainFrame && !details.isSameDocument
}

// `policyStandsDown` moved to `shared/keybindings.ts` (with its full rationale) so the Server
// Edition's browser-side ⌘M listener (`renderer/bridge/markdown-toggle-key.ts`) applies the SAME
// predicate — main is not importable from the renderer. Re-exported so this module stays the one
// place `index.ts` and its tests import the intercept pieces from.
export { policyStandsDown }

/**
 * PURE. The CLOSE leg's extra stand-down, applied REGARDLESS of the policy (issue #383): off-mac,
 * `node.close`'s default chord is Ctrl+W — which is readline's kill-word in every shell — so a
 * keystroke typed into a FOCUSED terminal must reach the pty, not close the node/window out from
 * under the user (with no reopen affordance once the last window goes). The narrow shape is the
 * point:
 * - **mac is untouched**: ⌘W is not a shell key, and closing the focused terminal's node with it
 *   is the behavior mac users expect.
 * - **Only the close leg**: ⌘/Ctrl+M and ⌘/Ctrl+0 stay claimed under app-first exactly as before —
 *   this is not a policy change, it is one chord whose terminal meaning outranks its app meaning.
 * - **Only while a terminal has focus** (the same fail-safe mirror the policy leg reads: a dead
 *   report resolves to "not focused" = close works).
 * Closing while typing off-mac: click the node's ×, or focus away first. Both the intercept branch
 * and the Window ▸ Close menu item (whose role owns the Ctrl+W accelerator above the page) consult
 * THIS predicate — one definition, two consumers, per the house rule.
 */
export function closeStandsDownInTerminal(isMac: boolean, terminalFocused: boolean): boolean {
  return !isMac && terminalFocused
}

/**
 * PURE. The MENU leg's composed stand-down state: `index.ts`'s `syncMenuForStandDown` disables
 * `menuItemIdsToSuspend` for exactly as long as this is true.
 *
 * **The menu ORs the two suspensions; the INTERCEPTS do not.** `installKeydownIntercepts` keeps
 * `isRecording` and `isStoodDown` as separate parameters on purpose (unrelated reasons, unrelated
 * schedules — see its doc), and that stays. But a menu item is enabled or it is not: both reasons
 * want the same items suspended, and one boolean is the honest shape for a single `enabled` write.
 *
 * `menuStandsDown(false, …)` is `policyStandsDown(…)` by construction, which is the byte-identical
 * guarantee for every user who never arms the Settings recorder.
 */
export function menuStandsDown(
  recording: boolean,
  policy: TerminalShortcutPolicy,
  terminalFocused: boolean
): boolean {
  return recording || policyStandsDown(policy, terminalFocused)
}

/**
 * Menu item ids `buildAppMenu` stamps on the items whose ACCELERATORS survive an intercept
 * stand-down. Exported constants used by both sides — the template that sets them and the sync that
 * looks them up — because `getMenuItemById` answers `null` for a typo and the fail-safe there is to
 * do nothing, which is indistinguishable from the feature working.
 */
export const MENU_ITEM_ID_MINIMIZE = 'window-minimize'
export const MENU_ITEM_ID_CLOSE = 'window-close'
/** View ▸ Toggle Kanban Board (⌘⇧B). In `viewSubmenu`, which BOTH templates include. */
export const MENU_ITEM_ID_KANBAN = 'view-kanban-toggle'
/** The Settings item (⌘,) — mac's app menu, off-mac's own `Settings` menu; ONE `settingsItem`
 *  object shared by both templates, so the id exists on every platform. */
export const MENU_ITEM_ID_SETTINGS = 'app-settings'

/**
 * PURE. Which menu items must be disabled while the intercepts are stood down.
 *
 * **Why the stand-down needs a menu leg at all.** `preventDefault` is the only lever this module
 * has, and NOT calling it hands the key to the page *and*, if the page ignores it, to the menu —
 * whose accelerators are handled above the page either way. So a stand-down that stopped at the
 * intercept would deliver ⌘0 and (on macOS) ⌘W to the terminal, and hand ⌘M to
 * `{role:'minimize'}` and, on Windows/Linux, Ctrl+W to `{role:'close'}`. For a terminal-first user
 * that is strictly WORSE than not having the policy: Ctrl+W is readline's kill-word, and a Linux
 * user pressing it would close their window. Disabling the item suppresses its accelerator, so the
 * chord falls through to the page → the renderer's dispatcher (terminal context, terminal-first:
 * nothing matches) → xterm → the PTY. That is what completes "under terminal-first everything
 * reaches the shell", ⌘M included.
 *
 * **The list serves BOTH stand-downs** — the policy one above and an armed shortcut recorder
 * (`menuStandsDown` composes them; `syncMenuForStandDown` disables these items for either). The
 * earlier argument here was that a recorder greying out Minimize was a worse trade than an
 * unrecordable ⌘M; that trade REVERSED once the menu leg existed for the policy anyway. The cost is
 * now a momentary grey-out while a modal recorder is armed — self-healing the instant it disarms —
 * and the benefit is that four chords now REACH the recorder instead of acting on the app: ⌘M
 * everywhere, off-mac Ctrl+W, and ⌘⇧B / ⌘, which did not merely fail to record but FIRED —
 * pressing ⌘⇧B into the recorder opened the kanban board behind the Settings dialog, and ⌘,
 * re-opened Settings. **Reaching the recorder is all this buys, and it is the unconditional part.**
 * Whether the chord can then be BOUND is a separate question, answered by the pre-save gates in
 * `ShortcutsSection.commitCandidate`: while its owning command still holds it, it is refused there
 * like any other taken chord — the user has to Disable or remap that command first.
 *
 * **KNOWN GAP for the recording half, pre-existing and accepted.** This list was written for the
 * POLICY stand-down, so it covers only the command-style items that policy needed. The always-on
 * app roles — `{role:'quit'}` (⌘Q), `{role:'hide'}`/`hideOthers`, `toggleDevTools`,
 * `togglefullscreen` — are NOT here, so those chords still ACT while a recorder is armed (⌘Q quits
 * the app). Adding them is refused rather than overlooked: ONE list drives both stand-downs, so
 * they would also go dead for a terminal-first user with a terminal focused, and quit/hide must
 * never be policy-gated. Closing it properly means splitting the list per stand-down.
 *
 * mac carries no CLOSE id: the mac template has no `{role:'close'}` at all (Window ▸ Minimize /
 * Zoom / Front), which is exactly why `keydownIntercept` is ⌘W's only handler there. Kanban and
 * Settings are on BOTH platforms — one `viewSubmenu` array and one `settingsItem` object are shared
 * by the two templates — so they are suspended on both.
 *
 * **What suspending kanban/settings actually buys, since neither is an intercepted chord.** ⌘⇧B and
 * ⌘, are ordinary REGISTRY commands (`view.kanbanToggle` / `app.settings`); the renderer's
 * dispatcher would resolve them if it ever saw the keydown, but under app-first the MENU takes them
 * above the page and the dispatcher never runs. Disabling the items removes that theft, so under
 * terminal-first with a terminal focused the chord reaches the page → the resolver, which REFUSES
 * it (a terminal context under terminal-first matches only commands flagged `allowInTerminal`, and
 * that flag is app-first-only) → xterm → the PTY. Without these two ids, terminal-first would
 * deliver every chord to the shell EXCEPT the two the menu happened to own, which is the same
 * inconsistency the minimize/close leg exists to remove.
 *
 * **RELOAD (⌘R / ⌘⇧R) is deliberately NOT here — named exception, do not "complete" the list.**
 * `{role:'reload'}` / `{role:'forceReload'}` are the app's crash-recovery lever: a renderer wedged
 * badly enough to stop dispatching keys is exactly when the user needs them, and a policy that
 * suspended them would take the lever away precisely in the state that calls for it. The recovery
 * also depends on the reload actually happening in MAIN — a main-frame navigation is one of the
 * three sites that reset `terminalFocused`/`shortcutRecording` (see `navigationClearsRecording`),
 * so suspending reload would strand the very bits a stuck page leaves set. The cost is honest and
 * small: a terminal-first user's ⌘R reloads the window instead of reaching the shell.
 */
export function menuItemIdsToSuspend(isMac: boolean): string[] {
  const shared = [MENU_ITEM_ID_MINIMIZE, MENU_ITEM_ID_KANBAN, MENU_ITEM_ID_SETTINGS]
  return isMac ? shared : [...shared, MENU_ITEM_ID_CLOSE]
}

/** The renderer channel a claimed action is forwarded on. */
export function keydownInterceptChannel(action: KeydownInterceptAction): string {
  if (action === 'toggle-markdown') return IPC.appToggleMarkdown
  if (action === 'close-node') return IPC.appCloseNode
  return IPC.appZoomActualSize
}

/** Structural view of the window this installs on (keeps the module Electron-free, like
 *  `main-window.ts`). */
export interface KeydownInterceptTarget {
  webContents: {
    on(
      event: 'before-input-event',
      listener: (event: { preventDefault(): void }, input: KeydownInterceptInput) => void
    ): void
    send(channel: string, ...args: unknown[]): void
  }
}

/**
 * Wire `keydownIntercept` to `win`. The whole side-effecting half is these four lines, so a test
 * that calls this with a fake window exercises registration, the refusal, the `preventDefault` and
 * the forwarded channel together — everything except the single call site in `index.ts`.
 *
 * `getBindings` is read per event rather than captured: settings change while the window lives, and
 * it returns a cached object (`index.ts` recomputes it on `settingsStore.onChange`, not here — a
 * sanitize per keystroke would be real work on the input path).
 *
 * `isRecording` is the same shape and for the same reason — the renderer flips it over IPC while
 * this window is alive. **It is checked BEFORE `preventDefault`, not before the send**: a chord
 * THIS MODULE claims never reaches the page at all, so while the Settings shortcut recorder is
 * armed, leaving the key completely alone is the only way the recorder can see it. Swallowing but
 * not forwarding would still hand the recorder nothing — and forwarding is the live bug, since ⌘W
 * pressed into the recorder deletes the canvas's selected nodes.
 *
 * **What this stand-down buys on its own, and what the MENU leg adds.** This half only stops US
 * from taking the key; it has no say over the application MENU, whose accelerators are handled
 * above the page either way — so by itself it delivers **⌘0** everywhere and **⌘W on macOS**
 * (neither is in the menu) and nothing else. **The menu now follows recording too**:
 * `index.ts`'s `syncMenuForStandDown` asks `menuStandsDown(recording, policy, terminalFocused)`
 * and disables every item in `menuItemIdsToSuspend` while a recorder is armed, so the suspended
 * items' chords — **⌘M** (`{role:'minimize'}`, every platform), **⌘⇧B** and **⌘,** (View ▸ Toggle
 * Kanban Board and Settings, every platform) and **Ctrl+W** on Windows/Linux — reach the recorder
 * instead of minimizing the window, opening the board or opening Settings. **RELOAD (⌘R / ⌘⇧R)
 * stays unrecordable by design**: it is the app's crash-recovery lever and is deliberately absent
 * from that list (see `menuItemIdsToSuspend`).
 *
 * `isStoodDown` is the SECOND suspension and the same shape again, but a different fact:
 * `policyStandsDown(policy, terminalFocused)` — the user chose `terminal-first` AND an xterm
 * currently holds keyboard focus in the renderer. It is a separate parameter rather than an `||`
 * folded into `isRecording` because the two suspend for unrelated reasons on unrelated schedules
 * (a Settings dialog being armed vs. a live focus mirror), and one boolean would make "the
 * recorder still works for an app-first user" — the overwhelmingly common case — impossible to
 * assert. Both are checked BEFORE `preventDefault` for the same reason: a claimed chord never
 * reaches the page at all, and the page is exactly who terminal-first stands down FOR.
 *
 * **The menu leg is SHARED by the two suspensions, on the same item list.** `index.ts`'s
 * `syncMenuForStandDown` disables every item in `menuItemIdsToSuspend` below —
 * `{role:'minimize'}`, Toggle Kanban Board and Settings on all platforms, plus off-mac
 * `{role:'close'}`, with RELOAD deliberately left out — for exactly as long as
 * `menuStandsDown(recording, policy, terminalFocused)` is true. The policy half has to have it:
 * not calling `preventDefault` hands the key to the page and, failing that, to the menu, so
 * without the menu leg a terminal-first user's ⌘M would minimize the window and their Ctrl+W —
 * readline's kill-word — would CLOSE it on Windows/Linux, which is strictly worse than not having
 * the policy. With the items disabled the chord completes the trip it was promised: page → the
 * renderer's dispatcher (terminal context, terminal-first, nothing matches) → xterm → the PTY.
 * The recording half rides the same list for a different destination: page → the armed recorder.
 * That the ITEM list is shared does not merge the two INTERCEPT thunks — they stay independent
 * parameters below, and only the menu's single `enabled` boolean composes them.
 *
 * **The stand-down leg cannot be more reliable than the mirror behind it**, and the mirror is a
 * renderer reporting over fire-and-forget IPC. Every uncertainty therefore resolves to NOT stood
 * down (intercepts on = the pre-feature app): `index.ts` starts `terminalFocused` false and every
 * way the page can stop existing resets it there. Getting that direction backwards would leave ⌘W
 * and ⌘M with the application MENU — closing and minimizing the window — with no live component
 * able to correct it.
 */
export function installKeydownIntercepts(
  win: KeydownInterceptTarget,
  getBindings: () => KeydownInterceptBindings,
  isMac: boolean,
  isRecording: () => boolean,
  isStoodDown: () => boolean,
  // The close leg's OWN stand-down (`closeStandsDownInTerminal` — off-mac + terminal focused,
  // policy-independent). Defaults to "never" so every pre-#383 caller and test is byte-identical.
  isCloseSuspended: () => boolean = () => false
): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (isRecording() || isStoodDown()) return
    const decision = keydownIntercept(input, getBindings(), isMac)
    if (!decision) return
    // Checked AFTER resolution and only for close: the chord must fall through UNTOUCHED (no
    // preventDefault) so it reaches the page → xterm → the pty as readline's kill-word. The menu
    // leg is suspended in the same states (syncMenuForStandDown), so nothing above the page takes
    // it either.
    if (decision.action === 'close-node' && isCloseSuspended()) return
    event.preventDefault()
    if (!decision.action) return
    // ⌘0 carries its modifiers (issue #915 review): the renderer reads them to decide whether the
    // chord is the platform's terminal-font reset (⌘ on mac, Ctrl elsewhere — never both) before
    // falling back to canvas zoom-to-100%. The decision above accepts `meta || control`, so without
    // them a mac Ctrl+0 was indistinguishable from ⌘0 there.
    if (decision.action === 'zoom-actual-size') {
      win.webContents.send(keydownInterceptChannel(decision.action), {
        meta: input.meta,
        control: input.control
      })
      return
    }
    win.webContents.send(keydownInterceptChannel(decision.action))
  })
}
