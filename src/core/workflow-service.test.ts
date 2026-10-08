import { describe, expect, it, vi } from 'vitest'
import { WorkflowService, type WorkflowServiceDeps } from './workflow-service'
import { currentWorkflowAttempt, type WorkflowRun, type ProjectWorkflows } from '../shared/workflows'
import type { StationOutcomeRecord } from '../shared/station-outcome'

const ref = { owner: 'org', repo: 'repo', number: 42 }
function harness(saved: WorkflowRun[] = [], manual = false) {
  let clock = 100
  let durable = structuredClone(saved)
  let held = false
  let settled = true
  let sessionExists = true
  let templates: ProjectWorkflows = { defaultTemplateId: 'fix', templates: [{ id: 'fix', name: 'Fix', steps: [
    { id: 'a', title: 'Reproduce', agentId: 'claude', instruction: 'Reproduce the bug.', transition: manual ? 'manual' : 'success' },
    { id: 'b', title: 'Fix', agentId: 'codex', instruction: 'Fix it.', transition: 'success' }
  ] }] }
  const outcomes = new Map<string, StationOutcomeRecord>()
  const deps: WorkflowServiceDeps = {
    persistence: { load: vi.fn(async () => durable), save: vi.fn(async value => { durable = structuredClone(value) }) },
    templates: async () => templates, saveTemplates: async (_id, value) => { templates = value },
    validate: vi.fn(async () => {}), planWorktree: vi.fn(async () => ({ repoPath: '/repo', path: '/wt', branch: 'issue-42', baseRef: 'main' })),
    prepare: vi.fn(async () => {}), checkWorktree: vi.fn(async () => {}), launch: vi.fn(async () => {}),
    canRetry: vi.fn(async () => true), outcome: id => outcomes.get(id), held: () => held, settled: () => settled,
    sessionExists: async () => sessionExists, publish: vi.fn(), now: () => ++clock
  }
  const service = new WorkflowService(deps)
  const run = async () => (await service.list('p'))[0]
  const flush = async () => { for (let i = 0; i < 15; i++) { await service.idle(); await Promise.resolve() } }
  const event = (nodeId: string, state: 'working' | 'done', flags = {}) => service.onAgentEvent({ nodeId, agentId: 'claude', kind: 'state', verified: true, state, ...(state === 'working' ? { newTurn: true } : {}), ...flags })
  const start = async () => {
    const result = await service.start('p', 'fix', ref)
    expect(result.ok).toBe(true); await flush()
    return (await run())!
  }
  const report = (nodeId: string, outcome: 'succeeded' | 'failed' = 'succeeded') => {
    outcomes.set(nodeId, { nodeId, outcome, at: ++clock, note: outcome === 'failed' ? 'Tests failed' : undefined }); service.refresh()
  }
  return { service, deps, run, start, event, report, flush, outcomes,
    durable: () => durable, setHeld: (value: boolean) => { held = value }, setSettled: (value: boolean) => { settled = value },
    setSession: (value: boolean) => { sessionExists = value }, editTemplate: () => { templates.templates[0].steps[1].instruction = 'Changed later' } }
}

describe('saved workflow transitions', () => {
  it('withdraws cached success when the outcome disappears or becomes pending before the turn finishes', async () => {
    const h = harness(), node = currentWorkflowAttempt(await h.start())!.nodeId
    h.event(node, 'working'); await h.flush()
    h.report(node); await h.flush()
    expect(currentWorkflowAttempt(await h.run())?.outcome).toBe('succeeded')
    h.outcomes.delete(node); h.service.refresh(); await h.flush()
    expect(currentWorkflowAttempt(await h.run())?.outcome).toBeUndefined()
    h.report(node); await h.flush()
    h.outcomes.set(node, { ...h.outcomes.get(node)!, workPending: true })
    h.service.refresh(); await h.flush()
    h.event(node, 'done'); await h.flush()
    expect((await h.run()).stepIndex).toBe(0)
    h.report(node); await h.flush()
    expect((await h.run()).stepIndex).toBe(1)
  })
  it('halts a startup error even before a working hook arrives and avoids writes on repeated tool activity', async () => {
    const h = harness(), run = await h.start(), node = currentWorkflowAttempt(run)!.nodeId
    h.event(node, 'done', { errored: true }); await h.flush()
    expect((await h.run()).state).toBe('failed')
    const active = harness(), other = currentWorkflowAttempt(await active.start())!.nodeId
    active.event(other, 'working'); await active.flush()
    const count = vi.mocked(active.deps.persistence.save).mock.calls.length
    active.event(other, 'working', { newTurn: false }); await active.flush()
    expect(vi.mocked(active.deps.persistence.save).mock.calls).toHaveLength(count)
  })
  it('claims before side effects, snapshots templates, deduplicates starts, and completes in one worktree', async () => {
    const h = harness()
    h.deps.launch = vi.fn(async (_run, attempt) => {
      expect(currentWorkflowAttempt(h.durable()[0])?.id).toBe(attempt.id)
      expect(currentWorkflowAttempt(h.durable()[0])?.state).toBe('starting')
    })
    let run = await h.start()
    h.editTemplate()
    const duplicate = await h.service.start('p', 'fix', { ...ref, owner: 'ORG' })
    expect(duplicate.ok && duplicate.value.id).toBe(run.id)
    expect(h.deps.prepare).toHaveBeenCalledTimes(1)
    const first = currentWorkflowAttempt(run)!.nodeId
    h.event(first, 'working'); await h.flush()
    h.report(first); await h.flush()
    expect(h.deps.launch).toHaveBeenCalledTimes(1)
    h.event(first, 'done'); await h.flush()
    run = await h.run()
    expect(run.stepIndex).toBe(1)
    expect(run.template.steps[1].instruction).toBe('Fix it.')
    const second = currentWorkflowAttempt(run)!.nodeId
    expect(second).not.toBe(first)
    h.event(second, 'working'); await h.flush()
    h.event(second, 'done'); await h.flush()
    expect((await h.run()).state).toBe('running')
    h.report(second); await h.flush()
    expect((await h.run()).state).toBe('completed')
    expect(h.deps.launch).toHaveBeenCalledTimes(2)
  })

  it('rejects unverified, stale, inferred idle and unfinished background work as success', async () => {
    const h = harness()
    const node = currentWorkflowAttempt(await h.start())!.nodeId
    h.event(node, 'working', { verified: false }); h.report(node); h.event(node, 'done'); await h.flush()
    expect((await h.run()).stepIndex).toBe(0)
    h.event(node, 'working'); await h.flush()
    h.event(node, 'done', { idle: true }); await h.flush()
    expect(currentWorkflowAttempt(await h.run())?.turnDoneAt).toBeUndefined()
    h.setHeld(true); h.report(node); h.event(node, 'done'); await h.flush()
    expect((await h.run()).stepIndex).toBe(0)
    h.setHeld(false); h.setSettled(false); h.service.refresh(); await h.flush()
    expect((await h.run()).stepIndex).toBe(0)
    h.setSettled(true); h.service.refresh(); await h.flush()
    expect((await h.run()).stepIndex).toBe(1)
  })

  it('holds a manual gate through pause/resume and requires explicit approval', async () => {
    const h = harness([], true)
    const run = await h.start(), node = currentWorkflowAttempt(run)!.nodeId
    h.event(node, 'working'); await h.flush(); h.event(node, 'done'); await h.flush()
    expect((await h.run()).state).toBe('waiting-approval')
    await h.service.act('p', run.id, 'pause'); await h.service.act('p', run.id, 'resume'); await h.flush()
    expect((await h.run()).state).toBe('waiting-approval')
    h.setHeld(true)
    expect((await h.service.act('p', run.id, 'approve')).ok).toBe(false)
    h.setHeld(false)
    expect((await h.service.act('p', run.id, 'approve')).ok).toBe(true); await h.flush()
    expect((await h.run()).stepIndex).toBe(1)
  })

  it('halts errors and retries in a fresh node, ignoring delayed reports from the old attempt', async () => {
    const h = harness()
    let run = await h.start(), old = currentWorkflowAttempt(run)!.nodeId
    h.event(old, 'working'); await h.flush(); h.event(old, 'done', { errored: true }); await h.flush()
    expect((await h.run()).state).toBe('failed')
    h.deps.canRetry = async () => false
    expect((await h.service.act('p', run.id, 'retry')).ok).toBe(false)
    h.deps.canRetry = async () => true
    expect((await h.service.act('p', run.id, 'retry')).ok).toBe(true); await h.flush()
    run = await h.run(); const fresh = currentWorkflowAttempt(run)!.nodeId
    expect(fresh).not.toBe(old)
    expect(run.attempts).toHaveLength(2)
    h.report(old); h.event(old, 'done'); await h.flush()
    expect((await h.run()).stepIndex).toBe(0)
    h.event(fresh, 'working'); await h.flush(); h.report(fresh, 'failed'); await h.flush()
    expect((await h.run()).state).toBe('failed')
  })

  it('pauses transitions while keeping active work and cancels without launching another stage', async () => {
    const h = harness(), run = await h.start(), node = currentWorkflowAttempt(run)!.nodeId
    h.event(node, 'working'); await h.flush()
    await h.service.act('p', run.id, 'pause')
    h.report(node); h.event(node, 'done'); await h.flush()
    expect((await h.run()).stepIndex).toBe(0)
    await h.service.act('p', run.id, 'resume'); await h.flush()
    expect((await h.run()).stepIndex).toBe(1)
    await h.service.act('p', run.id, 'cancel'); h.service.refresh(); await h.flush()
    expect((await h.run()).state).toBe('cancelled')
    expect(await h.service.mayLaunch(run.id, currentWorkflowAttempt(await h.run())!.id)).toBe(false)
    expect(h.deps.launch).toHaveBeenCalledTimes(2)
  })

  it('restores paused without replaying input and makes a lost session retryable', async () => {
    const original = harness(); await original.start()
    const h = harness(original.durable())
    await h.flush()
    let run = await h.run()
    expect(run.state).toBe('paused')
    expect(h.deps.launch).not.toHaveBeenCalled()
    h.setSession(false)
    await h.service.act('p', run.id, 'resume'); await h.flush()
    run = await h.run()
    expect(run.state).toBe('failed')
    expect(run.error).toContain('no longer exists')
    await h.service.act('p', run.id, 'retry'); await h.flush()
    expect(h.deps.prepare).not.toHaveBeenCalled()
    expect(h.deps.launch).toHaveBeenCalledTimes(1)
  })

  it('restores an interrupted launch as uncertain, never automatic', async () => {
    const original = harness()
    original.deps.launch = () => new Promise(() => {})
    await original.start()
    const h = harness(original.durable()); await h.flush()
    const run = await h.run()
    expect(currentWorkflowAttempt(run)?.state).toBe('uncertain')
    expect((await h.service.act('p', run.id, 'resume')).ok).toBe(false)
    expect(h.deps.launch).not.toHaveBeenCalled()
  })

  it('does not launch after a failed history write or with invalid history', async () => {
    const h = harness()
    h.deps.persistence.save = vi.fn(async () => { throw new Error('disk full') })
    expect((await h.service.start('p', 'fix', ref)).ok).toBe(false); await h.flush()
    expect(h.deps.prepare).not.toHaveBeenCalled()
    expect(h.deps.launch).not.toHaveBeenCalled()
    const bad = harness(); bad.deps.persistence.load = async () => { throw new Error('invalid history') }
    // Construct after changing the seam, before any restoration can authorize work.
    const service = new WorkflowService(bad.deps)
    expect(await service.start('p', 'fix', ref)).toEqual({ ok: false, error: 'invalid history' })
  })
})
