# Live link Control — Plan 3 of 3: Viewer page (nodeterm-web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a Control link, a viewer can take control with a name and the password, type in the terminal (keyboard on phones too), release it, and see who is typing; an unlimited link shows no end time.

**Architecture:** Re-vendor the desktop's `src/shared/watch-link/` (which gained `watch:unlock`, `watch:input`, `watch:release`, `watch:control`, `watch:typing` and `expiresAt: null`). The controller (`controller.ts`) exposes `takeControl`, `sendInput`, `release` and reports control/typing events; a new `control-panel.ts` owns the Take control form and the typing line; `dom.ts` switches the xterm between read-only and typing. Mouse tracking stays swallowed; resize is never sent.

**Tech Stack:** Astro, TypeScript, @xterm/xterm 5.5 (+ unicode11 addon), vitest, jsdom; headless Chrome + CDP for the visual check.

**Spec:** `/root/nodeterm/wtshare/docs/superpowers/specs/2026-10-03-live-link-control-design.md` §2.3–§2.5, §3 (viewer page), §5.

**Plans in this series:** 1 = backend, 2 = desktop (its Task 2 commit is the protocol this plan vendors), 3 = this. Start only after Plan 2 Task 2 is committed and `feat/live-link-control` is pushed.

**Repo:** `/root/nodeterm-web-live` (eneskirca/nodeterm-web). New branch `feat/live-link-control` from `origin/main` (`dc557ff`). Never push `main`.

## Global Constraints

- The vendored directory `src/lib/watch-link/` is written ONLY by `scripts/vendor-watch-link.mjs` from the desktop's `src/shared/watch-link/` at a named commit; never edit it by hand (`vendored.test.ts` checks every hash).
- Client pacing: Take control at most once per 2.2 s (the host allows 1 per 2 s); input batched per animation frame, each `watch:input` ≤ 16384 UTF-16 code units (`INPUT_MAX`), split if longer.
- While controlling, the page's xterm has bracketed-paste mode ON (the page writes `\x1b[?2004h` into its own xterm and swallows a `\x1b[?2004l` from the stream), so every paste reaches the host framed and the host lets tmux frame it for the pane's real state.
- Never sent: resize, mouse, flow control. Mouse-tracking modes stay swallowed (`guardViewerTerminal`), so the page never produces mouse reports.
- The password lives only in the form's input and the one `unlock` call; it is never stored (no localStorage), never logged, cleared from the input on submit.
- Every string from the link (names, title, label) is set with `textContent`, never HTML. Typing names are claims: shown as "Mert is typing…", from `readTypingNames`.
- Viewer and Commenter links look and behave exactly as today.

## Review Focus

1. **A Control link opened by a viewer who never takes control**: identical to a Commenter link (chat works, no keyboard on a phone, stdin off).
2. **Losing control while typing** (owner turns typing off, password changed, kicked, link locked, reconnect): stdin goes off at once, the phone keyboard closes, buffered input is discarded, and the header says why.
3. **A reconnect** (relay drop, page restored from back/forward cache): the page is NOT controlling after it; the form is offered again with the name prefilled and the password empty.
4. **A huge paste** (1 MB): split into ≤ 16384-unit casts in order; the host's bucket may drop some, and the page shows the host's "Typing too fast" note once.
5. **`meta.expiresAt: null`**: the header shows no "ends in" text and no timer runs; an old desktop's numeric expiry still works.

---

## File Structure

- Re-vendor: `src/lib/watch-link/*` + `VENDORED.json` (script output).
- Modify: `src/lib/watch-viewer/controller.ts` (+ test), `src/lib/watch-viewer/dom.ts` (+ test), `src/lib/watch-viewer/terminal.ts` (+ test), `src/pages/s/[id].astro` (markup + CSS).
- Create: `src/lib/watch-viewer/control-panel.ts` (+ `control-panel.test.ts`), `src/lib/watch-viewer/input-batcher.ts` (+ test).

---

### Task 1: Re-vendor and the controller API

**Files:**
- Modify: `src/lib/watch-link/*` and `VENDORED.json` (via the script only), `src/lib/watch-viewer/controller.ts`, `src/lib/watch-viewer/controller.test.ts`, `src/lib/watch-viewer/dom.ts` (`remaining` only)
- Test: `controller.test.ts`, `dom.test.ts`, `vendored.test.ts`

**Interfaces:**
- Consumes (vendored, from desktop Plan 2 Task 2): `WATCH_EVENT.control`, `WATCH_EVENT.typing`, `WatchControlEvent`, `readControlEvent`, `readTypingNames`, `INPUT_MAX`, `PASSWORD_MAX`, `WatchMeta.expiresAt: number | null`, `WatchMeta.control?`, end reason `'attempts'`, `WatchClient.unlock/sendInput/release`.
- Produces:
  ```ts
  // controller.ts
  export const CONTROL_CLIENT_MIN_MS = 2200
  ViewerDeps += { onControl(ev: WatchControlEvent): void; onTyping(names: string[]): void }
  export type TakeControlResult = 'sent' | 'too-soon' | 'empty' | 'closed'
  startViewer(...) returns { sendChat; takeControl(name: string, password: string): TakeControlResult;
    sendInput(data: string): boolean; release(): boolean; stop(): void }
  PHASE_TEXT for { kind: 'ended', reason: 'attempts' } → 'Too many wrong passwords. Reload the page to try again.'
  // dom.ts
  export function remaining(expiresAt: number | null, now?: number): string   // null → ''
  ```

- [ ] **Step 1: Re-vendor**

Run: `node scripts/vendor-watch-link.mjs <path-to-/root/nodeterm/wtshare/src/shared/watch-link> <commit>` (read the script's usage first; pass the commit of desktop Plan 2 Task 2 on the pushed `feat/live-link-control`). Then `npx vitest run src/lib/watch-link/vendored.test.ts` → PASS. Commit the vendored files alone: `git commit -m "chore: re-vendor the live-link protocol (Control role, unlimited)"`.

- [ ] **Step 2: Failing controller tests** (`controller.test.ts`, using the file's fake client/socket helpers)

```ts
describe('control', () => {
  it('passes meta.control and watch:control to onControl', async () => {
    // a meta carrying control:{state:'available'} → onControl({state:'available'})
    // a watch:control {state:'controlling'} → onControl({state:'controlling'})
    // a watch:control {state:'bogus'} → not passed on
  })
  it('passes watch:typing names, sanitized', async () => {
    // {names:['Mert','a‮b']} → onTyping(['Mert','ab'])
  })
  it('takeControl paces, validates and sends', async () => {
    // '' name or '' password → 'empty'; a 129-char password → 'empty'; before open → 'closed';
    // ok → 'sent' and the fake client's unlock got (sanitized name, password); a second call within
    // CONTROL_CLIENT_MIN_MS → 'too-soon'
  })
  it('sendInput splits on INPUT_MAX and keeps order', async () => {
    // 'x'.repeat(INPUT_MAX * 2 + 5) → three client.sendInput calls of INPUT_MAX, INPUT_MAX, 5
  })
  it('a reconnect is not controlling: onControl from the new meta wins', async () => {
    // after a socket close + rejoin, the first event is the new meta's control state
  })
  it('names the attempts end', () => {
    expect(PHASE_TEXT({ kind: 'ended', reason: 'attempts' })).toMatch(/Too many wrong passwords/)
  })
})
```

Write each case fully against the file's existing fakes (they already capture `sendChat`; extend the fake `WatchClient` with `unlock`, `sendInput`, `release` recorders). In `dom.test.ts`: `remaining(null)` → `''`.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/lib/watch-viewer/controller.test.ts src/lib/watch-viewer/dom.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

In `onEvent`: after the meta handling, `const c = readControlEvent(p.control); if (c) deps.onControl(c)`; `WATCH_EVENT.control` → `readControlEvent(p)` → `onControl`; `WATCH_EVENT.typing` → `onTyping(readTypingNames(p))`. Extend the ended reasons with `'attempts'` (it arrives through `watch:end`). `takeControl`: trim name via `sanitizeChatName`, refuse empty/oversized, pace with `deps.now()`, `client.unlock(name, password)`. `sendInput`: split into `INPUT_MAX` slices (never split a surrogate pair: back off one unit when the slice ends on a high surrogate). `release`: `client.release()`. `remaining`: accept `null`.

- [ ] **Step 5: Run, typecheck, commit**

Run: `npx vitest run && npx astro check` (or the repo's typecheck script)
Expected: PASS.

```bash
git add src/lib/watch-viewer
git commit -m "feat(viewer): controller API for taking control, typing and the typing set"
```

---

### Task 2: Take control UI, typing and the typing line

**Files:**
- Create: `src/lib/watch-viewer/control-panel.ts`, `control-panel.test.ts`, `src/lib/watch-viewer/input-batcher.ts`, `input-batcher.test.ts`
- Modify: `src/lib/watch-viewer/dom.ts`, `src/lib/watch-viewer/terminal.ts`, `src/pages/s/[id].astro`, `dom.test.ts`, `terminal.test.ts`

**Interfaces:**
- Consumes: Task 1's `takeControl`, `sendInput`, `release`, `onControl`, `onTyping`, `NAME_KEY` from `chat-panel.ts` (the chat name prefills the control name).
- Produces:
  ```ts
  // control-panel.ts
  export function controlNote(ev: WatchControlEvent): string
  //   wrong → 'Wrong password.'  locked → 'Too many wrong passwords. The sharer has to allow control again.'
  //   off (reason off) → 'The sharer turned typing off.'  off (unsupported) → "This terminal can't be typed in from a link."
  //   too-soon → 'Wait a moment and try again.'  dropped → 'Typing too fast — some input was dropped.'
  export function typingLine(names: string[], me: string | null): string   // '' | 'Mert is typing…' | 'Mert and Ayşe are typing…' | 'Mert, Ayşe and 2 others are typing…' (excludes me)
  export interface ControlPanel { onControl(ev: WatchControlEvent): void; onTyping(names: string[]): void; reset(): void }
  export function mountControlPanel(doc: Document, deps: { take(name: string, pw: string): TakeControlResult;
    release(): void; setTyping(on: boolean): void; storage: Pick<Storage, 'getItem'> | null }): ControlPanel
  // input-batcher.ts
  export function createInputBatcher(o: { send(data: string): boolean; schedule(cb: () => void): unknown; cancel(h: unknown): void }):
    { push(data: string): void; clear(): void }
  // terminal.ts
  export function setTyping(term: Terminal, on: boolean): void   // stdin, keyboard, bracketed paste
  ```

**Behaviour:**
- Header (Control links only, i.e. `meta.control` present): a **Take control** button while `available`; the form (name prefilled from `localStorage[NAME_KEY]`, password `type="password"` `autocomplete="off"` maxlength 128, **Unlock**, Cancel) in a small popover under the header; on `controlling`: the button area shows "You can type" + **Release**; on `off`/`locked`: the button disabled with `controlNote`. A refused unlock shows `controlNote` under the form and keeps the form open (password cleared, name kept).
- `setTyping(term, true)`: `term.options.disableStdin = false`, undo `keepKeyboardClosed` (`readOnly = false`, remove `inputmode`), write `\x1b[?2004h` into the page's own xterm, focus the terminal. `setTyping(term, false)`: the reverse (`disableStdin = true`, `keepKeyboardClosed(term)`, blur). `guardViewerTerminal` gains a `?l` CSI handler that swallows a sequence made only of `2004` while typing is on (pass a getter), so the stream cannot switch the page's bracketed paste off.
- `term.onData(d)` → the batcher only while typing is on; the batcher concatenates within one animation frame (`requestAnimationFrame`) and calls `sendInput` once; `clear()` on losing control. xterm's own answers to queries (DA, CPR) ride `onData` too — the host drops them; do not filter them here.
- Typing line under the window bar (`#wv-typing`, `aria-live="polite"`), from `typingLine(names, myName)`.
- Losing control (any non-`controlling` `onControl` after `controlling`, a reconnect, an end): `setTyping(false)`, batcher `clear()`, show the note.
- Mobile: the form fits a 360 px wide screen; the keyboard opening must not hide the terminal's bottom line (the stage already fits to the visible area — check with a 390×844 viewport and a forced visual-viewport height).
- Markup and CSS in `src/pages/s/[id].astro`, matching the existing header style (no new fonts or colors outside the page's existing palette).

- [ ] **Step 1: Failing tests** — `control-panel.test.ts` (jsdom, build the page's markup from the astro file's relevant fragment or a hand-written equivalent with the same ids): every `controlNote` reason; `typingLine` variants and exclusion of the viewer's own name; the button/form/released states; a refused unlock keeps the name and clears the password; the password is never written to storage (spy on `setItem`). `input-batcher.test.ts`: three pushes in one frame → one send; `clear()` before the frame → no send; a send returning false is not retried. `terminal.test.ts`: `setTyping` toggles `disableStdin`, the textarea's `readOnly`/`inputmode`, and writes `\x1b[?2004h`; the `?2004l` swallow only while typing. `dom.test.ts`: a meta without `control` mounts no control button (Commenter link unchanged); `expiresAt: null` → no ends text.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/watch-viewer`
Expected: FAIL.

- [ ] **Step 3: Implement** as above.

- [ ] **Step 4: Visual check (headless Chrome + CDP)** against `npx astro dev --port 4399` (use `--force` if Vite answers 504 for an outdated dep), with the page driven by an injected fake socket the same way the earlier stage/chat screenshots were made (scratchpad scripts `shot.mjs`/`stage.mjs` are the pattern). Screenshots: Control link before taking control (desktop 1440×900 and phone 390×844), the form open, a wrong-password note, controlling with "Mert is typing…", typing turned off by the sharer. Look at each one; fix what is cramped, clipped or overlapping. Attach the screenshot paths in the report.

- [ ] **Step 5: Run, typecheck, commit**

Run: `npx vitest run && npx astro check && npm run build`
Expected: PASS.

```bash
git add src/lib/watch-viewer src/pages/s
git commit -m "feat(viewer): take control with a password, type, and see who is typing"
```

## After both tasks

Push `feat/live-link-control` and open the web PR (English, `pr-writing` skill): name the desktop commit the protocol was vendored from, the screenshots, and that a real end-to-end run against a desktop is owed (device checklist in the desktop repo's `docs/live-links.md`). Do not merge.
