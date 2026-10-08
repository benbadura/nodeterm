# Live link Control — Plan 2 of 3: Desktop and core (nodeterm) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live link can be a **Control** link: whoever has the link AND the password can type in that one terminal, several people at once under self-chosen names; a link can have no end time; and the owner follows and answers the live chat in a right-side drawer.

**Architecture:** The viewer protocol gains three casts (`watch:unlock`, `watch:input`, `watch:release`) and two events (`watch:control`, `watch:typing`); the relay watcher policy admits the three casts for the `controller` role only. Whether a viewer is *controlling* is the link host's per-connection state, set by a password check (scrypt hash in the link record, throttled host-side). Typed bytes are delivered to the node's PANE by a new PtyManager primitive (`controlInput`) that never goes through a tmux client's key table (keys: `send-keys -H` read by `tmux source-file -` from stdin; pastes: the existing `paste-buffer -p` plan with an exact target). The owner gets new IPC verbs (control on/off, change password, allow again), notices, and a Live chat drawer built on the Explorer drawer's pin pattern.

**Tech Stack:** TypeScript, Electron 42, React 18, zustand, vitest 2, node-pty, tmux ≥ 3.2 (3.4 on this host; 3.7b bundled on macOS), Node `crypto.scrypt`, tweetnacl (vendored protocol).

**Spec:** `docs/superpowers/specs/2026-10-03-live-link-control-design.md` (this repo). It builds on `docs/superpowers/specs/2026-09-28-live-share-link-design.md` and `docs/live-links.md`; read the spec's §2 before any task.

**Plans in this series:** 1 = `2026-10-03-live-link-control-1-backend.md` (deploy first), 2 = this, 3 = `2026-10-03-live-link-control-3-web.md` (re-vendors Task 2's protocol).

**Repo/branch:** `/root/nodeterm/wtshare`, branch `feat/live-link-control` (already holds the spec). Never push `main`. `/root/nodeterm` itself is edited live by other sessions — work only in this worktree.

**A fact sheet** of the existing live-link code (file:line, signatures) is at `/var/tmp/claude/claude-0/-root-nodeterm-wtshare/6ed3e88a-c1aa-49b2-9dc5-2c8617c29717/scratchpad/desktop-facts.md`. Line numbers there date from `faba46682`; re-locate before editing.

## Global Constraints

- Role values: `WatchLinkRole = 'viewer' | 'commenter' | 'controller'`; UI names Viewer / Commenter / **Control**. A Control link is a Commenter link plus typing for those who unlock it.
- Password: required for Control; typed 8–128 characters (code points), no C0/C1 control characters; **Generate** = 16 characters from `0123456789abcdefghjkmnpqrstvwxyz` (32 symbols, 80 bits). Shown once in the dialog's done step; never in the URL; never logged, echoed or kept after comparison.
- Hash: scrypt N = 2^15 (32768), r = 8, p = 1, 16-byte random salt, 32-byte key, `maxmem` 64 MiB, compared with `crypto.timingSafeEqual`. Only `{salt, hash}` (base64) is stored.
- Unlock throttles, all host-side: 1 attempt per 2 s per viewer; 3 wrong per connection ends that connection (end reason `attempts`); 10 wrong across the link locks control (lock persisted; the count is in memory). Only the owner clears it (**Allow control again**).
- Input: cast `watch:input` `{ data }`, `data` a string of ≤ 16384 UTF-16 code units; refused unless the sender is controlling and control is on (a refusal is a policy breach that closes the connection); `isTerminalReport` answers dropped; per viewer 64 KiB/s with 256 KiB burst, over budget dropped and the viewer told at most once per 10 s; batched ~20 ms.
- Delivery to the PANE only, never into a tmux client (owner's or watcher's): the tmux prefix must never reach tmux. tmux local and SSH: pane delivery. Windows session host, native Windows pane and plain shell: PtyManager's ordinary write path. Zellij: control refused.
- Never sent from a viewer: resize, mouse, flow control.
- Typing set: names with input in the last 4 s; `watch:typing { names }` to every joined viewer on change, at most once a second.
- Unlimited: wire `ttlSeconds: 0`, `expiresAt: null`; no expiry timer; UI "No end time"; dialog note "This link works until you stop it."; a `400 bad_ttl` from the backend for `0` maps to the error `ttl-unsupported` ("Unlimited links need a newer server").
- Owner notification on every successful unlock (OS notification under the existing agent-notification consent, plus the info strip); no OS notification per chat message.
- Base-spec invariants stay: `watchLink:*` host-only; watchers never go through `decideAccess`; watchers quiet and self-paced; stream filter and keyframes unchanged; a viewer sizes nothing; node-gone tri-state; no canvas-control verb touches links.
- `src/shared/watch-link/` is vendored byte for byte into nodeterm-web: sibling imports and `tweetnacl` only, type imports as `import type` (`isomorphism.guard.test.ts`).
- No credential in argv anywhere: typed bytes (which may carry a password typed into the shell) and the link password never appear on a command line, local or SSH.
- Full suite only with an isolated HOME: `HOME=$(mktemp -d -p /var/tmp) TMPDIR=/var/tmp npx vitest run`. Focused files: `npx vitest run <paths>`. Typecheck: `npm run typecheck`.

## Review Focus

1. **A controller whose watched session changes under it** (owner attaches or detaches, the watcher client is replaced, a rejoin) stays controlling, and its next input goes to the NEW session id — never to a session it left.
2. **Input from a controller with no session yet** (waiting on Windows, mid-rejoin) is dropped with one `dropped` notice, not queued without bound and not delivered later into whatever session appears.
3. **Control turned off, password changed, link locked, or the viewer kicked while a batch is pending**: nothing from that viewer is delivered after the change (the flush re-checks `controlling` and control state).
4. **Two controllers typing at once on one node**: each batch is delivered whole and in flush order; one controller's paste is never split by another's keys.
5. **An unlimited record that the keychain cannot unseal** (opaque entry): carried on every write, counted toward the 5-per-machine cap, never pruned by time, discarded only by the existing discard path.

---

## File Structure

New:
- `src/core/watch-link/pane-input.ts` — pure builders for pane delivery (keys via `source-file -`, pastes via the paste plan, exact targets) + `ControlInputChunk`.
- `src/core/watch-link/pane-input.test.ts`, `src/core/watch-link/pane-input.realtmux.test.ts`.
- `src/core/watch-link/password.ts` (+ test) — scrypt hash and verify.
- `src/core/watch-link/control-input.ts` (+ test) — the stateful splitter (keys vs bracketed paste) and the typing tracker.
- `src/shared/watch-link-password.ts` (+ test) — generator and validator shared by renderer and core (NOT in the vendored dir).
- `src/renderer/lib/liveChatPin.ts` (+ test), `src/renderer/components/LiveChatDrawer.tsx` (+ test).

Modified (main ones): `src/core/pty-manager.ts`, `src/shared/watch-link/protocol.ts`, `src/shared/watch-link/client.ts`, `src/shared/watch-link-types.ts`, `src/shared/ipc.ts`, `src/core/watch-link/{watcher-policy,link-host,store,service,api,pty-seam}.ts`, `src/main/index.ts`, `src/server/index.ts`, `src/preload/index.ts`, `src/renderer/bridge/{stubs,ws-bridge}.ts`, `src/renderer/state/watchLinks.ts`, `src/renderer/lib/liveLink.ts`, `src/renderer/components/{LiveLinkDialog,LiveLinkPopover,LiveLinkChip}.tsx`, `src/renderer/canvas/Canvas.tsx`, `src/renderer/styles.css`, `docs/live-links.md`, `CLAUDE.md`.

---

### Task 1: Pane input delivery (spike on real tmux, then the primitive)

**Files:**
- Create: `src/core/watch-link/pane-input.ts`, `src/core/watch-link/pane-input.test.ts`, `src/core/watch-link/pane-input.realtmux.test.ts`
- Modify: `src/core/pty-manager.ts` (three public methods, a per-session chain)
- Test: the two new test files, plus a case in an existing PtyManager test file of your choice for routing

**Interfaces:**
- Consumes: `isSessionName`, `sessionName`, `TMUX_SOCKET`, `sanitizePasteText`, `pasteBufferName` (`src/core/tmux-naming.ts`); `RMT_TMUX_SOCKET`, `childArgs`, `tmuxCmd` (`src/core/remote-ssh/control-master.ts` — export what is private if needed); module-private `runWithStdin` and `findSsh` in pty-manager.ts.
- Produces (later tasks rely on these exact names):
  ```ts
  // src/core/watch-link/pane-input.ts
  export type ControlInputChunk = { kind: 'keys'; data: string } | { kind: 'paste'; text: string }
  export const KEYS_PER_COMMAND = 1024           // bytes per send-keys line
  export function exactPaneTarget(session: string): string            // '=nt-x:' ; throws if !isSessionName
  export function keysCommandText(session: string, data: string): string // the stdin of `tmux source-file -`
  export function localKeysArgs(socket: string): string[]              // ['-L', socket, 'source-file', '-']
  export function localPasteArgs(socket: string, session: string, buffer: string): string[]
  export type WatcherInputRoute = 'tmux' | 'ssh' | 'write' | 'none'   // defined HERE (link-host imports it from pane-input, not from pty-manager)
  // src/core/pty-manager.ts (public)
  watcherInputRoute(sessionId: string): WatcherInputRoute
  controlInput(sessionId: string, chunk: ControlInputChunk): Promise<boolean>
  nodeControlSupport(persistKey: string): 'ok' | 'unsupported' | 'unknown'
  ```

**Why this task comes first.** The spec's candidate (`paste-buffer -r` for everything) cannot work on the tmux macOS ships: since tmux 3.7, `paste-buffer` passes buffer CONTENT through vis(3), so every ESC byte arrives as the two characters `^[` (CLAUDE.md, "DELETED: assertFramedPayload", issue #453). Arrow keys, Esc, Alt-keys would all arrive as text. The expected design instead (to be measured, not assumed):
- **keys** → `tmux -L <socket> source-file -` with stdin
  ```
  if-shell -F -t =nt-x: '#{pane_in_mode}' 'copy-mode -q -t =nt-x:'
  send-keys -t =nt-x: -H 1b 5b 41
  ```
  `send-keys -H` injects each byte as `KEYC_LITERAL`, which tmux's `input_key` writes to the pane as that exact byte, with no key-table lookup and no re-encoding (this is how the existing `backgroundWrite` already types, `encodeSendKeysHex` in `src/core/tmux-control.ts`). `source-file -` keeps the bytes off every command line. The mode cancel matters: `send-keys` into a pane in a mode with a key table DISPATCHES that table's bindings (copy mode), and tree mode (`C-b s` opened by the owner) handles keys itself.
- **paste** → the existing paste plan shape (`load-buffer -b B -` from stdin `;` mode cancel `;` `paste-buffer -d -p -r -b B -t =nt-x:`) with content `sanitizePasteText`-ed, so tmux frames it only when the pane's app asked for bracketed paste. No Enter.

- [ ] **Step 1: The spike (measure, record, decide) — no production code yet**

Build tmux 3.7b for the measurement: download `https://github.com/tmux/tmux/releases/download/3.7b/tmux-3.7b.tar.gz`, check its sha256 equals `87f2e99e3b685973f2ca002ffd6ed7e51a5744f7009daae5a15670b6d532db96` (the pin in `scripts/build-tmux.mjs`), `./configure && make` under `/var/tmp/tmux-3.7b` (libevent-dev, libncurses-dev and bison are installed). If the download or build fails, measure on 3.4 only and say so in the report; 3.7b then becomes a device-checklist item.

For EACH of `/usr/bin/tmux` (3.4) and the built 3.7b, on a PRIVATE socket and a private `TMUX_TMPDIR` under `/var/tmp` (never `-L node-terminal` or `-L nodeterm-rmt` — those hold enes's live terminals), with a generated minimal conf (`-f /dev/null` plus `set -g prefix C-b`), measure and write down:
1. **Bytes exact.** Pane runs `stty raw -echo; head -c <N> | od -An -tx1 > out.txt`. Deliver via the keys plan: all 256 byte values in order (in four batches), `ESC [ A`, `ESC O A`, `\r`, `\x03`, `\x7f`, UTF-8 `ç`, `漢`, `🙂` and `é`. `out.txt` must equal the input bytes exactly.
2. **Prefix inert.** With a second (real, interactive-style) client attached to the same session via `script -q /dev/null tmux -L … attach` or a node-pty client, deliver bytes `02 73` (`C-b s`) through the keys plan; then `display -p -t =<s>: '#{pane_in_mode}'` must print `0` and the pane's reader must have received `02 73`.
3. **Mode cancel.** Put the pane in copy mode (`copy-mode -t =<s>:`), deliver `61`; the pane must leave copy mode and receive `61`. Then open tree mode on the attached client (`choose-tree -t =<s>:`), deliver `61`; the tree must be gone and no session switched or killed. Confirm `copy-mode -q` exists on both versions (it is 3.2+).
4. **Paste framing.** Pane runs a reader that first prints `\e[?2004h` (bash with bracketed paste on, or `printf '\e[?2004h'; head -c …`): a paste-plan delivery of `a\nb` must arrive as `ESC[200~a\nbESC[201~` (a `\n` stays `\n` with `-r`). Without the `?2004h`, it arrives as `a\nb`. ESC inside paste text is stripped by `sanitizePasteText` before it ever reaches tmux — confirm a paste containing ESC arrives without it.
5. **Exact target.** Create `nt-a-1` and `nt-a-12`, deliver to `=nt-a-1:` only — only that pane receives it; delivering to a missing `=nt-a-9:` fails (non-zero exit) and touches neither.
6. **Big chunk.** 16384 bytes in one `source-file -` (16 `send-keys` lines of 1024 bytes) arrive exactly; time it.
7. **Latency.** Median and p95 of 50 single-byte deliveries (spawn → bytes in `out.txt`).
8. **SSH (best effort).** If `ssh localhost` works for root on this host with a key, run 1, 2 and 7 through `ssh -o ControlMaster=auto -o ControlPath=… localhost 'tmux -L <private> source-file -'` with stdin; add 50 ms RTT with a local delay proxy if feasible (e.g. `socat` + `tc` is not available — skip the RTT if there is no simple way, and say so). Never touch the real `~/.ssh/config`.

Put the measuring script in the scratchpad, not the repo. Record the results table in the report AND as the header comment of `pane-input.ts` (version, what was measured, numbers). **Decision rule:** if the expected design passes 1–6 on both versions, proceed. If anything fails, pick another mechanism that meets the requirement ("arbitrary bytes reach the pane exactly, no key binding and no client involved, no payload in argv"), record why in the header and the report, and keep the interfaces above (the rest of the plan depends on the names, not on the mechanism). If no mechanism meets it, STOP and report BLOCKED with the measurements.

- [ ] **Step 2: Write the failing unit tests for the pure builders** (`pane-input.test.ts`)

```ts
import { describe, expect, it } from 'vitest'
import { exactPaneTarget, keysCommandText, localKeysArgs, localPasteArgs, KEYS_PER_COMMAND } from './pane-input'

describe('pane input builders', () => {
  it('targets the session exactly, never a prefix', () => {
    expect(exactPaneTarget('nt-abc')).toBe('=nt-abc:')
    for (const bad of ['', 'nt abc', 'nt-a;b', "nt-a'b", '=nt-a', 'nt-a:']) expect(() => exactPaneTarget(bad)).toThrow()
  })

  it('cancels any mode first, then types every byte as hex', () => {
    expect(keysCommandText('nt-a', '\x1b[A')).toBe(
      "if-shell -F -t =nt-a: '#{pane_in_mode}' 'copy-mode -q -t =nt-a:'\n" + 'send-keys -t =nt-a: -H 1b 5b 41\n'
    )
  })

  it('encodes UTF-8 bytes, not code points', () => {
    expect(keysCommandText('s', 'ç🙂').split('\n')[1]).toBe('send-keys -t =s: -H c3 a7 f0 9f 99 82')
  })

  it('splits long input into lines of KEYS_PER_COMMAND bytes, in order', () => {
    const data = 'x'.repeat(KEYS_PER_COMMAND * 2 + 3)
    const lines = keysCommandText('s', data).trimEnd().split('\n').slice(1)
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => l.split(' -H ')[1].split(' ').length)).toEqual([KEYS_PER_COMMAND, KEYS_PER_COMMAND, 3])
  })

  it('keeps every typed byte off the command line', () => {
    expect(localKeysArgs('sock')).toEqual(['-L', 'sock', 'source-file', '-'])
    const args = localPasteArgs('sock', 'nt-a', 'nt-paste-0a1b2c3d4e5f')
    expect(args.join(' ')).toBe(
      "-L sock load-buffer -b nt-paste-0a1b2c3d4e5f - ; if-shell -F -t =nt-a: #{pane_in_mode} copy-mode -q -t =nt-a: ; paste-buffer -d -p -r -b nt-paste-0a1b2c3d4e5f -t =nt-a:"
    )
  })

  it('refuses an empty key chunk rather than build a send-keys with no bytes', () => {
    expect(() => keysCommandText('s', '')).toThrow()
  })
})
```

(Adjust the expected `localPasteArgs` join if Step 1 chose a different but equivalent spelling; the property that matters is "no payload in argv, exact target, `-p`, mode cancel, no Enter".)

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/core/watch-link/pane-input.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `pane-input.ts`**

```ts
// Live link Control: typed bytes reach the node's PANE, never a tmux client.
// <measurement table from Step 1 goes here: versions, the 8 checks, numbers>
import { isSessionName } from '../tmux-naming'

export type ControlInputChunk = { kind: 'keys'; data: string } | { kind: 'paste'; text: string }

/** Bytes per `send-keys -H` line: 3 characters each on the line, so ~3 KiB a line. */
export const KEYS_PER_COMMAND = 1024

export function exactPaneTarget(session: string): string {
  if (!isSessionName(session)) throw new Error('not a session name of ours')
  return `=${session}:`
}

/** The stdin of `tmux source-file -`: leave any mode, then type each byte literally. */
export function keysCommandText(session: string, data: string): string {
  const t = exactPaneTarget(session)
  const bytes = [...Buffer.from(data, 'utf8')]
  if (bytes.length === 0) throw new Error('no bytes to type')
  let out = `if-shell -F -t ${t} '#{pane_in_mode}' 'copy-mode -q -t ${t}'\n`
  for (let i = 0; i < bytes.length; i += KEYS_PER_COMMAND) {
    const hex = bytes.slice(i, i + KEYS_PER_COMMAND).map((b) => b.toString(16).padStart(2, '0'))
    out += `send-keys -t ${t} -H ${hex.join(' ')}\n`
  }
  return out
}

export function localKeysArgs(socket: string): string[] {
  return ['-L', socket, 'source-file', '-']
}

/** The text rides stdin (load-buffer -); tmux frames it only if the pane's app asked (-p). No Enter. */
export function localPasteArgs(socket: string, session: string, buffer: string): string[] {
  const t = exactPaneTarget(session)
  if (!/^nt-paste-[a-z0-9]+$/.test(buffer)) throw new Error('bad buffer name')
  return [
    '-L', socket, 'load-buffer', '-b', buffer, '-', ';',
    'if-shell', '-F', '-t', t, '#{pane_in_mode}', `copy-mode -q -t ${t}`, ';',
    'paste-buffer', '-d', '-p', '-r', '-b', buffer, '-t', t
  ]
}
```

Add the remote twins beside the existing remote builders in `src/core/remote-ssh/control-master.ts` (or in `pane-input.ts` importing from there — whichever avoids an import cycle):

```ts
/** ssh args running `tmux -L nodeterm-rmt source-file -` on the host; the command text rides stdin. */
export function remoteKeysArgs(conn: SshConnection, controlPath: string): string[]
/** ssh args for the remote paste plan with an exact target; the text rides stdin. */
export function remotePasteArgs(conn: SshConnection, controlPath: string, session: string, buffer: string): string[]
```

built with `childArgs(conn, controlPath, tmuxCmd(<command string>))` exactly like `remoteTmuxPasteArgs` (single-quote `#{pane_in_mode}` and the inner command for the remote shell). Add their unit tests to `pane-input.test.ts` (payload never in args; exact target; `nodeterm-rmt`).

- [ ] **Step 5: Run the unit tests**

Run: `npx vitest run src/core/watch-link/pane-input.test.ts`
Expected: PASS.

- [ ] **Step 6: PtyManager: route, delivery, support**

Add to `PtyManager` (near `captureVisible`, which already routes by backend through `visibleCaptureRoute`):

```ts
import type { ControlInputChunk, WatcherInputRoute } from './watch-link/pane-input'

  /** How a live-link controller's input reaches this session's pane (see watch-link/pane-input.ts). */
  watcherInputRoute(sessionId: string): WatcherInputRoute {
    const s = this.sessions.get(sessionId)
    if (!s) return 'none'
    if (s.zellij) return 'none'                       // session-wide key bindings: refused (spec §2.4)
    if (s.sshRemote) return s.tmuxBacked ? 'ssh' : 'none'
    if (s.sessionHost || s.nativeWindowsPane) return 'write'
    if (s.tmuxBacked) return this.tmuxPath ? 'tmux' : 'none'
    return 'write'                                    // the plain-shell fallback: the pty IS the shell
  }
```

`controlInput(sessionId, chunk)` serializes per session id (a `Map<string, Promise<unknown>>` chain, entry deleted when the tail settles) and resolves to whether the chunk was delivered; it never rejects:
- `'tmux'`: keys → `runWithStdin(this.tmuxPath, localKeysArgs(TMUX_SOCKET), keysCommandText(name, data))`; paste → `sanitizePasteText(text)`, empty → `true` (nothing to do), else `runWithStdin(this.tmuxPath, localPasteArgs(TMUX_SOCKET, name, buf), body)` with the same failure cleanup `runPasteDelivery` does (a fire-and-forget `delete-buffer -b buf`). `name` = `sessionName(s.persistKey)`; resolve it from the Session, never from the caller.
- `'ssh'`: the same two over `findSsh()` with `remoteKeysArgs` / `remotePasteArgs` and `s.sshRemote.{conn,controlPath}`.
- `'write'`: keys → `this.write(null, sessionId, data)` (try/catch → false). Paste on a session-host session → `sessionHostSendKeys(name, text, false)` IF its no-Enter path writes without waiting for screen settling (read `core/settled-text.ts` and the session-host client to confirm; record what you found in the report); otherwise, and for a native Windows pane or a plain shell, write the sanitized text unframed with `this.write(null, sessionId, sanitizePasteText(text))`.
- `'none'`: `false`.

The live `Session` must be re-read inside the chained step (it can be gone by the time the step runs → `false`).

`nodeControlSupport(persistKey)`: `'unsupported'` when the node is Zellij-backed (`this.zellijKeys.has(persistKey)` or a live session for it with `zellij`); `'ok'` when a live session for it exists, or it has a `released` record, or `this.tmuxPath && settings.tmuxEnabled` (a new tmux node); otherwise `'unknown'`.

- [ ] **Step 7: Real-tmux test** (`pane-input.realtmux.test.ts`)

Keep the spike's checks 1, 2, 3 and 5 as a permanent test that drives the REAL builders with the system tmux, on a private socket name (e.g. `nt-ctl-test-<pid>`), inside the run's sandboxed `TMUX_TMPDIR` (the suite provides it — see CLAUDE.md "The test suite never touches a live tmux server"). Skip with `it.skipIf(!tmuxAvailable || process.platform === 'win32')` and say why in the skip. Kill only your own sessions by exact target (`-t =<name>`). Name the test cases after the security property ("the prefix never reaches tmux", "bytes arrive exactly", "a mode is cancelled first", "only the exact session receives it").

- [ ] **Step 8: Routing unit test**

In the PtyManager test file that already builds sessions with fakes (find the one testing `captureVisible`/`visibleCaptureRoute` or `joinAsWatcher`), add: a zellij session → `'none'`; sshRemote tmux → `'ssh'`; sessionHost → `'write'`; local tmux → `'tmux'`; plain → `'write'`; unknown id → `'none'`; `controlInput` on `'none'` resolves `false` without spawning; two `controlInput` calls on one session run strictly in order (fake runner with a held promise).

- [ ] **Step 9: Run, typecheck, commit**

Run: `npx vitest run src/core/watch-link/pane-input.test.ts src/core/watch-link/pane-input.realtmux.test.ts <the PtyManager test file> && npm run typecheck`
Expected: PASS.

```bash
git add src/core/watch-link/pane-input*.ts src/core/pty-manager.ts src/core/remote-ssh/control-master.ts <test file>
git commit -m "feat(live-links): deliver controller input to the pane, never a tmux client"
```

---

### Task 2: Viewer protocol and shared types

**Files:**
- Modify: `src/shared/watch-link/protocol.ts`, `src/shared/watch-link/client.ts` (vendored dir — sibling imports only)
- Create: `src/shared/watch-link-password.ts`, `src/shared/watch-link-password.test.ts`
- Modify: `src/shared/watch-link-types.ts`, `src/shared/ipc.ts`
- Test: `src/core/watch-link/client.test.ts`, `src/shared/watch-link/isomorphism.guard.test.ts` (must stay green), a new `src/shared/watch-link/protocol.control.test.ts`

**Interfaces:**
- Produces (exact):
  ```ts
  // protocol.ts
  export const WATCH_EVENT = { meta: 'watch:meta', keyframe: 'watch:keyframe', waiting: 'watch:waiting', chat: 'watch:chat',
    end: 'watch:end', control: 'watch:control', typing: 'watch:typing' } as const
  export const WATCH_UNLOCK_CAST = 'watch:unlock'
  export const WATCH_INPUT_CAST = 'watch:input'
  export const WATCH_RELEASE_CAST = 'watch:release'
  export type WatchLinkRole = 'viewer' | 'commenter' | 'controller'
  export const WATCH_END_REASONS = ['revoked', 'expired', 'node-gone', 'session-ended', 'host-stopping', 'kicked', 'attempts'] as const
  export type WatchControlState = 'controlling' | 'available' | 'off' | 'locked'
  export type WatchControlReason = 'wrong' | 'locked' | 'off' | 'too-soon' | 'unsupported' | 'dropped'
  export interface WatchControlEvent { state: WatchControlState; reason?: WatchControlReason }
  export interface WatchTypingEvent { names: string[] }
  export interface WatchMeta { v: number; role: WatchLinkRole; label: string; title: string; expiresAt: number | null;
    cols: number; rows: number; control?: WatchControlEvent }
  export const INPUT_MAX = 16384
  export const PASSWORD_MAX = 128
  export const TYPING_NAMES_MAX = 10
  export function readControlEvent(x: unknown): WatchControlEvent | null
  export function readTypingNames(x: unknown): string[]   // each through sanitizeChatName, deduped, ≤ TYPING_NAMES_MAX
  // client.ts
  export interface WatchClient { sendChat(name: string, text: string): boolean; unlock(name: string, password: string): boolean;
    sendInput(data: string): boolean; release(): boolean; close(): void; isOpen(): boolean }
  // watch-link-password.ts
  export const CONTROL_PASSWORD_MIN = 8
  export const CONTROL_PASSWORD_LENGTH = 16
  export const CONTROL_PASSWORD_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
  export function generateControlPassword(randomBytes: (n: number) => Uint8Array): string
  export type ControlPasswordProblem = 'type' | 'short' | 'long' | 'control'
  export function controlPasswordProblem(pw: unknown): ControlPasswordProblem | null
  // watch-link-types.ts
  export const WATCH_LINK_TTLS = [900, 3600, 28800, 86400, 0] as const   // 0 = Unlimited
  export const UNLIMITED_TTL = 0
  export interface CreateWatchLinkRequest { nodeId: string; role: WatchLinkRole; ttlSeconds: WatchLinkTtl; label: string; title: string; password?: string }
  export type CreateWatchLinkError = <existing> | 'ttl-unsupported' | 'control-unsupported' | 'bad-password'
  export interface WatchLinkViewerView { viewerId: string; name: string | null; joinedAt: number; waiting: boolean; controlling: boolean; typing: boolean }
  export interface WatchLinkControlView { enabled: boolean; locked: boolean }
  export interface WatchLinkView { <existing fields>; expiresAt: number | null; control: WatchLinkControlView | null }
  export type WatchLinkNotice = <existing> | { kind: 'control-taken'; linkId: string; nodeId: string; title: string; name: string }
    | { kind: 'control-locked'; linkId: string; nodeId: string; title: string }
  export type ControlSupport = 'ok' | 'unsupported' | 'unknown'
  export interface WatchLinkApi { <existing>; setControl(linkId: string, enabled: boolean): Promise<boolean>;
    setPassword(linkId: string, password: string): Promise<boolean>; allowControl(linkId: string): Promise<boolean>;
    controlSupport(nodeId: string): Promise<ControlSupport> }
  // ipc.ts
  watchLinkSetControl: 'watchLink:set-control', watchLinkSetPassword: 'watchLink:set-password',
  watchLinkAllowControl: 'watchLink:allow-control', watchLinkControlSupport: 'watchLink:control-support'
  ```
- `WATCH_PROTOCOL_VERSION` stays `1`: every addition is additive (an older viewer page ignores the new events; it just cannot take control).

- [ ] **Step 1: Failing tests**

`src/shared/watch-link/protocol.control.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readControlEvent, readTypingNames, isWatchEndReason, TYPING_NAMES_MAX } from './protocol'

describe('control protocol readers', () => {
  it('accepts only known states and reasons', () => {
    expect(readControlEvent({ state: 'controlling' })).toEqual({ state: 'controlling' })
    expect(readControlEvent({ state: 'available', reason: 'wrong' })).toEqual({ state: 'available', reason: 'wrong' })
    expect(readControlEvent({ state: 'god' })).toBeNull()
    expect(readControlEvent({ state: 'off', reason: 'nope' })).toEqual({ state: 'off' })
    expect(readControlEvent(null)).toBeNull()
  })
  it('sanitizes and bounds typing names', () => {
    const many = Array.from({ length: 30 }, (_, i) => `n${i}`)
    expect(readTypingNames({ names: many })).toHaveLength(TYPING_NAMES_MAX)
    expect(readTypingNames({ names: ['a‮b', 'a‮b', 7, '  '] })).toEqual(['ab'])
    expect(readTypingNames('x')).toEqual([])
  })
  it('knows the new end reason', () => {
    expect(isWatchEndReason('attempts')).toBe(true)
  })
})
```

`src/shared/watch-link-password.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { generateControlPassword, controlPasswordProblem, CONTROL_PASSWORD_ALPHABET, CONTROL_PASSWORD_LENGTH } from './watch-link-password'

describe('control password', () => {
  it('generates 16 symbols from the 32-symbol alphabet, uniformly (byte & 31)', () => {
    const pw = generateControlPassword((n) => Uint8Array.from({ length: n }, (_, i) => i * 37))
    expect(pw).toHaveLength(CONTROL_PASSWORD_LENGTH)
    expect([...pw].every((c) => CONTROL_PASSWORD_ALPHABET.includes(c))).toBe(true)
    expect(CONTROL_PASSWORD_ALPHABET).toHaveLength(32)
    expect(/[ilou]/.test(CONTROL_PASSWORD_ALPHABET)).toBe(false)
  })
  it('validates typed passwords', () => {
    expect(controlPasswordProblem('1234567')).toBe('short')
    expect(controlPasswordProblem('12345678')).toBeNull()
    expect(controlPasswordProblem('🙂'.repeat(8))).toBeNull()        // code points, not UTF-16 units
    expect(controlPasswordProblem('x'.repeat(129))).toBe('long')
    expect(controlPasswordProblem('abcdefg\n')).toBe('control')
    expect(controlPasswordProblem(12345678)).toBe('type')
  })
})
```

In `src/core/watch-link/client.test.ts` add (using its existing `hostWith()` helper that runs the real host-role `connectRelay`): `unlock('Mert','pw')` sends exactly `{"t":"cast","method":"watch:unlock","args":[{"name":"Mert","password":"pw"}]}` sealed under `TAG_TUNNEL_TEXT`; `sendInput('ab')` sends `watch:input` `[{"data":"ab"}]`; `sendInput('x'.repeat(INPUT_MAX + 1))` returns `false` and sends nothing; `release()` sends `watch:release` `[]`; all three return `false` before open.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/shared/watch-link/protocol.control.test.ts src/shared/watch-link-password.test.ts src/core/watch-link/client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Protocol additions as listed. `readControlEvent`: object with `state` in the four states, `reason` kept only if it is one of the six reasons. `readTypingNames(x)`: `x.names` array → `sanitizeChatName` each, drop nulls, dedupe preserving order, slice to `TYPING_NAMES_MAX`.

Client: three methods mirroring `sendChat`'s guard (`opened && state === 'ready'`), each a `sendSealed(TAG_TUNNEL_TEXT, utf8(JSON.stringify({ t: 'cast', method, args })))`. `sendInput` refuses `typeof data !== 'string' || data.length === 0 || data.length > INPUT_MAX`. `unlock` sends name and password as given (the host sanitizes; the page validates length).

`watch-link-password.ts` (NOT in the vendored dir):

```ts
export const CONTROL_PASSWORD_MIN = 8
export const CONTROL_PASSWORD_LENGTH = 16
/** Crockford's base32 in lower case: no i, l, o or u, so nothing reads as another symbol. */
export const CONTROL_PASSWORD_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
export function generateControlPassword(randomBytes: (n: number) => Uint8Array): string {
  const b = randomBytes(CONTROL_PASSWORD_LENGTH)
  let out = ''
  for (let i = 0; i < CONTROL_PASSWORD_LENGTH; i++) out += CONTROL_PASSWORD_ALPHABET[b[i] & 31]
  return out
}
export type ControlPasswordProblem = 'type' | 'short' | 'long' | 'control'
export function controlPasswordProblem(pw: unknown): ControlPasswordProblem | null {
  if (typeof pw !== 'string') return 'type'
  const n = Array.from(pw).length
  if (n < CONTROL_PASSWORD_MIN) return 'short'
  if (n > 128) return 'long'
  if (/[\u0000-\u001f\u007f-\u009f]/.test(pw)) return 'control'
  return null
}
```

Shared types and IPC names as listed. Fix every compile error the type changes cause by the SMALLEST correct change (e.g. a `WatchLinkView` builder gains `control: null`; a `WatchLinkViewerView` gains `controlling: false, typing: false`; an `expiresAt` reader handles `null`); the real behaviour for those lands in Tasks 3–7. `stubs.ts`/`ws-bridge.ts`/`preload` must declare the four new `WatchLinkApi` members (preload: `ipcRenderer.invoke` on the new channels; ws-bridge: `client.request` with a catch to `false` / `'unknown'`; stub: `false` / `'unknown'`).

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/shared src/core/watch-link && npm run typecheck`
Expected: PASS, including `isomorphism.guard.test.ts` and `vectors.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/shared src/core/watch-link/client.test.ts src/preload src/renderer/bridge
git commit -m "feat(live-links): protocol and types for the Control role and unlimited links"
```

---

### Task 3: Password hashing and the link record

**Files:**
- Create: `src/core/watch-link/password.ts`, `src/core/watch-link/password.test.ts`
- Modify: `src/core/watch-link/store.ts`, `src/core/watch-link/store.test.ts`

**Interfaces:**
- Consumes: Task 2's `WatchLinkRole` (`'controller'`).
- Produces:
  ```ts
  // password.ts
  export interface ControlPasswordHash { salt: string; hash: string }   // base64
  export const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, saltBytes: 16, maxmem: 64 * 1024 * 1024 } as const
  export function hashControlPassword(pw: string): Promise<ControlPasswordHash>
  export function verifyControlPassword(pw: string, h: ControlPasswordHash): Promise<boolean>
  // store.ts
  export interface WatchLinkControlRecord { enabled: boolean; salt: string; hash: string; locked: boolean }
  export interface WatchLinkRecord { linkId; nodeId; role: WatchLinkRole; label; title; createdAt: number;
    expiresAt: number | null; secret: Uint8Array; control?: WatchLinkControlRecord }
  ```
  Invariant: `control` is present **iff** `role === 'controller'`.

- [ ] **Step 1: Failing tests**

`password.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { hashControlPassword, verifyControlPassword, SCRYPT } from './password'

describe('control password hash', () => {
  it('verifies the right password and refuses a wrong one', async () => {
    const h = await hashControlPassword('correct horse')
    expect(Buffer.from(h.salt, 'base64')).toHaveLength(SCRYPT.saltBytes)
    expect(Buffer.from(h.hash, 'base64')).toHaveLength(SCRYPT.keylen)
    expect(await verifyControlPassword('correct horse', h)).toBe(true)
    expect(await verifyControlPassword('correct hors', h)).toBe(false)
  })
  it('salts: the same password hashes differently twice', async () => {
    const [a, b] = await Promise.all([hashControlPassword('x'.repeat(8)), hashControlPassword('x'.repeat(8))])
    expect(a.salt).not.toBe(b.salt)
    expect(a.hash).not.toBe(b.hash)
  })
  it('answers false, never throws, for a malformed stored hash or a non-string', async () => {
    expect(await verifyControlPassword('x'.repeat(8), { salt: '!!', hash: 'short' })).toBe(false)
    expect(await verifyControlPassword(7 as never, await hashControlPassword('x'.repeat(8)))).toBe(false)
  })
})
```

`store.test.ts` additions (use the file's existing helpers for a temp file and a fake seal):
- a `controller` record with `control: { enabled: true, salt, hash, locked: false }` and `expiresAt: null` round-trips through `save` + a fresh store's `load`;
- a `controller` record without `control` is DROPPED on load (and so is a `viewer` record that carries one — a hand-edited file cannot give a viewer link a password);
- `control.salt`/`hash` that are not base64 of the right byte lengths (16 / 32) → record dropped; `enabled`/`locked` not booleans → dropped;
- the file never contains the plaintext password (assert the JSON text does not include a known password string after saving a record created from it in the test);
- an opaque entry (unseal refused) whose `expiresAt` is `null` is carried on every write and counted by `opaqueCount()`, and is not dropped by time; an opaque entry with a past numeric `expiresAt` still is (unchanged);
- `expiresAt: null` loads; `expiresAt: 'x'` drops the record.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/core/watch-link/password.test.ts src/core/watch-link/store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `password.ts`**

```ts
// The Control link password: scrypt, stored as {salt, hash} only. The plaintext is never kept.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

export interface ControlPasswordHash { salt: string; hash: string }
export const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, saltBytes: 16, maxmem: 64 * 1024 * 1024 } as const

function derive(pw: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(pw.normalize('NFC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem },
      (err, key) => (err ? reject(err) : resolve(key))))
}

export async function hashControlPassword(pw: string): Promise<ControlPasswordHash> {
  const salt = randomBytes(SCRYPT.saltBytes)
  return { salt: salt.toString('base64'), hash: (await derive(pw, salt)).toString('base64') }
}

export async function verifyControlPassword(pw: string, h: ControlPasswordHash): Promise<boolean> {
  try {
    if (typeof pw !== 'string') return false
    const salt = Buffer.from(h.salt, 'base64')
    const want = Buffer.from(h.hash, 'base64')
    if (salt.length !== SCRYPT.saltBytes || want.length !== SCRYPT.keylen) return false
    return timingSafeEqual(await derive(pw, salt), want)
  } catch {
    return false
  }
}
```

(NFC so the same password typed on a Mac and in a browser compares equal. Note it in the header comment.)

- [ ] **Step 4: Implement the store changes**

In the private file entry type add `control?: { enabled: boolean; salt: string; hash: string; locked: boolean }` and allow `expiresAt: number | null`. Load validation (beside the role check that today reads `role === 'viewer' || role === 'commenter'`): accept `'controller'`; require `control` to be well-formed exactly when the role is `'controller'`, otherwise drop the record; `expiresAt` must be `null` or a finite number. Write `control` as given (it is not secret: the hash is scrypt'd and the file is 0600 under userData — say so in a comment). Opaque-entry retention: `expiresAt === null` means "until discarded" (keep the existing time rule for numbers). Do not change the sealing of `secret`.

- [ ] **Step 5: Run, typecheck, commit**

Run: `npx vitest run src/core/watch-link && npm run typecheck`
Expected: PASS.

```bash
git add src/core/watch-link/password.ts src/core/watch-link/password.test.ts src/core/watch-link/store.ts src/core/watch-link/store.test.ts
git commit -m "feat(live-links): scrypt control password and the controller/unlimited record"
```

---

### Task 4: Link host — unlocking and control state

**Files:**
- Modify: `src/core/watch-link/watcher-policy.ts`, `src/core/watch-link/link-host.ts`
- Test: `src/core/watch-link/watcher-policy.test.ts`, `src/core/watch-link/link-host.test.ts`, `src/core/watch-link/chat-cast.guard.test.ts` (keep green; extend its allowlist only if a new file must mention `watch:chat`)

**Interfaces:**
- Consumes: Task 2 protocol names; Task 3 `WatchLinkRecord.control`.
- Produces:
  ```ts
  // watcher-policy.ts — the ONLY admits, in addition to the existing commenter chat:
  //   cast watch:chat      for 'commenter' and 'controller'
  //   cast watch:unlock / watch:input / watch:release   for 'controller' only
  // link-host.ts
  LinkHostDeps += { verifyPassword(pw: string): Promise<boolean>; onControlTaken(name: string): void; onControlLocked(): void }
  LinkHost += { controlChanged(): void; passwordChanged(): void; allowControl(): void }
  LinkViewer += { controlling: boolean; typing: boolean }      // typing stays false until Task 5
  export const UNLOCK_MIN_INTERVAL_MS = 2000, WRONG_PER_CONN = 3, WRONG_PER_LINK = 10
  ```
  The record object is the service's; the host READS `record.control` live and never writes it. `onControlLocked` is called synchronously and the service sets `record.control.locked = true` before it returns.

**Behaviour (each line is a test in Step 1):**
- `meta.control` (sent on every (re)join) for a controller link: `{state:'controlling'}` if this viewer is controlling and control is on and not locked; else `{state:'locked'}` if `locked`; else `{state:'off'}` if `!enabled`; else `{state:'off', reason:'unsupported'}` if the join's route is `'none'` (Task 5 adds `WatchJoin.input`; in this task treat a missing route as supported); else `{state:'available'}`. Absent for viewer/commenter links.
- `watch:unlock {name, password}` from a joined viewer of a controller link:
  - not joined (`joinedAt === null`) → ignored;
  - malformed payload (no object, name fails `sanitizeChatName`, password not a string or longer than 128) → `watch:control {state: <current>, reason: 'wrong'}` and it COUNTS as a wrong attempt (a malformed attempt is still an attempt);
  - within `UNLOCK_MIN_INTERVAL_MS` of this viewer's previous attempt, or while another verification for this link is in flight → `reason: 'too-soon'`, not counted;
  - locked → `{state:'locked', reason:'locked'}`; off → `{state:'off', reason:'off'}`; not counted;
  - already controlling → answers `{state:'controlling'}`, nothing else;
  - wrong password → `{state:'available', reason:'wrong'}`; per-conn count +1 and link count +1; at `WRONG_PER_CONN` → `endConn(c, 'attempts')`; at `WRONG_PER_LINK` → `deps.onControlLocked()`, every connection (controllers included) gets `{state:'locked', reason:'locked'}` and every controller is demoted;
  - right password → this viewer is controlling, its name is set from the sanitized name, it gets `{state:'controlling'}`, `deps.onControlTaken(name)` and `deps.onChange()` are called. The per-conn wrong count resets on success; the link count does not.
  - The verification state is re-checked after the `await`: a viewer that ended, a host that stopped, control turned off or locked meanwhile → no success.
- `watch:release` → if controlling: demote, answer `{state:'available'}`, `onChange`. Otherwise ignored.
- `controlChanged()` (the service flipped `record.control.enabled` or cleared `locked`): demote every controller when now off; send every joined viewer its current state (`off` or `available`); `onChange`.
- `passwordChanged()`: demote every controller, send each `{state:'available'}`, `onChange`. (A changed password is how an owner revokes a leaked one.)
- `allowControl()`: reset the link wrong count, then the same broadcast as `controlChanged()`.
- `watch:chat` now works on a controller link exactly as on a commenter link; `postSharerChat` too.
- A `watch:input` in this task: admitted by the policy for controller links; the host treats it as a policy breach unless the sender is controlling (Task 5 implements delivery; here a controlling sender's input is accepted and ignored).
- A viewer that is not on a controller link sending unlock/input/release never reaches `onViewerCast` (relay-host drops a denied cast); a raw peer test proves it.
- `viewers()` reports `controlling` per viewer.

- [ ] **Step 1: Failing tests**

`watcher-policy.test.ts`: a table over the three roles × the casts `watch:chat`, `watch:unlock`, `watch:input`, `watch:release`, `watch:anything`, and `req` of each — only the admits above are `{allow:true}`; everything else denies with `WATCHER_REFUSAL`.

`link-host.test.ts` (new `describe('control', …)`, using its real-relay `setup(o)` with `role: 'controller'` and a record carrying `control: { enabled: true, locked: false, salt, hash }` from `hashControlPassword('hunter2hunter2')`; inject `verifyPassword` from the real `verifyControlPassword` bound to that hash, and record calls to `onControlTaken` / `onControlLocked` / `onChange`; drive time with the file's `manualClock()`; the viewer uses the real `connectWatchClient` with Task 2's `unlock`/`release`; capture `watch:control` events from `events.onEvent`). One `it` per behaviour bullet above. The lock test opens fresh viewers (3 per connection ends it) until 10 wrong attempts and asserts: the 10th wrong attempt calls `onControlLocked` once, an already-controlling viewer is demoted and told `locked`, and an 11th attempt answers `locked` without calling `verifyPassword`. The re-check-after-await test holds `verifyPassword` on a deferred promise, calls `controlChanged()` with `enabled = false`, then resolves `true` — the viewer must NOT become controlling. Add the raw-peer test: on a COMMENTER link, a raw peer (the existing L283–345 pattern) sending `watch:unlock` and `watch:input` casts gets nothing back and the link host never sees them (count calls through a spy on `verifyPassword`).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/core/watch-link/watcher-policy.test.ts src/core/watch-link/link-host.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`watcherAccess(kind, method, role)`:

```ts
const CONTROL_CASTS: ReadonlySet<string> = new Set([WATCH_UNLOCK_CAST, WATCH_INPUT_CAST, WATCH_RELEASE_CAST])
export function watcherAccess(kind: 'req' | 'cast', method: string, role: WatchLinkRole): AccessDecision {
  if (kind !== 'cast') return { allow: false, message: WATCHER_REFUSAL }
  if (method === WATCH_CHAT_CAST && (role === 'commenter' || role === 'controller')) return { allow: true }
  if (CONTROL_CASTS.has(method) && role === 'controller') return { allow: true }
  return { allow: false, message: WATCHER_REFUSAL }
}
```

`link-host.ts`: add to `Conn`: `controlling: boolean`, `wrong: number`, `lastUnlockAt: number`. Host-level: `linkWrong = 0`, `verifying = false`. Route `onViewerCast` by method: chat (role commenter|controller), unlock, input (breach unless controlling; Task 5 fills it), release; anything else is a breach as today. A helper `controlStateFor(c): WatchControlEvent` implements the meta rules; `sendControl(c, ev)` sends `WATCH_EVENT.control`. Add `control` to the meta object in `join(c)` only for controller links. Use `deps.now()` for all timing. Keep every deps call inside the existing `safe(...)` wrapper. Update the file header: the watcher's inbound surface is now chat (commenter and controller) plus unlock/input/release (controller), and "controlling" is per connection.

- [ ] **Step 4: Run, typecheck, commit**

Run: `npx vitest run src/core/watch-link && npm run typecheck`
Expected: PASS (existing link-host tests unchanged except where a type gained a field).

```bash
git add src/core/watch-link/watcher-policy.ts src/core/watch-link/watcher-policy.test.ts src/core/watch-link/link-host.ts src/core/watch-link/link-host.test.ts
git commit -m "feat(live-links): unlock a Control link with its password, host-side throttles and lock"
```

---

### Task 5: Link host — typing (input path and the typing set)

**Files:**
- Create: `src/core/watch-link/control-input.ts`, `src/core/watch-link/control-input.test.ts`
- Modify: `src/core/watch-link/link-host.ts`, `src/core/watch-link/link-host.test.ts`

**Interfaces:**
- Consumes: Task 1 `ControlInputChunk`, `WatcherInputRoute`; Task 4 control state; `isTerminalReport` (`src/core/terminal-reports.ts`); `createTokenBucket({ratePerSec, burst, now})` (`src/core/watch-link/token-bucket.ts`).
- Produces:
  ```ts
  // control-input.ts
  export const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~'
  export const PASTE_MAX = 256 * 1024
  export interface InputSplitter { push(data: string): ControlInputChunk[]; reset(): void }
  export function createInputSplitter(): InputSplitter
  export interface TypingTracker { note(viewerId: string, name: string, at: number): void; drop(viewerId: string): void;
    names(at: number): string[]; typing(viewerId: string, at: number): boolean }
  export const TYPING_WINDOW_MS = 4000
  export function createTypingTracker(): TypingTracker
  // link-host.ts
  WatchPty += { input(sessionId: string, chunk: ControlInputChunk): Promise<boolean> }
  WatchJoin += { input: WatcherInputRoute }
  export const INPUT_RATE = 64 * 1024, INPUT_BURST = 256 * 1024, INPUT_BATCH_MS = 20,
    TYPING_EVENT_MIN_MS = 1000, DROPPED_NOTICE_MIN_MS = 10_000
  ```

**Splitter rules** (the viewer page always frames pastes — Plan 3 forces bracketed-paste mode in its xterm while controlling — so the host can tell a paste from typing and let tmux frame it for the pane's real state):
- Outside a paste, bytes are `keys`. `PASTE_START` begins a paste; text up to `PASTE_END` is the paste's text; `PASTE_END` closes it and yields one `paste` chunk.
- Markers split across `push` calls are recognised (hold back a trailing prefix of a marker; a held prefix that turns out not to be a marker is emitted as keys).
- A paste longer than `PASTE_MAX` is truncated to `PASTE_MAX` (the rest up to `PASTE_END` is discarded); a paste still open is not emitted until its end arrives, except that `reset()` (control lost, connection ended) discards it.
- A `PASTE_END` outside a paste is keys (passed through as typed).
- Consecutive keys in one `push` are merged into one chunk.

**Link-host input rules:**
- `watch:input {data}`: sender not controlling, or control off/locked → `policyBreach` (closes). `data` not a string, empty, or longer than `INPUT_MAX` → breach. `isTerminalReport(data)` → dropped silently (not counted against the bucket).
- Bucket (per conn, `INPUT_RATE`/`INPUT_BURST`, `deps.now`): over budget → dropped; the viewer gets `{state:'controlling', reason:'dropped'}` at most once per `DROPPED_NOTICE_MIN_MS`.
- Accepted data goes through the conn's splitter; chunks append to the conn's pending batch; the batch flushes after `INPUT_BATCH_MS` (one timer per conn) into a HOST-wide flush chain (one promise chain per link host → batches from all controllers serialize in flush order and are delivered whole).
- Flush: re-check `controlling`, control on, not locked, not ended; the conn's CURRENT `sessionId` (non-null) and its join's `input` route ≠ `'none'`; then `deps.pty.input(sessionId, chunk)` for each chunk in order. A `false` result → stop this batch and notify `dropped` (rate-limited as above). No session → drop the batch with a `dropped` notice; never hold input for a later session.
- Losing control (release, off, password change, lock, kick, end, stop) clears the pending batch and resets the splitter.
- Typing set: on every accepted input, `tracker.note(viewerId, name, now)`. A host-wide timer recomputes `tracker.names(now)` at most once per `TYPING_EVENT_MIN_MS` while anyone typed in the last `TYPING_WINDOW_MS` (and once more after the window to clear); when the set changes, send `watch:typing {names}` to every joined viewer and call `onChange`. `viewers()` reports `typing` from the tracker. A conn that ends or loses control is dropped from the tracker.
- `join(c)`: keep `res.input` on the conn; a `'none'` route makes the meta control state `{state:'off', reason:'unsupported'}` and an unlock answer `{state:'off', reason:'unsupported'}` (not counted). `normalizeJoin` must accept `input` (default `'none'` when missing or not one of the four values).

- [ ] **Step 1: Failing tests**

`control-input.test.ts` — splitter: plain keys; a paste in one push; markers split at every byte boundary across two pushes (loop over split points and assert identical chunks); `PASTE_END` outside a paste is keys; a held marker prefix that is not a marker (`\x1b[20x`) comes out as keys; a paste over `PASTE_MAX` is cut to `PASTE_MAX`; `reset()` drops an open paste. Typing tracker: names within 4 s, sorted by most recent input, deduped by viewer; `drop` removes; a name outside the window disappears.

`link-host.test.ts` (`describe('control typing', …)`, fake `pty.input` recording `(sessionId, chunk)` calls and resolving `true`): a controller types `ls\r` → one `keys` chunk to the joined session after `INPUT_BATCH_MS`; a non-controlling viewer's `watch:input` closes its connection and delivers nothing; a DA answer (`\x1b[?1;2c`) is dropped; bucket: 300 KiB in one burst delivers `INPUT_BURST` and sends ONE `dropped` notice; two controllers' batches arrive whole and in flush order (hold the first `input` promise, type from the second, release, assert order); control turned off while a batch is pending → nothing delivered; the session changes (simulate `sessionOver` + a rejoin to `s2`) → the next input goes to `s2`; no session (waiting) → dropped + notice, nothing delivered after a later join; `pty.input` resolving `false` → `dropped` notice; typing: two controllers type, every viewer gets `watch:typing {names:[…]}`, and after 4 s of silence `{names: []}`; `'none'` route → meta `{state:'off', reason:'unsupported'}` and unlock refused with that reason.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/core/watch-link/control-input.test.ts src/core/watch-link/link-host.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `control-input.ts` (pure, no timers) and the link-host wiring above. Use `deps.setTimeout`/`deps.clearTimeout` for every timer, and clear them all in `ended(c)` and `stop()`. The host-wide flush chain must catch: a rejected `pty.input` counts as `false`.

- [ ] **Step 4: Run, typecheck, commit**

Run: `npx vitest run src/core/watch-link && npm run typecheck`
Expected: PASS.

```bash
git add src/core/watch-link/control-input.ts src/core/watch-link/control-input.test.ts src/core/watch-link/link-host.ts src/core/watch-link/link-host.test.ts
git commit -m "feat(live-links): a controller types into the pane; the host shows who is typing"
```

---

### Task 6: Service, owner IPC, API client, pty seam, bridges and shells

**Files:**
- Modify: `src/core/watch-link/service.ts`, `src/core/watch-link/api.ts`, `src/core/watch-link/pty-seam.ts`, `src/main/index.ts`, `src/server/index.ts`, `src/renderer/bridge/ws-bridge.ts`, `src/renderer/bridge/stubs.ts`, `src/preload/index.ts` (if Task 2 left placeholders)
- Test: `src/core/watch-link/service.test.ts`, `src/core/watch-link/api.test.ts`, `src/core/watch-link/pty-seam.test.ts`, a new `src/main/watch-link-control-wiring.test.ts` (source-level, like `src/main/watch-link-wiring.test.ts`)

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  ```ts
  // api.ts
  create(entitlement, joinKeyHash, ttlSeconds): Promise<{ ok: true; linkId: string; expiresAt: number | null } | { ok: false; error: CreateError }>
  type CreateError = <existing> | 'ttl-unsupported'     // a 400 {error:'bad_ttl'} answered to ttlSeconds 0
  // service.ts
  WatchLinkServiceDeps += { controlSupport?(nodeId: string): ControlSupport }
  WatchLinkService += { setControl(linkId: string, enabled: boolean): Promise<boolean>; setPassword(linkId: string, pw: string): Promise<boolean>;
    allowControl(linkId: string): Promise<boolean>; controlSupport(nodeId: string): ControlSupport }
  // pty-seam.ts
  WatchPtyManager adds 'controlInput' | 'watcherInputRoute'; join returns input: pty.watcherInputRoute(sessionId)
  ```

**Behaviour:**
- `parseRequest`: role may be `'controller'`; then `password` is required and must pass `controlPasswordProblem` (else `bad-password`); for other roles a `password` field is ignored. `ttlSeconds` may be `0`.
- `create`: controller on a node whose `deps.controlSupport?.(nodeId) === 'unsupported'` → `control-unsupported` (before any network call). Hash the password (`hashControlPassword`) BEFORE the backend create (so a hashing failure creates no server row); the plaintext is dropped right after. `api.create(ent, joinKeyHash, ttlSeconds)` with `0` for Unlimited; `ttl-unsupported` passes through to the result. Record `expiresAt` = the response's (`null` for Unlimited). `control: { enabled: true, locked: false, ...hash }` for controller records.
- Expiry: `armExpiry` and the lid-close re-check skip `expiresAt === null`; `runInit` never prunes a null record by time.
- `viewOf`: `expiresAt` as stored; `control: role === 'controller' && record.control ? { enabled, locked } : null`; viewers carry `controlling` and `typing` from the host.
- Host deps: `verifyPassword: (pw) => record.control ? verifyControlPassword(pw, record.control) : Promise.resolve(false)` (read `record.control` at call time — a password change swaps it); `onControlTaken(name)` → notice `{kind:'control-taken', linkId, nodeId, title, name}` + `emitState`; `onControlLocked()` → set `record.control.locked = true` synchronously, persist (the existing save path; a failed save is logged, the lock still holds in memory), notice `{kind:'control-locked', …}`, `emitState`.
- `setControl(linkId, enabled)` / `allowControl(linkId)` / `setPassword(linkId, pw)`: only for a live controller record (else `false`). `setPassword` validates with `controlPasswordProblem` (else `false`), hashes, swaps `record.control.{salt,hash}`, persists, then `host.passwordChanged()`. `setControl` writes `enabled`, persists, `host.controlChanged()`. `allowControl` writes `locked = false`, persists, `host.allowControl()`. Each `emitState`s. Persist failure → the change is rolled back in memory and the call answers `false` (the owner is told; a lock is the exception above — locking is never rolled back).
- `registerWatchLinkIpc`: the four new channels, owner-checked exactly like the existing seven (`watchLink:` stays host-only by prefix; add an assertion to the existing host-control test that the new channels are refused from a relay peer).
- `api.create`: accept `expiresAt: null` only when `ttlSeconds === 0` was requested (a null for a finite request is a malformed answer → `network`); a numeric answer to `0` (a capped server) is re-anchored like any other. A `400 {"error":"bad_ttl"}` to a `0` request → `ttl-unsupported`.
- `pty-seam.ts`: `input: (sessionId, chunk) => pty.controlInput(sessionId, chunk)`; `join` adds `input: pty.watcherInputRoute(res.sessionId)`.
- `src/main/index.ts`: pass `controlSupport: (nodeId) => ptyManager.nodeControlSupport(nodeId)` (answer `'unknown'` for an SSH-project node whose live session is not held — remote Zellij is not a thing, so `'ok'` is also acceptable; pick one and say which in a comment). `src/server/index.ts`: same deps (links stay `unsupported` there; the members exist).
- ws-bridge / stubs: real `client.request` calls with catches (`false`, `'unknown'`).

- [ ] **Step 1: Failing tests** — `service.test.ts` (using `fakeHosts()` and the real store where the file already does): controller create hashes and persists `control`, never the plaintext (read the store file text); missing/short password → `bad-password` with no `api.create` call; Zellij node → `control-unsupported` with no `api.create` call; Unlimited → `expiresAt: null` in the record and the view, no expiry timer armed (advance a fake clock far past any finite TTL: still live); `ttl-unsupported` passes through; `onControlLocked` sets `locked`, persists, notices; `setControl`/`setPassword`/`allowControl` call the host hooks and persist, refuse a non-controller link, and roll back on a failed save; `verifyPassword` uses the CURRENT hash after `setPassword`. `api.test.ts`: `0` → `expiresAt: null`; `null` to a finite request → `network`; `400 bad_ttl` to `0` → `ttl-unsupported`. `pty-seam.test.ts`: input and route pass through. `watch-link-control-wiring.test.ts`: source-level pins that `src/main/index.ts` passes `controlSupport` and that `registerWatchLinkIpc` registers all eleven channels (a dropped hop compiles and ships the feature inert).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/core/watch-link src/main/watch-link-control-wiring.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** as above.

- [ ] **Step 4: Run focused tests, the full suite (isolated HOME), typecheck**

Run: `npx vitest run src/core/watch-link src/main src/shared && HOME=$(mktemp -d -p /var/tmp) TMPDIR=/var/tmp npx vitest run && npm run typecheck`
Expected: PASS. Report any pre-existing flake by name with its failure line (see memory: license test flake) rather than fixing unrelated tests.

- [ ] **Step 5: Commit**

```bash
git add -A src/core/watch-link src/main src/server src/renderer/bridge src/preload
git commit -m "feat(live-links): owner controls, unlimited records and the input seam in both shells"
```

---

### Task 7: Renderer — create dialog, LIVE chip and popover controls, notices

**Files:**
- Modify: `src/renderer/lib/liveLink.ts` (+ `liveLink.test.ts`), `src/renderer/components/LiveLinkDialog.tsx` (+ test), `src/renderer/components/LiveLinkPopover.tsx`, `src/renderer/components/LiveLinkChip.tsx` (+ `LiveLinkChip.test.tsx`), `src/renderer/state/watchLinks.ts` (+ test), `src/renderer/canvas/Canvas.tsx` (notice handling only), `src/renderer/styles.css`

**Interfaces:**
- Consumes: Task 2 types/API, `generateControlPassword`, `controlPasswordProblem`.
- Produces:
  ```ts
  // liveLink.ts
  ROLE_LABEL: Record<WatchLinkRole, string>   // controller: 'Can watch, chat and type'
  ROLE_NAME: Record<WatchLinkRole, string>    // 'Viewer' | 'Commenter' | 'Control'
  TTL_OPTIONS gains { value: 0, label: 'Unlimited' } (last)
  export const CONTROL_WARNING: string        // the spec §2.7 text, verbatim
  export const PASSWORD_SEPARATE_NOTE = 'Send the password separately from the link.'
  export const PASSWORD_SHOWN_ONCE = 'This is the only time the password is shown. Change it later from the LIVE chip.'
  export const UNLIMITED_NOTE = 'This link works until you stop it.'
  export const CONTROL_UNSUPPORTED_REASON = "Control isn't available for this terminal: its Zellij session's key bindings would reach every session."
  export const CONTROL_LOCKED_TEXT = 'Control locked after 10 wrong passwords.'
  export function formatRemaining(expiresAt: number | null, now?: number): string   // null → 'No end time'
  export function formatUntil(expiresAt: number | null): string                       // null → 'you stop it'
  export function typingNames(links: WatchLinkView[]): string[]
  export function chipView(links: WatchLinkView[]): { label: string; tone: LiveLinkTone; title: string }  // '… · 1 typing'
  export function controlTakenText(n: { name: string; title: string }): string  // 'Someone using the name “Mert” can now type in api-server.'
  ```

**Behaviour:**
- Dialog form: role radios Viewer / Commenter / **Control**; Control is disabled with `CONTROL_UNSUPPORTED_REASON` when `watchLink.controlSupport(nodeId)` answers `'unsupported'` (asked once on open; `'unknown'` keeps it enabled). With Control picked: a password input (`type="text"`, `autocomplete="off"`, `spellCheck={false}`, maxLength 128) with a **Generate** button (fills 16 symbols from `crypto.getRandomValues`), the inline validation message from `controlPasswordProblem` ('Use at least 8 characters.', 'Use at most 128 characters.', 'Line breaks and control characters are not allowed.'), and `CONTROL_WARNING` replacing `LIVE_LINK_WARNING`. TTL radios include Unlimited; picking it shows `UNLIMITED_NOTE`. Submit sends `password` only for Control.
- Done step for Control: the link field and copy (as today), then the password in its own read-only field with **Copy password**, `PASSWORD_SHOWN_ONCE` and `PASSWORD_SEPARATE_NOTE`. The "Anyone with this link can watch until …" line becomes, for Control, "Anyone with this link and the password can type until {formatUntil}." The plaintext lives only in this component's state and is dropped on close.
- Errors: `createErrorMessage` maps `ttl-unsupported` → 'Unlimited links need a newer server. Pick an end time.', `control-unsupported` → `CONTROL_UNSUPPORTED_REASON`, `bad-password` → 'The password must be 8 to 128 characters, with no line breaks.'
- Chip: `LIVE · 3 · 1 typing` when anyone types (worst-state rule unchanged: refused > offline > waiting > typing > count); the `title` names who ("Mert and Ayşe are typing"). Unread is a COUNT badge (not a dot) summed over the node's links; `aria-label` says "N unread chat messages".
- Popover `LinkBlock` for a controller link: role line "Control" + remaining (`No end time` for null); viewers list shows "can type" for controllers and a typing dot; controls: **Typing on/off** switch (`setControl`), **Change password…** (inline: field + Generate + Save; on success shows the new password once with Copy, same once-only wording), **Allow control again** shown only when `control.locked` with `CONTROL_LOCKED_TEXT`; an **Open chat** button (dispatches `nodeterm:live-chat` with `{ linkId }` — Task 8 listens; until then the event is unheard, which `nodeterm-events.test.ts` will flag: wire Task 8's listener stub in Canvas in THIS task, opening nothing yet, and remove the stub in Task 8). `ChatThread` shows for commenter AND controller links.
- Notices (Canvas `startWatchLinkSync` callback): `control-taken` → info strip `controlTakenText(n)` AND an OS notification through `window.nodeTerminal.notify({ title: 'Live link', body: controlTakenText(n), nodeId: n.nodeId })` under the SAME consent gate the agent-done notification uses (`notifyOnClaudeDone && notifyConsentAsked`), with a 5 s per-link cooldown; `control-locked` → sticky info strip "Control of {title} was locked after 10 wrong passwords. Allow it again from the LIVE chip." `noticeText` covers both kinds.
- Every new string reaches the user through `textContent`/JSX text, never as HTML; viewer names are claims — render them in quotes where a sentence makes a claim about a person.

- [ ] **Step 1: Failing tests** — `liveLink.test.ts`: the new strings, `formatRemaining(null)`, `formatUntil(null)`, `chipView` typing order and title, `controlTakenText` quoting. `LiveLinkDialog.test.tsx`: Control shows the password field + Generate + `CONTROL_WARNING`; submit is disabled until the password is valid; submit sends the password only for Control; Control disabled with the reason when `controlSupport` answers `'unsupported'`; Unlimited sends `ttlSeconds: 0` and shows `UNLIMITED_NOTE`; the done step shows the password once with Copy and the separate-send note; `ttl-unsupported` error text. `LiveLinkChip.test.tsx`: typing label/title; unread count badge; the popover's control switch calls `setControl`, Allow-again shown only when locked and calls `allowControl`, Change password validates and calls `setPassword` and shows the new password once; Open chat dispatches `nodeterm:live-chat` with the link id; chat shows for a controller link. `watchLinks.test.ts`: unread counting unchanged for controller links.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/renderer/lib/liveLink.test.ts src/renderer/components/LiveLinkDialog.test.tsx src/renderer/components/LiveLinkChip.test.tsx src/renderer/state/watchLinks.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**, reusing existing class names and tokens (`.live-pop`, `.confirm-overlay`, the switch component Settings already uses — grep for an existing toggle before writing one). No new color literals: status tones come from the existing `--state-*` tokens (see CLAUDE.md "Semantic colours").

- [ ] **Step 4: Run, typecheck, commit**

Run: `npx vitest run src/renderer && npm run typecheck`
Expected: PASS (including `nodeterm-events.test.ts` and `live-link.guard.test.ts`).

```bash
git add -A src/renderer
git commit -m "feat(live-links): Control and Unlimited in the dialog, typing on the chip, owner controls"
```

---

### Task 8: Renderer — the Live chat drawer

**Files:**
- Create: `src/renderer/lib/liveChatPin.ts` (+ test), `src/renderer/components/LiveChatDrawer.tsx` (+ `LiveChatDrawer.test.tsx`)
- Modify: `src/renderer/canvas/Canvas.tsx` (state, listener, mount, palette), `src/renderer/lib/liveLinkEntry.tsx` (palette command), `src/renderer/state/watchLinks.ts` (last link), `src/renderer/components/lazyPanels.tsx` (lazy export), `src/renderer/styles.css`

**Interfaces:**
- Consumes: Task 7's `nodeterm:live-chat` event, `useWatchLinks`, `viewLinkThread`, `markRead`, `api.sendChat`, `api.kick`, `setControl`/`setPassword`/`allowControl`.
- Produces:
  ```ts
  // liveChatPin.ts — the Explorer pin pattern (lib/explorerPin.ts), its own key
  export const LIVE_CHAT_PINNED_KEY = 'nodeterm.liveChatPinned'
  export const LIVE_CHAT_LINK_KEY = 'nodeterm.liveChatLink'
  export interface LiveChatState { pinned: boolean; dismissed: boolean; open: boolean; linkId: string | null }
  export type LiveChatAction = { kind: 'open'; linkId?: string } | { kind: 'toggle' } | { kind: 'close' } | { kind: 'pin' }
  export function liveChatIsOpen(s: LiveChatState): boolean            // pinned ? !dismissed : open
  export function nextLiveChat(s: LiveChatState, a: LiveChatAction): LiveChatState
  export function readLiveChatPinned(): boolean; export function writeLiveChatPinned(v: boolean): void
  export function pickChatLink(links: WatchLinkView[], wanted: string | null): string | null  // wanted if live, else the most recent
  // LiveChatDrawer.tsx
  export function LiveChatDrawer(p: { linkId: string | null; pinned: boolean; raised: boolean; onPickLink(id: string): void;
    onClose(): void; onTogglePin(): void; onGoToNode(nodeId: string): void }): JSX.Element
  ```

**Behaviour:**
- Markup is the Explorer drawer's (`drawer-overlay` / `drawer`, `--pinned` modifiers, head with pin button `aria-pressed` and close), title **Live chat**. Unpinned: scrim click closes. Pinned: no scrim, docked like Explorer, z 26 (above the board's 25). `raised` (Canvas passes `true` while a kanban card modal is open) renders the overlay at z 57 (above the card modal's 55) whatever the pin — add `.drawer-overlay--raised`. When the pinned Explorer is ALSO open, the pinned chat drawer docks to its left (`.drawer-overlay--beside` → `right: calc(var(--float-gap) + 320px + 8px)`); both are found by `pinnedInsets.ts`/`maximizeInsets.ts` through `.drawer--pinned`, so no change there — verify with their tests.
- Link picker (`<select>`) when more than one link is live: "{title} · {Viewer|Commenter|Control}". The pick is remembered in localStorage (`LIVE_CHAT_LINK_KEY`, try/catch) and via `pickChatLink`.
- Messages: the viewer page's live-chat look (time, name, text, a **Sharer** badge on the owner's lines; names as text nodes, colored by the same FNV hash as the web page — copy `chatNameColor`/`VIEWER_NAME_COLORS` into a renderer lib file, do not import the web repo), sticky-to-bottom with the "N new messages ↓" pill (`nearBottom` 32 px rule). Composer posts with `api.sendChat` (`maxLength={CHAT_TEXT_MAX}`), error → `CHAT_NOT_SENT_MESSAGE`. While mounted on a link, `viewLinkThread(linkId)` + `markRead(linkId)` (the popover's existing thread rule) so the chip's unread count clears.
- People: each viewer (`viewerName`), "watching" / "can type", a typing dot, **Kick**; for a Control link the Typing switch, Change password, Allow control again (reuse Task 7's components — extract them from the popover into a shared file rather than copying). A Viewer link shows People only (no chat).
- A **Go to terminal** link calls `onGoToNode` (Canvas: `focusNodeById` / `travelToNode`).
- Empty state when no link is live: "No live links." and the drawer stays closable.
- Canvas: state `liveChat` via `nextLiveChat`; the `nodeterm:live-chat` listener opens it on `detail.linkId`; palette command `live-chat` "Live chat" (section `View`, shown when any link is live) from `liveLinkCommands`; Escape closes the drawer only when it is the top dialog (use the dialog stack the card modal uses; when pinned, Escape does nothing).
- No OS notification for chat; nothing in this task calls `notify`.

- [ ] **Step 1: Failing tests** — `liveChatPin.test.ts`: `nextLiveChat` transitions (open/toggle/close/pin, pinned+dismissed), `pickChatLink` fallbacks, storage read/write tolerate a throwing `localStorage`. `LiveChatDrawer.test.tsx` (React Testing Library, the setup `LiveLinkChip.test.tsx` uses): renders messages with a Sharer badge; viewer names as text (a `<b>` name is literal text); the new-messages pill appears when scrolled up; sending calls `api.sendChat`; picker shown only with >1 link; Viewer link shows People only; Kick calls `api.kick`; Typing switch calls `setControl`; mounting on a link calls `markRead` and clears the chip's unread count; `raised`/`pinned` class names. Canvas wiring: extend the existing source-level or event test so `nodeterm:live-chat` has exactly one listener.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/renderer/lib/liveChatPin.test.ts src/renderer/components/LiveChatDrawer.test.tsx src/renderer/lib/nodeterm-events.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** (lazy-load the drawer like ExplorerPanel through `lazyPanels.tsx`).

- [ ] **Step 4: Run, typecheck, commit**

Run: `npx vitest run src/renderer && npm run typecheck`
Expected: PASS.

```bash
git add -A src/renderer
git commit -m "feat(live-links): a pinnable Live chat drawer to follow and answer link chat"
```

---

### Task 9: Docs, guards and the mutation sweep

**Files:**
- Modify: `docs/live-links.md`, `CLAUDE.md` (the "Live links" section), `src/renderer/lib/live-link.guard.test.ts` or a new guard test if a rule below has no home
- Test: whatever the sweep touches

**Interfaces:**
- Consumes: everything above. Produces: no code interfaces.

- [ ] **Step 1: `docs/live-links.md`** — a new section "The Control role" (password, unlock throttles and lock, pane delivery and WHY not a tmux client — with Task 1's measurement table, the input splitter and paste framing, the typing set, what a leak costs, backends, Zellij refusal), "Unlimited links" (backend rule, the daily Pro check, no expiry timer, opaque entries), and "Live chat drawer". Update "The watcher role" (the inbound surface is no longer chat-only), "Threat notes and residuals" (spec §6 verbatim in substance), and the Device checklist with items 35+ (spec §9's list, one numbered item each, plus: tmux 3.7b bytes exact if Task 1 could not measure it; SSH latency over a real link; Windows session-host paste framing; a phone taking control).

- [ ] **Step 2: `CLAUDE.md`** — add bullets to the "Live links" section: the watcher policy's three controller casts and that "controlling" is per connection; input reaches the PANE via `send-keys -H` read by `source-file -` (never a client: the prefix is the security boundary), pastes via `paste-buffer -p`; never a payload in argv; Zellij refused; unlimited = `expiresAt: null` + daily liveness at host-token. Keep the existing bullets; edit only where a sentence is now false (e.g. "A watcher never goes through decideAccess (it would get the VIEW table): watcher-policy.ts refuses all but a Commenter's watch:chat cast").

- [ ] **Step 3: Mutation sweep.** For each refusal, break it on purpose, run its test file, confirm RED, restore (use `git stash push -m <tag>`-free edits: copy the file to the scratchpad, edit, run, copy back; confirm `git diff` is empty after each). List each in the report with the test that went red:
  1. `watcherAccess` admits `watch:input` for `commenter`.
  2. link-host accepts input from a non-controlling viewer.
  3. the flush skips the `controlling` re-check.
  4. `isTerminalReport` drop removed.
  5. input bucket bypassed.
  6. unlock interval check removed.
  7. per-connection 3-wrong end removed.
  8. link-wide lock not triggered at 10.
  9. `verifyControlPassword` compares with `===` instead of `timingSafeEqual` (expect the constant-time test — add one that asserts `timingSafeEqual` is called via a spy, or a source-level assertion, if no behavioural test can see it).
  10. `keysCommandText` drops the mode cancel (real-tmux test).
  11. `exactPaneTarget` returns `nt-x` without `=`/`:` (real-tmux exact-target test).
  12. `controlInput` routes `tmux` through `this.write` (the client) — the real-tmux prefix test must go red; if it cannot see the routing, add a PtyManager routing test that can.
  13. the store accepts a viewer record carrying `control`.
  14. `passwordChanged` does not demote controllers.
  15. `armExpiry` arms a timer for `null` (expect the unlimited-never-expires test).
  Any mutation that stays GREEN is a missing test: add it, then re-run the mutation.

- [ ] **Step 4: Full suite (isolated HOME) and typecheck**

Run: `HOME=$(mktemp -d -p /var/tmp) TMPDIR=/var/tmp npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/live-links.md CLAUDE.md <tests>
git commit -m "docs(live-links): the Control role, unlimited links and the chat drawer"
```

## After all tasks

The controller (not a task subagent) pushes `feat/live-link-control` and opens the desktop PR (English, `pr-writing` skill; say plainly: no Electron run on this server, the device checklist items 35+ are owed on a Mac, Windows and a Server Edition tab; the backend PR must deploy first). Then Plan 3 re-vendors Task 2's protocol at the pushed commit. Nothing is merged without enes.
