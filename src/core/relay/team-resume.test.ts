import { describe, it, expect } from 'vitest'
import { runResume, RESUME_CONCURRENCY, type ResumeDeps } from './team-resume'
import type { CanvasNodeState, Project } from '../../shared/types'

const node = (o: Partial<CanvasNodeState>): CanvasNodeState =>
  ({ id: 'term-1', kind: 'terminal', position: { x: 0, y: 0 }, title: 'T', color: '#fff', ...o }) as CanvasNodeState
const PROJECT = {
  id: 'project-1', name: 'p', color: '#fff', cwd: '/home/u/p', viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    node({ id: 'term-a', agentId: 'claude', cwd: '/home/u/p' }),
    node({ id: 'term-b', agentId: 'codex' }),
    node({ id: 'term-c', agentId: 'gemini' }),
    node({ id: 'term-acct', agentId: 'claude', accountId: 'acct-1' }),
    node({ id: 'term-plain' }),
    node({ id: 'sticky-1', kind: 'sticky' })
  ]
} as unknown as Project

function deps(o: { verdict?: Record<string, 'present' | 'absent' | 'unknown'>; launch?: 'delivered' | 'failed'; inFlight?: Set<string> } = {}) {
  const launched: Array<{ nodeId: string; command: string }> = []
  let inFlight = 0
  let peak = 0
  const d: ResumeDeps = {
    inFlight: o.inFlight ?? new Set<string>(),
    loadProject: async (id) => (id === 'project-1' ? PROJECT : null),
    sessionVerdict: async (nodeId) => o.verdict?.[nodeId] ?? 'absent',
    command: async (entry) => `${entry.agentId} --resume ${entry.sessionId}${entry.permissionMode ? ` <${entry.permissionMode}>` : ''}`,
    launch: async (_p, n, command) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      launched.push({ nodeId: n.id, command })
      return o.launch === 'failed' ? { outcome: 'failed', reason: 'no-shell' } : { outcome: 'delivered', fresh: true }
    }
  }
  return { d, launched, peak: () => peak }
}
const E = (nodeId: string, agentId = 'claude', sessionId = 'sess-1', permissionMode?: string) => ({ nodeId, agentId, sessionId, ...(permissionMode ? { permissionMode } : {}) })

describe('runResume', () => {
  it('launches a valid entry with the composed command and reports resumed', async () => {
    const { d, launched } = deps()
    expect(await runResume(d, { projectId: 'project-1', sessions: [E('term-a', 'claude', 's1', 'auto')] })).toEqual({
      results: [{ nodeId: 'term-a', status: 'resumed' }]
    })
    expect(launched).toEqual([{ nodeId: 'term-a', command: 'claude --resume s1 <auto>' }])
  })
  it('an unknown permission mode is dropped (bare command), never forwarded', async () => {
    const { d, launched } = deps()
    await runResume(d, { projectId: 'project-1', sessions: [E('term-a', 'claude', 's1', 'constructor')] })
    expect(launched[0].command).toBe('claude --resume s1')
  })
  it('a live session answers already-running and is not launched again', async () => {
    const { d, launched } = deps({ verdict: { 'term-a': 'present' } })
    expect((await runResume(d, { projectId: 'project-1', sessions: [E('term-a')] })).results[0].status).toBe('already-running')
    expect(launched).toEqual([])
  })
  it('an unknown verdict is refused (never a launch on uncertainty)', async () => {
    const { d, launched } = deps({ verdict: { 'term-a': 'unknown' } })
    expect((await runResume(d, { projectId: 'project-1', sessions: [E('term-a')] })).results[0]).toMatchObject({ status: 'refused' })
    expect(launched).toEqual([])
  })
  it('refuses, per entry: no such node, a sticky, a non-resumable agent, a mismatched agent, a managed account, an unsafe session id, a duplicate', async () => {
    const { d, launched } = deps()
    const r = await runResume(d, {
      projectId: 'project-1',
      sessions: [
        E('term-zzz'), E('sticky-1'), E('term-plain', 'mycustom'), E('term-c', 'claude'),
        E('term-acct'), E('term-a', 'claude', '../../etc'), E('term-b', 'codex', 's2'), E('term-b', 'codex', 's3')
      ]
    })
    expect(r.results.map((x) => x.status)).toEqual(['refused', 'refused', 'refused', 'refused', 'refused', 'refused', 'resumed', 'refused'])
    expect(r.results.every((x) => x.status !== 'refused' || typeof x.reason === 'string')).toBe(true)
    expect(launched.map((l) => l.nodeId)).toEqual(['term-b'])
  })
  it('a failed launch is refused with its reason', async () => {
    const { d } = deps({ launch: 'failed' })
    expect((await runResume(d, { projectId: 'project-1', sessions: [E('term-a')] })).results[0]).toMatchObject({ status: 'refused', reason: expect.stringMatching(/no-shell/) })
  })
  it('an unknown project is a coded refusal of the whole request', async () => {
    const { d } = deps()
    await expect(runResume(d, { projectId: 'nope', sessions: [] })).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
  })
  it('two overlapping requests never resume one node twice; the node is free again once its launch settles', async () => {
    // The CLI's 60 s timeout can end the desktop's call while the server keeps draining it, and the
    // user runs Share again: both requests would see `absent` and type `--resume` twice.
    const shared = new Set<string>()
    const first = deps({ inFlight: shared })
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const realLaunch = first.d.launch
    first.d.launch = async (...args) => {
      await held
      return realLaunch(...args)
    }
    const running = runResume(first.d, { projectId: 'project-1', sessions: [E('term-a'), E('term-b', 'codex', 's2')] })
    await new Promise((r) => setTimeout(r, 0))
    const second = deps({ inFlight: shared })
    const overlap = await runResume(second.d, { projectId: 'project-1', sessions: [E('term-a')] })
    expect(overlap.results).toEqual([{ nodeId: 'term-a', status: 'already-running' }])
    expect(second.launched).toEqual([])
    release()
    expect((await running).results.map((x) => x.status)).toEqual(['resumed', 'resumed'])
    expect(shared.size).toBe(0)
    // Released after a FAILED launch too: a later request may try again.
    const failing = deps({ inFlight: shared })
    failing.d.launch = async () => {
      throw new Error('boom')
    }
    expect((await runResume(failing.d, { projectId: 'project-1', sessions: [E('term-a')] })).results[0]).toMatchObject({ status: 'refused' })
    expect(shared.size).toBe(0)
    const third = deps({ inFlight: shared })
    expect((await runResume(third.d, { projectId: 'project-1', sessions: [E('term-a')] })).results[0].status).toBe('resumed')
  })
  it(`never runs more than ${RESUME_CONCURRENCY} launches at once, and keeps result order`, async () => {
    const nodes = Array.from({ length: 10 }, (_, i) => node({ id: `t${i}`, agentId: 'claude' }))
    const { d, peak } = deps()
    d.loadProject = async () => ({ ...PROJECT, nodes }) as Project
    const r = await runResume(d, { projectId: 'project-1', sessions: nodes.map((n) => E(n.id)) })
    expect(peak()).toBeLessThanOrEqual(RESUME_CONCURRENCY)
    expect(r.results.map((x) => x.nodeId)).toEqual(nodes.map((n) => n.id))
  })
})
