import { describe, it, expect } from 'vitest'
import { runBootstrap, type BootstrapDeps } from './team-bootstrap'
import type { HostedService, HostingWait } from './hosted-service'
import type { TeamRole } from './team-store'

const KEY = 'A'.repeat(43) + '=' // the test never decodes it — runBootstrap trusts the parsed request
const INFO = { relayEndpoint: 'wss://r', hostId: 'H', hostPublicKeyB64: 'P', hostDeviceId: 'D', label: 'box' }

function deps(
  o: {
    created?: boolean
    start?: string
    wait?: HostingWait
    role?: TeamRole | null
    shared?: string[]
    adopt?: { projectId: string; projectName: string; created: boolean } | Error
    closing?: boolean
  } = {}
): { d: BootstrapDeps; calls: string[] } {
  const calls: string[] = []
  const shared = new Set(o.shared ?? [])
  const svc = {
    init: async () => (calls.push('init'), { created: o.created ?? true }),
    start: async () => (calls.push('start'), o.start ?? 'started'),
    waitForHosting: async () => (calls.push('wait'), o.wait ?? 'up'),
    roleOf: () => o.role ?? null,
    addOwner: async (_k: string, l: string) => void calls.push(`owner:${l}`),
    share: async (p: string) => void (calls.push(`share:${p}`), shared.add(p)),
    sharedProjectIds: () => shared,
    info: () => INFO,
    joinCode: () => 'nodeterm://join/CODE'
  } as unknown as HostedService
  const d: BootstrapDeps = {
    svc,
    adoptFolder: async (cwd) => {
      calls.push(`adopt:${cwd}`)
      if (o.adopt instanceof Error) throw o.adopt
      return o.adopt ?? { projectId: 'project-1', projectName: 'proj', created: true }
    },
    closing: () => o.closing ?? false
  }
  return { d, calls }
}
const REQ = { ownerKey: KEY, ownerLabel: 'Mac', adoptCwd: '/home/u/proj' }

describe('runBootstrap', () => {
  it('a fresh host: init, start, wait, owner, adopt, share — in that order — and the join code', async () => {
    const { d, calls } = deps()
    expect(await runBootstrap(d, REQ)).toEqual({
      hostId: 'H',
      projectId: 'project-1',
      projectName: 'proj',
      joinCode: 'nodeterm://join/CODE',
      hosting: 'up',
      created: { team: true, owner: true, project: true, share: true }
    })
    expect(calls).toEqual(['init', 'start', 'wait', 'owner:Mac', 'adopt:/home/u/proj', 'share:project-1'])
  })

  it('a re-run on a set-up host changes nothing: every created flag false, no second share', async () => {
    const { d, calls } = deps({
      created: false,
      role: 'owner',
      shared: ['project-1'],
      adopt: { projectId: 'project-1', projectName: 'proj', created: false }
    })
    const r = await runBootstrap(d, REQ)
    expect(r.created).toEqual({ team: false, owner: false, project: false, share: false })
    expect(calls).not.toContain('share:project-1')
    expect(calls.some((c) => c.startsWith('owner:'))).toBe(false)
  })

  it('an existing editor is promoted (created.owner true)', async () => {
    const { d } = deps({ role: 'editor' })
    expect((await runBootstrap(d, REQ)).created.owner).toBe(true)
  })

  it('E_HOSTING_OFF when start does not start, before anything else changes', async () => {
    const { d, calls } = deps({ start: 'host-key-unreadable' })
    await expect(runBootstrap(d, REQ)).rejects.toMatchObject({ code: 'E_HOSTING_OFF' })
    expect(calls).toEqual(['init', 'start'])
  })

  it('E_HOSTING_OFF with the scheduler reason when the backend refuses, nothing adopted or shared', async () => {
    const { d, calls } = deps({ wait: { refused: 'refused (403)' } })
    await expect(runBootstrap(d, REQ)).rejects.toMatchObject({
      code: 'E_HOSTING_OFF',
      message: expect.stringContaining('refused (403)')
    })
    expect(calls.some((c) => c.startsWith('adopt') || c.startsWith('share') || c.startsWith('owner'))).toBe(false)
  })

  it("'starting' is still a success: the desktop's join retries", async () => {
    const { d } = deps({ wait: 'starting' })
    expect((await runBootstrap(d, REQ)).hosting).toBe('starting')
  })

  it('an adopt failure propagates its code and nothing is shared', async () => {
    const { d, calls } = deps({ adopt: Object.assign(new Error('bad'), { code: 'E_ADOPT_FAILED' }) })
    await expect(runBootstrap(d, REQ)).rejects.toMatchObject({ code: 'E_ADOPT_FAILED' })
    expect(calls.some((c) => c.startsWith('share'))).toBe(false)
  })

  it('a server shutting down after init does not start hosting, and says so with a code', async () => {
    // Coded, so the desktop never reads it as a bootstrap that may have finished.
    const { d, calls } = deps({ closing: true })
    await expect(runBootstrap(d, REQ)).rejects.toMatchObject({ code: 'E_HOSTING_OFF', message: expect.stringMatching(/shutting down/) })
    expect(calls).toEqual(['init'])
  })
})
