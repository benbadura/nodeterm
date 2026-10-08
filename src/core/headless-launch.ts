// The headless launcher (#925): start a node's session with no viewer and deliver its launch
// command by the rule a mounted terminal's automatic launch writer applies — settle a fresh shell,
// then either trust it (`trustsFreshShell`: a fresh plain shell or session-host session, whose
// probe is useless or unreliable) or prove a shell owns the pane, then the echo-verified writer
// (@shared/command-delivery). The desktop runs it for canvas-control `--run-now` / `run`; the
// Server Edition runs it for every immediate open.
//
// Never a blind paste: zsh's rc/ZLE setup FLUSHES the tty (#556) and a canonical-mode line is cut
// at the tty's cap (#706). A tmux paste is not immune to either, which is why the desktop rule
// "launches use the echo-verified writer, not sendText" now covers this path too.
import { deliverCommand, type DeliveryIo, type DeliveryOutcome } from '../shared/command-delivery'
import { isLaunchShell } from '../shared/agents/pane'
import type { HeadlessLaunchRequest, HeadlessLaunchResult } from '../shared/headless-launch'
import { trustsFreshShell } from '../shared/launch-trust'
import { shellKillLineSequence } from '../shared/shell-kill-line'
import type { PtyCreateOptions, PtyCreateResult } from '../shared/types'

/** Same numbers as TerminalNode's `whenShellSettled`: 200 ms of quiet after output = prompt is up;
 *  1500 ms of total silence = write anyway. */
export const SETTLE_QUIET_MS = 200
export const SETTLE_CAP_MS = 1500
/** Absolute ceiling on the whole settle, which output never extends. A pane that paints more often
 *  than every SETTLE_QUIET_MS (a spinner, a chatty rc file) never goes quiet, and nothing else would
 *  end the wait. */
export const SETTLE_MAX_MS = 5000

export interface HeadlessLaunchDeps {
  /** A host workflow may pause/cancel while the shell settles. Check immediately before input. */
  mayDeliver?(): Promise<boolean>
  persistentSpawnAvailable(): boolean
  createHeadless(options: PtyCreateOptions): Promise<PtyCreateResult>
  paneCommand(persistKey: string): Promise<string | null>
  writeHeadless(persistKey: string, data: string): boolean
  onOutput(persistKey: string, cb: (chunk: string) => void): () => void
  releaseHeadless(persistKey: string): void
  /** Test seam; production uses SETTLE_QUIET_MS / SETTLE_CAP_MS / SETTLE_MAX_MS. */
  timing?: { quietMs: number; capMs: number; maxMs?: number }
}

/**
 * The desktop's `pty.launchHeadless` request, as main runs it: the renderer sends only
 * `{ ptyOptions, command }`, and the desktop always releases its synthetic client, so it always
 * requires a persistent backend. Whatever else the wire carries is overwritten here.
 *
 * `sshRemote` is stripped: this path never spawns over a ControlMaster. `viewerId` is stripped: a
 * headless start is the connection's PRIMARY view, and `releaseHeadless` detaches `(0, PRIMARY)`,
 * so a create under a viewer id would subscribe `(0, viewer)` and leave client 0 attached forever.
 * `clearEnv` is stripped: it is a one-shot "Restart on subscription" recycle flag, never a launch
 * option. `requireRemote` is KEPT as sent. The primary fence is the renderer's: `startHeadless` refuses an SSH node before any claim
 * (`remote-unsupported`), so none should arrive here. `requireRemote` — which the renderer's
 * `headlessPtyOptions` sets for an SSH-project node — is core's belt behind that fence: it makes
 * `spawnNew` refuse (`unavailable:'ssh'` → `spawn-failed`), where clearing it with `sshRemote`
 * would start a LOCAL `nt-<id>` wearing the remote node's identity and type its launch there
 * (CLAUDE.md, "A remote node is NEVER spawned locally").
 */
export function desktopHeadlessRequest(req: {
  ptyOptions: PtyCreateOptions
  command: string
}): HeadlessLaunchRequest {
  return {
    ptyOptions: { ...req.ptyOptions, sshRemote: undefined, viewerId: undefined, clearEnv: undefined },
    command: String(req.command ?? ''),
    release: true,
    requirePersistent: true
  }
}

export async function launchHeadless(
  deps: HeadlessLaunchDeps,
  req: HeadlessLaunchRequest
): Promise<HeadlessLaunchResult> {
  const key = req.ptyOptions.persistKey
  if (!key) return { outcome: 'failed', reason: 'spawn-failed' }
  if (req.requirePersistent && !deps.persistentSpawnAvailable()) {
    return { outcome: 'failed', reason: 'not-persistent' }
  }
  let created: PtyCreateResult
  try {
    created = await deps.createHeadless(req.ptyOptions)
  } catch {
    return { outcome: 'failed', reason: 'spawn-failed' }
  }
  if (!created.sessionId) return { outcome: 'failed', reason: 'spawn-failed' }
  const fresh = created.fresh
  try {
    if (created.unavailable) return { outcome: 'failed', reason: 'spawn-failed', fresh }
    // The probe above can be stale by the time the spawn lands (tmux switched off in between), and
    // a plain shell dies with the client this launcher is about to release — typing a launch into
    // it would start an agent only to kill it. `persistent` absent = an older core, persistent by
    // the field's own contract (`PtyCreateResult.persistent`; `trustsFreshShell` reads it so too).
    if (req.requirePersistent && created.persistent === false) {
      return { outcome: 'failed', reason: 'not-persistent', fresh }
    }
    if (fresh) await settle(deps, key)
    // The mounted writer's rule, not a stricter one: a fresh plain shell has no pane to ask (the
    // probe answers null) and a fresh session-host probe misreads a prompt helper (#916). Every
    // other session — a fresh tmux pane included — must prove a shell owns it.
    const trusted = trustsFreshShell({
      manual: false,
      fresh,
      persistent: created.persistent,
      sessionHost: created.sessionHost
    })
    if (!trusted) {
      let pane: string | null
      try {
        pane = await deps.paneCommand(key)
      } catch {
        pane = null
      }
      // Unknown is not a shell: an un-typed launch is recoverable (Run now), a spliced one is not.
      if (!isLaunchShell(pane)) return { outcome: 'failed', reason: 'no-shell', fresh }
    }
    const killLine = shellKillLineSequence(undefined, req.ptyOptions.shell)
    if (deps.mayDeliver && !await deps.mayDeliver()) return { outcome: 'failed', reason: 'cancelled', fresh }
    const outcome = await deliver(deps, key, req.command, killLine, !fresh)
    return outcome === 'submitted'
      ? { outcome: 'delivered', fresh }
      : { outcome: 'failed', reason: outcome, fresh }
  } finally {
    if (req.release) deps.releaseHeadless(key)
  }
}

/**
 * Wait for a fresh shell's prompt. This mirrors TerminalNode's `whenShellSettled` (SETTLE_QUIET_MS
 * of quiet after output, SETTLE_CAP_MS when there is no output at all), plus an absolute ceiling
 * (SETTLE_MAX_MS) that output never extends. The mounted version can do without one, because an
 * unmount cancels it. Nothing cancels this one, and the Server Edition awaits it inside its global
 * control lock, so a pane that paints more often than the quiet window would wedge every control
 * verb. Reaching the ceiling proceeds exactly as a settle does. The echo-verified writer is the
 * safety net for a line typed mid-print.
 */
function settle(deps: HeadlessLaunchDeps, key: string): Promise<void> {
  const quietMs = deps.timing?.quietMs ?? SETTLE_QUIET_MS
  const capMs = deps.timing?.capMs ?? SETTLE_CAP_MS
  const maxMs = deps.timing?.maxMs ?? SETTLE_MAX_MS
  return new Promise((resolve) => {
    let done = false
    let unsub: (() => void) | undefined
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(ceiling)
      unsub?.()
      resolve()
    }
    // Armed once, never re-armed by output.
    const ceiling = setTimeout(finish, maxMs)
    let timer = setTimeout(finish, capMs)
    try {
      unsub = deps.onOutput(key, () => {
        if (done) return
        clearTimeout(timer)
        timer = setTimeout(finish, quietMs)
      })
    } catch {
      // No tap to watch. Clear the timers and move on: the delivery opens its own tap, and its
      // failure ends the launch as `cancelled`.
      finish()
    }
  })
}

function deliver(
  deps: HeadlessLaunchDeps,
  key: string,
  command: string,
  killLine: string,
  clearFirst: boolean
): Promise<DeliveryOutcome> {
  return new Promise((resolve) => {
    const io: DeliveryIo = {
      write: (data) => {
        // A refused write means client 0 no longer holds the session: end the delivery (cancelled)
        // rather than keep typing into nothing.
        if (!deps.writeHeadless(key, data)) throw new Error('headless write refused')
      },
      onData: (cb) => deps.onOutput(key, cb)
    }
    try {
      // A live session may hold a half-typed line; start clean, as the manual Run now path does.
      if (clearFirst) io.write(killLine)
      deliverCommand(io, command, resolve, { killLine })
    } catch {
      resolve('cancelled')
    }
  })
}
