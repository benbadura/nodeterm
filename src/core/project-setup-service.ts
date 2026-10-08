import { randomUUID } from 'node:crypto'
import os from 'os'
import path from 'path'
import { IPC } from '../shared/ipc'
import {
  projectTrustContent,
  resolveProjectSettings,
  type ProjectConsentRequest,
  type ProjectSettingsDoc,
  type ProjectSettingsSnapshot,
  type ProjectSetupConsentAnswer,
  type ProjectSetupConsentRequest,
  type ProjectSetupEvent,
  type ProjectSetupKind,
  type ProjectSetupRunResult,
  type ProjectTrustFamily
} from '../shared/project-settings'
import type { SshConnection } from '../shared/ssh'
import { platform } from './platform'
import { ProjectTrustStore, hashTrustContent, localTrustKey, sshTrustKey } from './project-trust-store'

/**
 * Runs a project's `setup`/`archive` script behind the trust gate.
 *
 * The load-bearing invariants:
 *  - Only a SHARED-sourced script is gated. A value the user typed into this machine's own local
 *    overlay is their own instruction and runs promptless; a value that arrived through git (or
 *    from a remote host) is hostile input until a human approves it at that location.
 *  - What is approved is the FAMILY, not the one script: the trust content covers setupScript AND
 *    archiveScript (`projectTrustContent('setup', …)`), hashed from the SHARED document alone —
 *    never the merged/effective one, or a local override could launder a shared change past the
 *    hash.
 *  - Trust is keyed by LOCATION (`localTrustKey`/`sshTrustKey`), never by project id: ids come out
 *    of an attacker-controlled `project.json` (hostile-project-json).
 *  - The answer is a trichotomy — approve / skip / nobody-answered. Only `approve` records and
 *    runs; an expired prompt is never a retroactive yes.
 *  - Prompts are serialized app-wide: one dialog at a time, so a workspace opening five projects
 *    cannot stack five modals over each other.
 *  - The prompt goes to the HOST's own UI (`sendConsent`), never to the broadcast fan-out: the
 *    question — and the script bytes it renders — belongs to the human at this machine.
 *
 * Spawning itself is injected (`runLocal`/`runSsh`) — this file knows nothing about child_process
 * or ssh, which is also what makes the gate testable without a shell.
 *
 * `ensureFamilyTrusted` is the same gate aimed at the families this service never RUNS — the launch
 * settings (`agents`) and the terminal program (`shell`) a caller elsewhere is about to consume. It
 * reuses every invariant above (one queue, one dialog, the trichotomy, location keying, host-only
 * delivery) through the same `queuePrompt` core, and adds one of its own: an approval broadcasts
 * `IPC.projectTrustChanged` so a renderer holding a stale "not trusted" verdict re-reads it.
 */

/** How long an unanswered consent prompt is held before it is dismissed and reported as
 *  `unanswered` — same bound as the ssh passphrase prompt. */
export const CONSENT_EXPIRY_MS = 300_000

export interface ProjectSetupTarget {
  projectId: string
  projectName: string
  /** Local project root — the trust location, and the spawn cwd when there is no worktree. */
  rootPath: string
  /** Set for a worktree run: the worktree dir (else rootPath). */
  worktreePath?: string
  ssh?: { server: Pick<SshConnection, 'host' | 'user' | 'port' | 'identityFile'>; remoteCwd: string }
}

export type ProjectSetupRunner = (opts: {
  script: string
  cwd: string
  env: Record<string, string>
  onChunk: (text: string) => void
  signal: AbortSignal
  ssh?: ProjectSetupTarget['ssh']
}) => Promise<{ exitCode: number }>

export interface ProjectSetupDeps {
  trust: ProjectTrustStore
  /** Reads the project's settings state (shared+local) — injected so both shells reuse WorkspaceStore. */
  readSettings(projectId: string): Promise<ProjectSettingsSnapshot | null>
  runLocal?: ProjectSetupRunner
  runSsh?: ProjectSetupRunner
  now?: () => number
  /**
   * WHERE a consent prompt (and its dismiss) is delivered. Injected because the answer differs per
   * shell and `platform().broadcast` — the only fan-out the core can see — is the WRONG answer on
   * the desktop: it also reaches every relay PEER, which would (a) disclose the shared script
   * bodies, the exact bytes being approved, to a guest who may have no other way to read that file,
   * and (b) put the host's trust dialog on a screen that is not the host's. Electron passes its
   * main-window-only send; the Server Edition leaves the default, where every attached client is an
   * authenticated operator of that host and broadcast is exactly right.
   *
   * Only the CONSENT pair is routed this way. Run `events` keep broadcasting: they are the canvas's
   * shared run state (a peer's canvas shows the same run), not the approval question.
   */
  sendConsent?: (channel: string, payload: unknown) => void
}

/** Single-flight identity: one live run per LOCATION per kind. Two canvas nodes pointing at the
 *  same folder are the same run, and a hostile `project.json` cannot buy a second concurrent run
 *  by renaming its project id. */
export function setupRunKey(target: ProjectSetupTarget, kind: ProjectSetupKind): string {
  return `${kind}\0${runLocationKey(target)}`
}

function runLocationKey(target: ProjectSetupTarget): string {
  return target.ssh
    ? sshTrustKey({ server: target.ssh.server, remoteCwd: target.ssh.remoteCwd })
    : localTrustKey(target.worktreePath ?? target.rootPath)
}

/** The APPROVAL location — the project root, so a per-worktree run inherits the root's approval
 *  (the settings document it executes is the root's, shared by every worktree of that repo). */
function trustKeyFor(target: ProjectSetupTarget): string {
  return target.ssh
    ? sshTrustKey({ server: target.ssh.server, remoteCwd: target.ssh.remoteCwd })
    : localTrustKey(target.rootPath)
}

/** Exactly the two fields `projectTrustContent('setup', …)` hashes, from the SHARED document — so a
 *  dialog rendering this shows the full extent of what one approval covers, and nothing else. */
function familyScripts(sharedDoc: ProjectSettingsDoc): ProjectSetupConsentRequest['scripts'] {
  const out: ProjectSetupConsentRequest['scripts'] = {}
  if (sharedDoc.setup?.setupScript !== undefined) out.setup = sharedDoc.setup.setupScript
  if (sharedDoc.setup?.archiveScript !== undefined) out.archive = sharedDoc.setup.archiveScript
  return out
}

/** The families `ensureFamilyTrusted` answers for: everything a launcher consumes but this service
 *  never runs itself. `setup` is excluded on purpose — the runner owns that gate, and admitting it
 *  here would be a second, run-less way to raise a setup prompt. */
export type ProjectConsumerFamily = Exclude<ProjectTrustFamily, 'setup'>

/** The dialog payload for a consumer family, built from the SHARED document alone — exactly the
 *  fields `projectTrustContent(family, …)` hashes, so what is rendered is what is approved. */
function familyConsentPayload(
  family: ProjectConsumerFamily,
  sharedDoc: ProjectSettingsDoc,
  base: { requestId: string; previouslyApproved: boolean; projectName: string; locationLabel: string }
): ProjectConsentRequest {
  if (family === 'shell') {
    // Non-null by construction: a null `projectTrustContent('shell', …)` returned before this point.
    return { family: 'shell', ...base, shell: sharedDoc.terminal?.shell ?? '' }
  }
  const agents = sharedDoc.agents
  const req: ProjectConsentRequest = { family: 'agents', ...base }
  if (agents?.launchCmd !== undefined) req.launchCmd = agents.launchCmd
  if (agents?.env) {
    // Key-sorted, like the hash's own canonical form, so the dialog's order is the approved order.
    const env: Record<string, string> = {}
    for (const k of Object.keys(agents.env).sort()) env[k] = agents.env[k]
    req.env = env
  }
  return req
}

function locationLabel(target: ProjectSetupTarget): string {
  if (target.ssh) return `${target.ssh.server.user}@${target.ssh.server.host}:${target.ssh.remoteCwd}`
  const abs = path.resolve(target.rootPath)
  const home = os.homedir()
  return home && (abs === home || abs.startsWith(home + path.sep)) ? `~${abs.slice(home.length)}` : abs
}

interface ActiveRun {
  runKey: string
  /** Unique per launch, unlike `runKey` (which is the deterministic single-flight key). Every event
   *  carries it so a client can tell this run from the PREVIOUS run of the same script. */
  runId: string
  projectId: string
  kind: ProjectSetupKind
  abort: AbortController
  seq: number
  closed: boolean
  /** The dialog this run is currently blocked on, so `cancel` can close it instead of leaving a
   *  modal up for a run that no longer exists. */
  consentRequestId?: string
}

interface TrustFlight {
  promise: Promise<boolean>
  /** Every project id that asked while this one question was open. All of them are invalidated on
   *  an approval: two canvas nodes on one folder share a trust key but not a project id. */
  projectIds: Set<string>
}

export class ProjectSetupService {
  private readonly completion = new Map<string, Promise<boolean>>()
  private readonly completionResolvers = new Map<string, (ok: boolean) => void>()

  /** Host orchestration waits for the actual script exit, independent of a mounted UI. */
  async runAndWait(target: ProjectSetupTarget): Promise<void> {
    const result = await this.run(target, 'setup')
    if (result.status === 'skipped') {
      if (result.reason === 'no-script') return
      throw new Error(`Project setup did not run: ${result.reason}.`)
    }
    const ok = await this.completion.get(result.runId)
    this.completion.delete(result.runId)
    if (!ok) throw new Error('Project setup failed or was cancelled.')
  }
  private readonly active = new Map<string, ActiveRun>()
  private readonly pending = new Map<string, (answer: ProjectSetupConsentAnswer | undefined) => void>()
  /** App-wide prompt queue: each ask chains onto the previous one, so only one dialog is live.
   *  SHARED with `ensureFamilyTrusted` — a launch prompt and a setup prompt are the same modal. */
  private consentQueue: Promise<unknown> = Promise.resolve()
  /** Live `ensureFamilyTrusted` asks, keyed by (family, LOCATION) — see `ensureFamilyTrusted`. */
  private readonly trustFlights = new Map<string, TrustFlight>()

  constructor(private readonly deps: ProjectSetupDeps) {}

  async run(target: ProjectSetupTarget, kind: ProjectSetupKind): Promise<ProjectSetupRunResult> {
    const snap = await this.deps.readSettings(target.projectId)
    const resolved = resolveProjectSettings(snap?.local, snap?.shared ?? undefined)
    const picked = kind === 'setup' ? resolved.setup.setupScript : resolved.setup.archiveScript
    const script = picked?.value ?? ''
    if (!script.trim()) return { status: 'skipped', reason: 'no-script' }

    const runKey = setupRunKey(target, kind)
    if (this.active.has(runKey)) return { status: 'skipped', reason: 'busy' }
    const runner = target.ssh ? this.deps.runSsh : this.deps.runLocal
    if (!runner) return { status: 'skipped', reason: 'unavailable' }

    // Claimed BEFORE the consent await on purpose: while a dialog for this location is open, a
    // second launch must be `busy`, not a second dialog asking about the same script.
    const entry: ActiveRun = { runKey, runId: randomUUID(), projectId: target.projectId, kind, abort: new AbortController(), seq: 0, closed: false }
    this.active.set(runKey, entry)
    const abandon = (reason: 'declined' | 'unanswered' | 'unavailable' | 'no-script'): ProjectSetupRunResult => {
      this.active.delete(runKey)
      return { status: 'skipped', reason }
    }

    if (picked!.source === 'shared') {
      const sharedDoc: ProjectSettingsDoc = snap?.shared ?? {}
      const content = projectTrustContent('setup', sharedDoc)
      // Unreachable by construction (a 'shared' source means the shared doc carries this script);
      // fail closed rather than run something no hash covers.
      if (content === null) return abandon('no-script')
      const hash = hashTrustContent(content)
      const key = trustKeyFor(target)
      let trusted: boolean
      try {
        trusted = await this.deps.trust.isTrusted(key, 'setup', hash)
      } catch {
        return abandon('unavailable')
      }
      if (!trusted) {
        const answer = await this.askConsent(entry, key, {
          kind,
          projectName: target.projectName,
          locationLabel: locationLabel(target),
          // The FAMILY is what gets approved, so the dialog is handed both scripts — and from the
          // shared document alone, so what it renders is exactly what the hash covers.
          scripts: familyScripts(sharedDoc)
        })
        // A cancel raised while the dialog was open already aborted this run; it must not proceed
        // on an answer (or a race with one) that arrived anyway.
        if (entry.abort.signal.aborted) return abandon('declined')
        if (answer !== 'approve') return abandon(answer === 'skip' ? 'declined' : 'unanswered')
        try {
          await this.deps.trust.record(key, 'setup', hash, new Date(this.now()).toISOString())
        } catch {
          // The approval could not be persisted, so it is not an approval — fail closed rather
          // than run on a grant that exists only in memory.
          return abandon('unavailable')
        }
      }
    }

    // Covers a cancel raised during any of the awaits above (readSettings, the trust read/write).
    if (entry.abort.signal.aborted) return abandon('declined')

    void this.execute(entry, runner, script, target)
    // `runId` travels back with the ack so the initiator can attach THIS run (not the previous run
    // of the same script, which shares `runKey`) to its own lane.
    return {
      status: 'started',
      runKey,
      runId: entry.runId,
      waitForSetup: resolved.setup.waitForSetup?.value === true
    }
  }

  /**
   * The SAME gate as `run`'s, for a family this service never executes: `agents` (launchCmd + env)
   * and `shell` (the terminal program). A launcher calls this before it consumes a shared-sourced
   * value; `true` means that family is trusted AT THIS LOCATION right now.
   *
   *  - Nothing executable in the SHARED document (`projectTrustContent` → null) → `true` with NO
   *    prompt. There is nothing hostile to gate: a value that exists only in this machine's local
   *    overlay is the user's own instruction (the same rule `run` applies to a local script).
   *  - Already trusted (the family's shared-content hash matches the record) → `true`, no prompt.
   *  - Otherwise ONE prompt, on the app-wide queue, and only `approve` records — skip and expiry
   *    are both `false`, and neither leaves anything behind. A record that cannot be persisted is
   *    not an approval either (fail closed rather than grant something only memory knows).
   *
   * SINGLE-FLIGHT per (family, LOCATION): concurrent askers share one promise, so five nodes
   * launching against the same folder raise ONE dialog, not five. The flight is keyed by the trust
   * key — the same identity the approval itself is keyed by — so joiners are asking the same
   * question about the same document, and every joiner's projectId is invalidated on approval.
   */
  async ensureFamilyTrusted(target: ProjectSetupTarget, family: ProjectConsumerFamily): Promise<boolean> {
    const trustKey = trustKeyFor(target)
    const flightKey = `${family}\0${trustKey}`
    const inflight = this.trustFlights.get(flightKey)
    if (inflight) {
      inflight.projectIds.add(target.projectId)
      return inflight.promise
    }
    const flight: TrustFlight = { projectIds: new Set([target.projectId]), promise: Promise.resolve(false) }
    // Registered BEFORE the first await inside `resolveFamilyTrust` can settle, so a caller that
    // asks in the same tick joins this flight instead of opening a second dialog.
    flight.promise = this.resolveFamilyTrust(target, family, trustKey, flight).finally(() => {
      this.trustFlights.delete(flightKey)
    })
    this.trustFlights.set(flightKey, flight)
    return flight.promise
  }

  private async resolveFamilyTrust(
    target: ProjectSetupTarget,
    family: ProjectConsumerFamily,
    trustKey: string,
    flight: TrustFlight
  ): Promise<boolean> {
    let snap: ProjectSettingsSnapshot | null
    try {
      snap = await this.deps.readSettings(target.projectId)
    } catch {
      return false // settings unreadable → no verdict, and a no-verdict is never a yes
    }
    const sharedDoc: ProjectSettingsDoc = snap?.shared ?? {}
    const content = projectTrustContent(family, sharedDoc)
    if (content === null) return true // nothing shared to gate
    const hash = hashTrustContent(content)
    let trusted: boolean
    try {
      trusted = await this.deps.trust.isTrusted(trustKey, family, hash)
    } catch {
      return false
    }
    if (trusted) return true

    const answer = await this.askFamilyConsent(trustKey, family, sharedDoc, target)
    if (answer !== 'approve') return false
    try {
      await this.deps.trust.record(trustKey, family, hash, new Date(this.now()).toISOString())
    } catch {
      return false
    }
    // The renderer's launch-info cache is keyed by project id, so every asker is told — including
    // the ones that merely joined this flight.
    for (const projectId of flight.projectIds) {
      platform().broadcast(IPC.projectTrustChanged, { projectId })
    }
    return true
  }

  private askFamilyConsent(
    trustKey: string,
    family: ProjectConsumerFamily,
    sharedDoc: ProjectSettingsDoc,
    target: ProjectSetupTarget
  ): Promise<ProjectSetupConsentAnswer | undefined> {
    return this.queuePrompt({
      trustKey,
      family,
      payload: (base) =>
        familyConsentPayload(family, sharedDoc, {
          ...base,
          projectName: target.projectName,
          locationLabel: locationLabel(target)
        })
    })
  }

  /** Aborts a run — live OR still waiting at its consent dialog. `false` = nothing by that runKey
   *  exists (already finished, or never did). */
  cancel(runKey: string): boolean {
    const entry = this.active.get(runKey)
    if (!entry) return false
    entry.abort.abort()
    const requestId = entry.consentRequestId
    if (requestId) {
      // The run this dialog belonged to is gone: close it (and free the queue) rather than leave a
      // modal whose answer can no longer mean anything. Resolving the pending entry also drops it
      // from `pending`, so a late approve for it is a no-op.
      this.pending.get(requestId)?.(undefined)
      this.sendConsent(IPC.projectSetupConsentDismiss, { requestId })
    }
    return true
  }

  /**
   * Shell shutdown: abort every run still in flight. A local run is a DETACHED process group
   * (setsid, so a cancel can SIGKILL the whole tree) — which is also why quitting without this
   * leaves `npm ci` churning with nothing left to report to. Goes through `cancel`, so a run parked
   * at its consent dialog is closed and its dialog dismissed too. Idempotent: Electron's
   * `before-quit` runs twice, and the second pass finds nothing left.
   */
  disposeAll(): void {
    for (const runKey of [...this.active.keys()]) this.cancel(runKey)
  }

  /** Renderer answer for a pending consent prompt. An unknown/stale requestId (expired, double
   *  submit) and an unrecognized answer are silent no-ops — never an approval. */
  submitConsent(requestId: string, answer: ProjectSetupConsentAnswer): void {
    if (answer !== 'approve' && answer !== 'skip') return
    this.pending.get(requestId)?.(answer)
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** The consent pair's delivery, per shell (see `ProjectSetupDeps.sendConsent`). */
  private sendConsent(channel: string, payload: unknown): void {
    if (this.deps.sendConsent) this.deps.sendConsent(channel, payload)
    else platform().broadcast(channel, payload)
  }

  private askConsent(
    entry: ActiveRun,
    trustKey: string,
    req: Omit<ProjectSetupConsentRequest, 'requestId' | 'previouslyApproved'>
  ): Promise<ProjectSetupConsentAnswer | undefined> {
    return this.queuePrompt({
      trustKey,
      family: 'setup',
      // Cancelled while queued behind another dialog — never raise one for a run that is gone.
      skipIf: () => entry.abort.signal.aborted,
      // So `cancel` can close the dialog this run is parked at instead of leaving a modal up for a
      // run that no longer exists.
      bind: (requestId) => {
        entry.consentRequestId = requestId
      },
      payload: (base) => ({ family: 'setup', ...req, ...base })
    })
  }

  /**
   * THE prompt: one dialog at a time, app-wide, whatever family asked. Shared by the setup runner
   * (`askConsent`) and the launch-settings gate (`askFamilyConsent`) so there is exactly one place
   * that mints a requestId, holds the expiry, and delivers through the host-only seam — a second
   * copy of this is how one caller ends up with a prompt that cannot expire, or that a stale
   * requestId can answer.
   */
  private queuePrompt(opts: {
    trustKey: string
    family: ProjectTrustFamily
    /** Checked at PROMPT time (not enqueue time): true → no dialog, answer `undefined`. */
    skipIf?: () => boolean
    /** The live requestId while the dialog is up, then `undefined`. */
    bind?: (requestId: string | undefined) => void
    payload: (base: { requestId: string; previouslyApproved: boolean }) => ProjectConsentRequest
  }): Promise<ProjectSetupConsentAnswer | undefined> {
    const step = this.consentQueue.then(async () => {
      if (opts.skipIf?.()) return undefined
      // Read at PROMPT time, not at enqueue time: an earlier prompt in the queue may have just
      // recorded an approval for this same location. Dialog copy only — the grant was the
      // `isTrusted` hash comparison, which already said no.
      const previouslyApproved = !!(await this.deps.trust.getRecord(opts.trustKey, opts.family))
      return new Promise<ProjectSetupConsentAnswer | undefined>((resolve) => {
        const requestId = randomUUID()
        const settle = (answer: ProjectSetupConsentAnswer | undefined): void => {
          this.pending.delete(requestId)
          opts.bind?.(undefined)
          resolve(answer)
        }
        const timer = setTimeout(() => {
          settle(undefined) // expired, NOT declined
          this.sendConsent(IPC.projectSetupConsentDismiss, { requestId })
        }, CONSENT_EXPIRY_MS)
        timer.unref?.()
        this.pending.set(requestId, (answer) => {
          clearTimeout(timer)
          settle(answer)
        })
        opts.bind?.(requestId)
        this.sendConsent(IPC.projectSetupConsentRequest, opts.payload({ requestId, previouslyApproved }))
      })
    })
    // A rejected step must not poison the queue for every later prompt.
    this.consentQueue = step.catch(() => {})
    return step
  }

  private async execute(
    entry: ActiveRun,
    runner: ProjectSetupRunner,
    script: string,
    target: ProjectSetupTarget
  ): Promise<void> {
    this.completion.set(entry.runId, new Promise(resolve => this.completionResolvers.set(entry.runId, resolve)))
    // For an ssh run every path the script sees is the REMOTE one — a local Mac path in these env
    // vars would name a directory that does not exist on the host.
    const cwd = target.ssh ? target.ssh.remoteCwd : target.worktreePath ?? target.rootPath
    const rootPath = target.ssh ? target.ssh.remoteCwd : target.rootPath
    const env = {
      NODETERM_ROOT_PATH: rootPath,
      NODETERM_WORKTREE_PATH: cwd,
      NODETERM_PROJECT_NAME: target.projectName
    }
    this.emit(entry, { state: 'running' })
    let exitCode: number | undefined
    let threw = false
    try {
      const res = await runner({
        script,
        cwd,
        env,
        // Raw pass-through: the runner edge does the debouncing/capping, so nothing is coalesced
        // twice and this layer never holds output back.
        onChunk: (text) => {
          if (text) this.emit(entry, { state: 'running', chunk: text })
        },
        signal: entry.abort.signal,
        ssh: target.ssh
      })
      exitCode = res.exitCode
    } catch {
      threw = true
    } finally {
      this.active.delete(entry.runKey)
    }
    if (entry.abort.signal.aborted) this.emit(entry, { state: 'cancelled', exitCode })
    else if (threw) this.emit(entry, { state: 'failed' })
    else this.emit(entry, { state: exitCode === 0 ? 'done' : 'failed', exitCode })
    entry.closed = true
    this.completionResolvers.get(entry.runId)?.(!threw && !entry.abort.signal.aborted && exitCode === 0)
    this.completionResolvers.delete(entry.runId)
    // Keep only a small completed tail for callers whose acknowledgement races a fast script.
    for (const key of this.completion.keys()) {
      if (this.completion.size <= 200) break
      if (!this.completionResolvers.has(key)) this.completion.delete(key)
    }
  }

  private emit(entry: ActiveRun, ev: Omit<ProjectSetupEvent, 'runKey' | 'runId' | 'kind' | 'seq'>): void {
    // A chunk arriving after the terminal event (a runner that keeps draining) would reopen a run
    // the UI has already closed out.
    if (entry.closed) return
    entry.seq += 1
    const full: ProjectSetupEvent = {
      runKey: entry.runKey,
      runId: entry.runId,
      kind: entry.kind,
      seq: entry.seq,
      ...ev
    }
    platform().broadcast(IPC.projectSetupEvent(entry.projectId), full)
  }
}
