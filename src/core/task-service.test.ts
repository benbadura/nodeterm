import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { TaskService, type TaskServiceDeps } from './task-service'
import { TaskStore } from './task-store'
import { latestTaskRun, latestTaskResult, type TaskRecord, type TaskReply } from '../shared/tasks'
import type { ReadinessReportInput } from '../shared/task-readiness'

vi.mock('./git-env', () => ({ gitEnv: () => process.env }))
let root: string, service: TaskService, deps: TaskServiceDeps
const states = new Map<string, { state: string; verified: boolean }>()
const unwrap = <T,>(r: TaskReply<T>): T => { if (!r.ok) throw new Error(r.error); return r.value }
const read = async (task: TaskRecord) => unwrap(await service.read('project', task.id)).task
const create = async (planFirst = false) => unwrap(await service.create('project', { title: 'A useful outcome', criteria: [{ id: 'c1', text: 'Works as expected' }], planFirst }))
let sequence = 0
async function start(task: TaskRecord, requestId = `run-${++sequence}`) {
  const queued = unwrap(await service.act('project', task.id, task.revision, { type: 'start', requestId, agentId: 'claude', workspace: 'current' }))
  await vi.waitFor(async () => expect(latestTaskRun(await read(task))?.state).toBe('working'))
  return read(queued)
}
async function end(task: TaskRecord, errored = false) {
  const nodeId = latestTaskRun(task)!.nodeId
  states.set(nodeId, { state: 'done', verified: true })
  service.onAgentEvent({ kind: 'state', agentId: 'claude', nodeId, state: 'done', verified: true, errored })
  await service.idle()
  expect(['idle', 'reported', 'failed']).toContain(latestTaskRun(await read(task))?.state)
  return read(task)
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-')); states.clear()
  deps = { hostId: 'host', root: async () => root, node: async (_p, id) => ({ cwd: root, agentId: id === 'remote' ? 'remote' : 'claude', remote: id === 'remote' }),
    state: id => states.get(id), validate: () => {}, changed: () => {}, limit: () => 1,
    prepare: async () => ({ cwd: root, hostId: 'host' }), launch: vi.fn(async () => {}) }
  service = new TaskService(deps)
})
afterEach(async () => { service.stop(); await service.idle(); await fs.rm(root, { recursive: true, force: true }) })

describe('durable task lifecycle', () => {
  it('ends a turn without claiming completion, then records explicit acceptance with gaps', async () => {
    let task = await end(await start(await create()))
    expect(task.stage).toBe('in_progress'); expect(task.results).toEqual([])
    task = unwrap(await service.report('project', task.id, latestTaskRun(task)!.id, 'Implemented. Manual checks remain.'))
    expect(task.stage).toBe('ready_for_acceptance')
    expect(await service.act('project', task.id, task.revision, { type: 'accept', resultId: latestTaskResult(task)!.id, allowWarnings: false })).toMatchObject({ ok: false })
    task = unwrap(await service.act('project', task.id, task.revision, { type: 'accept', resultId: latestTaskResult(task)!.id, allowWarnings: true }))
    expect(task.stage).toBe('done'); expect(task.acceptances[0].warnings).toContain('No verification evidence recorded.')
    task = unwrap(await service.act('project', task.id, task.revision, { type: 'reopen' }))
    expect(task.acceptances).toHaveLength(1)
    const correction = await start(task)
    expect(correction.runs).toHaveLength(2); expect(correction.results).toHaveLength(1)
    expect(latestTaskResult(correction)).toBeUndefined()
    await end(correction)
  })
  it('requires plan approval and gives implementation a fresh run id', async () => {
    let task = await start(await create(true)); const planning = latestTaskRun(task)!
    expect(await service.report('project', task.id, planning.id, 'Trying to bypass planning')).toMatchObject({ ok: false })
    const file = path.join(root, 'plan.json'); await fs.writeFile(file, JSON.stringify({ plan: 'Inspect, implement, then verify.' }))
    expect(await service.control('project', planning.nodeId, { action: 'plan', file }, false)).toMatchObject({ ok: false })
    expect(await service.control('project', planning.nodeId, { action: 'plan', file }, true)).toMatchObject({ ok: true })
    task = await end(task)
    expect(latestTaskRun(task)!.plan).toContain('Inspect')
    task = unwrap(await service.act('project', task.id, task.revision, { type: 'approve-plan', requestId: 'approved-run' }))
    await vi.waitFor(async () => expect(latestTaskRun(await read(task))?.state).toBe('working'))
    task = await read(task)
    expect(task.runs.map(r => r.id)).toEqual([planning.id, 'approved-run'])
    expect(latestTaskRun(task)!.planApprovedAt).toBeDefined()
    expect(await service.report('project', task.id, planning.id, 'Late old run report')).toMatchObject({ ok: false })
    expect(await service.report('project', task.id, 'approved-run', 'Result')).toMatchObject({ ok: true })
    await end(task)
  })
  it('uses revision checks and launch request ids to prevent duplicate work', async () => {
    const task = await create(); const running = await start(task, 'same-request')
    expect(unwrap(await service.act('project', task.id, task.revision, { type: 'start', requestId: 'same-request', agentId: 'claude', workspace: 'current' })).runs).toHaveLength(1)
    expect(deps.launch).toHaveBeenCalledTimes(1)
    expect(await service.act('project', task.id, task.revision, { type: 'comment', text: 'stale' })).toMatchObject({ ok: false, conflict: { id: task.id } })
    expect(await service.act('project', task.id, running.revision, { type: 'accept', allowWarnings: true })).toMatchObject({ ok: false })
    await end(running)
  })
  it('keeps queued work paused on restart and recovers active work as unknown', async () => {
    const first = await start(await create()); const second = await create()
    const queued = unwrap(await service.act('project', second.id, second.revision, { type: 'start', requestId: 'queued', agentId: 'claude', workspace: 'current' }))
    expect(latestTaskRun(await read(queued))!.state).toBe('queued')
    service.stop(); deps.settled = async () => false; service = new TaskService(deps)
    const tasks = unwrap(await service.list('project'))
    expect(latestTaskRun(tasks.find(t => t.id === first.id)!)!.state).toBe('unknown')
    expect(deps.launch).toHaveBeenCalledTimes(1)
    const recovered = await read(first)
    expect(await service.act('project', first.id, recovered.revision, { type: 'start', requestId: 'unsafe', agentId: 'claude', workspace: 'current' })).toMatchObject({ ok: false })
    unwrap(await service.act('project', first.id, recovered.revision, { type: 'confirm-settled' }))
    await service.resumeQueue('project')
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledTimes(2))
    await end(await read(queued))
  })
  it('cancels a queued run without launching it and leaves the other task running', async () => {
    const first = await start(await create()); let second = await create()
    second = unwrap(await service.act('project', second.id, second.revision, { type: 'start', requestId: 'cancel-me', agentId: 'claude', workspace: 'current' }))
    second = unwrap(await service.act('project', second.id, second.revision, { type: 'cancel-queued' }))
    expect(latestTaskRun(second)?.error).toBe('Cancelled before launch.')
    await end(first); expect(deps.launch).toHaveBeenCalledTimes(1)
  })
  it('starts automatic review only after a reported implementation settles, and ignores old-session events', async () => {
    deps.settled = async nodeId => states.get(nodeId)?.state === 'done'
    let task = unwrap(await service.create('project', { title: 'Review this outcome', autoReview: true }))
    task = await start(task)
    const implementation = latestTaskRun(task)!
    states.set(implementation.nodeId, { state: 'working', verified: true })
    task = unwrap(await service.report('project', task.id, implementation.id, 'Implementation ready.'))
    expect(deps.launch).toHaveBeenCalledTimes(1)
    expect(await service.act('project', task.id, task.revision, { type: 'accept', resultId: latestTaskResult(task)!.id, allowWarnings: true })).toMatchObject({ ok: false })
    states.set(implementation.nodeId, { state: 'done', verified: true })
    service.onAgentEvent({ kind: 'state', agentId: 'claude', nodeId: implementation.nodeId, state: 'done', verified: false })
    await service.idle()
    expect(deps.launch).toHaveBeenCalledTimes(1)
    service.onAgentEvent({ kind: 'state', agentId: 'claude', nodeId: implementation.nodeId, state: 'done', verified: true })
    await service.idle()
    task = await read(task)
    expect(latestTaskRun(task)).toMatchObject({ role: 'review', state: 'working' })
    expect(deps.launch).toHaveBeenCalledTimes(2)
    const revision = task.revision
    service.onAgentEvent({ kind: 'state', agentId: 'claude', nodeId: implementation.nodeId, state: 'done', verified: true, errored: true })
    await service.idle()
    expect((await read(task)).revision).toBe(revision)
    expect(latestTaskRun(await read(task))?.state).toBe('working')
    await end(task)
  })
  it('releases a queued run after the user confirms that an unknown attached session has settled', async () => {
    deps.settled = async () => false
    let attached = await create()
    attached = unwrap(await service.act('project', attached.id, attached.revision, { type: 'attach', nodeId: 'existing' }))
    const queued = await create()
    unwrap(await service.act('project', queued.id, queued.revision, { type: 'start', requestId: 'waiting-for-confirmation', agentId: 'claude', workspace: 'current' }))
    await service.idle()
    expect(deps.launch).not.toHaveBeenCalled()
    unwrap(await service.act('project', attached.id, attached.revision, { type: 'confirm-settled' }))
    await service.idle()
    expect(deps.launch).toHaveBeenCalledTimes(1)
    expect(latestTaskRun(await read(queued))?.state).toBe('working')
    await end(await read(queued))
  })
  it('deduplicates issue imports and attaches a session without delivering instructions', async () => {
    const input = { title: 'Imported', legacyNodeId: 'existing', issueRef: { owner: 'O', repo: 'R', number: 4 } }
    let task = unwrap(await service.create('project', input))
    expect(unwrap(await service.create('project', { ...input, title: 'Refresh should be explicit' })).id).toBe(task.id)
    task = unwrap(await service.act('project', task.id, task.revision, { type: 'attach', nodeId: 'existing' }))
    expect(deps.launch).not.toHaveBeenCalled()
    const other = await create()
    expect(await service.act('project', other.id, other.revision, { type: 'attach', nodeId: 'existing' })).toMatchObject({ ok: false })
    expect(await service.control('project', 'different-node', { action: 'read' }, true)).toMatchObject({ ok: false })
    expect(await service.act('project', other.id, other.revision, { type: 'attach', nodeId: 'remote' })).toMatchObject({ ok: false })
  })
  it('freezes exact code evidence and warns after code or criteria changes', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
    git('init', '-b', 'main'); await fs.writeFile(path.join(root, 'code.txt'), 'base\n'); git('add', 'code.txt'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Base')
    let task = await start(await create()); const run = latestTaskRun(task)!
    const capture = unwrap(await service.capture('project', task.id, run.id))
    const na = { status: 'not-applicable' as const, reason: 'No UI or separate review in this task.', items: [] }
    const evidence: ReadinessReportInput = { snapshotId: capture.id, criteria: [{ id: 'c1', status: 'met', note: 'Verified behavior' }], tests: { status: 'recorded', items: [{ command: 'test', status: 'passed', summary: 'Passed', exitCode: 0 }] }, review: na, preview: na }
    task = unwrap(await service.report('project', task.id, run.id, 'Implemented and checked.', evidence))
    expect(unwrap(await service.read('project', task.id)).freshness).toBe('current')
    await fs.writeFile(path.join(root, 'code.txt'), 'changed after checks\n')
    expect(unwrap(await service.read('project', task.id)).freshness).toBe('stale')
    expect(await service.report('project', task.id, run.id, 'Reusing the snapshot', evidence)).toMatchObject({ ok: false })
    task = await end(task)
    const accepted = unwrap(await service.act('project', task.id, task.revision, { type: 'accept', resultId: latestTaskResult(task)!.id, allowWarnings: true }))
    expect(accepted.acceptances[0].snapshot?.fingerprint).toBe(capture.fingerprint)
    expect(accepted.results[0].report?.snapshot.fingerprint).toBe(capture.fingerprint)
    expect(accepted.acceptances[0].warnings.join(' ')).toContain('changed')
  })
  it('blocks a run when preparation fails and surfaces verified agent errors', async () => {
    deps.prepare = async () => { throw new Error('Worktree missing') }
    const task = await create()
    unwrap(await service.act('project', task.id, task.revision, { type: 'start', requestId: 'failed', agentId: 'claude', workspace: 'worktree' }))
    await vi.waitFor(async () => expect(latestTaskRun(await read(task))?.error).toBe('Worktree missing'))
    expect(deps.launch).not.toHaveBeenCalled()
    deps.prepare = async () => ({ cwd: root, hostId: 'host' })
    const retry = await start(await read(task)); const ended = await end(retry, true)
    expect(latestTaskRun(ended)?.state).toBe('failed'); expect(ended.stage).toBe('in_progress')
  })
  it('serializes store writers, refuses traversal and preserves a corrupt file', async () => {
    const task = await create(); const store = new TaskStore()
    expect(await service.read('project', '../escape')).toMatchObject({ ok: false })
    await fs.writeFile(path.join(root, '.nodeterm/tasks', `${task.id}.json`), '{broken')
    await expect(store.read(root, task.id)).rejects.toThrow()
    expect(await fs.readFile(path.join(root, '.nodeterm/tasks', `${task.id}.json`), 'utf8')).toBe('{broken')
  })
})
