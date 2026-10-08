import { randomUUID } from 'node:crypto'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'
import type { StationOutcomeRecord } from '../shared/station-outcome'
import { normalizeIssueRef, type IssueRef } from '../shared/github-issue-ref'
import {
  currentWorkflowAttempt, sanitizeProjectWorkflows, workflowFinished,
  type ProjectWorkflows, type WorkflowAction, type WorkflowResult, type WorkflowRun,
  type WorkflowStageAttempt, type WorkflowTemplate
} from '../shared/workflows'
import type { WorkflowPersistence } from './workflow-store'

export interface WorkflowServiceDeps {
  persistence: WorkflowPersistence
  templates(projectId: string): Promise<ProjectWorkflows | undefined>
  saveTemplates(projectId: string, value: ProjectWorkflows): Promise<void>
  validate(projectId: string, template: WorkflowTemplate, issueRef: IssueRef): Promise<void>
  planWorktree(projectId: string, runId: string, issueRef: IssueRef): Promise<NonNullable<WorkflowRun['worktree']>>
  prepare(run: WorkflowRun): Promise<void>
  checkWorktree(run: WorkflowRun): Promise<void>
  launch(run: WorkflowRun, attempt: WorkflowStageAttempt): Promise<void>
  canRetry(run: WorkflowRun, attempt: WorkflowStageAttempt): Promise<boolean>
  outcome(nodeId: string): StationOutcomeRecord | undefined
  held(nodeId: string): boolean
  settled(nodeId: string): boolean
  sessionExists?(nodeId: string): Promise<boolean>
  publish(projectId: string, runs: WorkflowRun[]): void
  now?: () => number
}

const fail = <T>(error: string): WorkflowResult<T> => ({ ok: false, error })
const errorMessage = (e: unknown): string => (e instanceof Error && e.message.trim() ? e.message : 'The workflow could not continue.').slice(0, 2000)

/** One host owns transitions, independent of every mounted canvas/board. No restored run is
 * authorized: boot reads history, marks unfinished runs paused, and never sends terminal input. */
export class WorkflowService {
  private runs: WorkflowRun[] = []
  private serial: Promise<unknown>
  private stopped = false
  private initializationError?: string
  private readonly preparing = new Set<string>()
  private readonly launching = new Set<string>()
  private readonly authorized = new Set<string>()
  private readonly now: () => number

  constructor(private readonly deps: WorkflowServiceDeps) {
    this.now = deps.now ?? Date.now
    this.serial = this.restore()
  }

  private async restore(): Promise<void> {
    try {
      this.runs = await this.deps.persistence.load()
      for (const run of this.runs) {
        if (workflowFinished(run)) continue
        run.state = 'paused'
        if (currentWorkflowAttempt(run)?.state === 'starting') {
          currentWorkflowAttempt(run)!.state = 'uncertain'
          run.error = 'The host restarted during launch. Inspect the session before retrying this stage.'
        }
      }
    } catch (e) { this.initializationError = errorMessage(e) }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(fn)
    this.serial = result.catch(() => {})
    return result
  }

  private async checkpoint(run: WorkflowRun): Promise<void> {
    run.updatedAt = this.now()
    try { await this.deps.persistence.save(this.runs) }
    catch (e) {
      // A write-ahead barrier that did not land can never authorize the next side effect.
      this.authorized.delete(run.id)
      run.state = 'paused'
      run.error = `Workflow history could not be saved: ${errorMessage(e)}`.slice(0, 2000)
      this.deps.publish(run.projectId, this.snapshot(run.projectId))
      throw e
    }
    this.deps.publish(run.projectId, this.snapshot(run.projectId))
  }

  private snapshot(projectId: string): WorkflowRun[] {
    return structuredClone(this.runs.filter(r => r.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt))
  }

  list(projectId: string): Promise<WorkflowRun[]> {
    return this.exclusive(async () => this.snapshot(projectId))
  }

  saveTemplates(projectId: string, raw: unknown): Promise<WorkflowResult<ProjectWorkflows>> {
    return this.exclusive(async () => {
      const value = sanitizeProjectWorkflows(raw)
      if (!value) return fail('The workflow templates are invalid. Each template needs at least one complete stage.')
      try { await this.deps.saveTemplates(projectId, value); return { ok: true, value } }
      catch (e) { return fail(errorMessage(e)) }
    })
  }

  start(projectId: string, templateId: string, rawRef: unknown): Promise<WorkflowResult<WorkflowRun>> {
    return this.exclusive(async () => {
      if (this.stopped || this.initializationError) return fail(this.initializationError ?? 'The workflow host is stopping.')
      const issueRef = normalizeIssueRef(rawRef)
      if (!issueRef) return fail('The issue reference is invalid.')
      const duplicate = this.runs.find(r => r.projectId === projectId && !workflowFinished(r) &&
        r.issueRef.number === issueRef.number && r.issueRef.owner.toLowerCase() === issueRef.owner.toLowerCase() &&
        r.issueRef.repo.toLowerCase() === issueRef.repo.toLowerCase())
      if (duplicate) return { ok: true, value: structuredClone(duplicate) }
      try {
        const template = (await this.deps.templates(projectId))?.templates.find(t => t.id === templateId)
        if (!template) return fail('Save this workflow template before running it.')
        await this.deps.validate(projectId, template, issueRef)
        if (this.runs.filter(r => !workflowFinished(r)).length >= 100) return fail('Finish or cancel an existing workflow before starting another.')
        const id = `wf-${randomUUID()}`
        const worktree = await this.deps.planWorktree(projectId, id, issueRef)
        const run: WorkflowRun = { id, projectId, issueRef, template: structuredClone(template), state: 'preparing',
          stepIndex: 0, attempts: [], createdAt: this.now(), updatedAt: this.now(), groupId: `wf-group-${randomUUID()}`, worktree }
        this.runs.push(run)
        await this.checkpoint(run)
        this.authorized.add(id)
        this.kick(id)
        return { ok: true, value: structuredClone(run) }
      } catch (e) { return fail(errorMessage(e)) }
    })
  }

  act(projectId: string, runId: string, action: WorkflowAction): Promise<WorkflowResult<WorkflowRun>> {
    return this.exclusive(async () => {
      const run = this.runs.find(r => r.id === runId && r.projectId === projectId)
      if (!run || this.stopped || this.initializationError) return fail(this.initializationError ?? 'This workflow is unavailable.')
      if (workflowFinished(run)) return fail('This workflow has already ended.')
      const attempt = currentWorkflowAttempt(run)
      try {
        switch (action) {
          case 'pause':
            this.authorized.delete(run.id)
            run.state = 'paused'
            break
          case 'cancel':
            this.authorized.delete(run.id)
            run.state = 'cancelled'
            break
          case 'resume':
            if (run.state !== 'paused') return fail('Pause this workflow before resuming it.')
            await this.deps.validate(run.projectId, run.template, run.issueRef)
            if (run.prepared) await this.deps.checkWorktree(run)
            if (attempt?.state === 'uncertain') return fail('Inspect the session, then retry the uncertain stage once it is idle or has exited.')
            if (attempt?.state === 'running' && this.deps.sessionExists && !await this.deps.sessionExists(attempt.nodeId)) {
              attempt.state = 'failed'
              attempt.error = 'The stage session no longer exists. Retry the stage to continue in the same worktree.'
              run.error = attempt.error
            }
            run.state = attempt?.state === 'failed' ? 'failed' : attempt?.state === 'awaiting-approval' ? 'waiting-approval' : run.prepared ? 'running' : 'preparing'
            this.authorized.add(run.id)
            break
          case 'approve':
            if (run.state !== 'waiting-approval' || attempt?.state !== 'awaiting-approval') return fail('This stage is not waiting for approval.')
            if (this.deps.held(attempt.nodeId) || !this.deps.settled(attempt.nodeId)) return fail('The stage must be idle with no unfinished work.')
            this.finishStage(run, attempt)
            break
          case 'retry':
            if (this.preparing.has(run.id) || this.launching.has(run.id)) return fail('Wait for the current preparation or launch to settle.')
            if (run.state !== 'failed' && !(run.state === 'paused' && attempt?.state === 'uncertain')) return fail('Only a failed or uncertain stage can be retried.')
            if (attempt && !(await this.deps.canRetry(run, attempt))) return fail('The previous agent must be idle or exited before retrying. Open its session to resolve any pending question or permission.')
            await this.deps.validate(run.projectId, run.template, run.issueRef)
            if (run.prepared) await this.deps.checkWorktree(run)
            // The old attempt remains in history. drive creates a distinct node, so its delayed
            // success report cannot complete the new attempt.
            run.state = run.prepared ? 'running' : 'preparing'
            this.authorized.add(run.id)
            break
          default: return fail('Unknown workflow action.')
        }
        await this.checkpoint(run)
        if (action === 'retry') this.kick(run.id, true)
        else this.kick(run.id)
        return { ok: true, value: structuredClone(run) }
      } catch (e) { return fail(errorMessage(e)) }
    })
  }

  private finishStage(run: WorkflowRun, attempt: WorkflowStageAttempt): void {
    attempt.state = 'succeeded'
    attempt.finishedAt = this.now()
    run.stepIndex++
    run.error = undefined
    if (run.stepIndex === run.template.steps.length) {
      run.state = 'completed'
      this.authorized.delete(run.id)
    } else run.state = 'running'
  }

  private kick(runId: string, retry = false): void {
    void this.exclusive(async () => {
      const run = this.runs.find(r => r.id === runId)
      if (!run || this.stopped || !this.authorized.has(runId) || workflowFinished(run) || run.state === 'paused' || run.state === 'failed') return
      if (!run.prepared) {
        if (this.preparing.has(runId)) return
        this.preparing.add(runId)
        const snapshot = structuredClone(run)
        void this.deps.prepare(snapshot).then(() => this.exclusive(async () => {
          this.preparing.delete(runId)
          run.prepared = true
          if (run.state === 'preparing') run.state = 'running'
          await this.checkpoint(run)
          this.kick(runId)
        }), e => this.exclusive(async () => {
          this.preparing.delete(runId)
          if (run.state !== 'cancelled') { run.state = 'failed'; run.error = errorMessage(e) }
          await this.checkpoint(run)
        })).catch(() => {})
        return
      }
      const current = currentWorkflowAttempt(run)
      if (!retry && current) {
        await this.evaluate(run, current)
        return
      }
      if (this.launching.has(runId)) return
      if (run.attempts.length >= 1000) {
        run.state = 'failed'
        run.error = 'This workflow has reached its attempt limit. Cancel it and start a new run.'
        await this.checkpoint(run)
        return
      }
      const step = run.template.steps[run.stepIndex]
      if (!step) return
      const attempt: WorkflowStageAttempt = { id: `wf-attempt-${randomUUID()}`, nodeId: `wf-agent-${randomUUID()}`,
        stepId: step.id, state: 'starting', startedAt: this.now() }
      run.attempts.push(attempt)
      run.error = undefined
      await this.checkpoint(run) // Claim BEFORE a node/session or any input exists.
      this.launching.add(runId)
      void this.deps.launch(structuredClone(run), structuredClone(attempt)).then(() => this.exclusive(async () => {
        this.launching.delete(runId)
        if (attempt.state === 'starting') attempt.state = 'running'
        await this.checkpoint(run)
        this.kick(runId)
      }), e => this.exclusive(async () => {
        this.launching.delete(runId)
        attempt.state = 'uncertain'
        attempt.error = errorMessage(e)
        if (run.state !== 'cancelled' && run.state !== 'paused') { run.state = 'failed'; run.error = attempt.error }
        await this.checkpoint(run)
      })).catch(() => {})
    }).catch(() => {})
  }

  onAgentEvent(event: NormalizedAgentEvent): void {
    if (!event.verified || (event.kind !== 'state' && event.kind !== 'session')) return
    void this.exclusive(async () => {
      for (const run of this.runs) {
        if (workflowFinished(run)) continue
        const attempt = currentWorkflowAttempt(run)
        if (!attempt || attempt.nodeId !== event.nodeId || attempt.state === 'succeeded') continue
        const at = this.now()
        let changed = false
        if (event.state === 'working' || event.state === 'waiting' || event.state === 'blocked') {
          if (event.newTurn || attempt.turnStartedAt === undefined) {
            changed = true
            attempt.turnStartedAt = at
            attempt.turnDoneAt = undefined
            attempt.outcome = undefined
            attempt.outcomeAt = undefined
            if (attempt.state === 'awaiting-approval') attempt.state = 'running'
            if (run.state === 'waiting-approval') run.state = 'running'
          }
        } else if (event.state === 'done' && !event.idle) {
          if (attempt.turnStartedAt !== undefined && attempt.turnDoneAt === undefined) {
            changed = true
            attempt.turnDoneAt = at
          }
          if (event.errored || event.interrupted) {
            changed = true
            attempt.state = 'failed'
            attempt.error = event.errored ? 'The agent turn ended with an error.' : 'The agent turn was interrupted.'
            if (run.state !== 'paused') run.state = 'failed'
            run.error = attempt.error
          }
        }
        if (event.sessionPhase === 'end' && !attempt.turnDoneAt) {
          changed = true
          attempt.state = 'failed'
          attempt.error = 'The agent exited before completing this stage.'
          if (run.state !== 'paused') run.state = 'failed'
          run.error = attempt.error
        }
        if (changed) await this.checkpoint(run)
        await this.evaluate(run, attempt)
      }
    }).catch(() => {})
  }

  /** Reports and background-work holds can change AFTER the done event. Re-evaluate on either. */
  refresh(): void {
    for (const run of this.runs) if (!workflowFinished(run)) this.kick(run.id)
  }

  private async evaluate(run: WorkflowRun, attempt: WorkflowStageAttempt): Promise<void> {
    if (this.stopped || !this.authorized.has(run.id) || run.state === 'paused' || run.state === 'failed' || workflowFinished(run) ||
      attempt.state === 'starting' || attempt.state === 'failed' || attempt.state === 'uncertain') return
    const outcome = this.deps.outcome(attempt.nodeId)
    const fresh = outcome && attempt.turnStartedAt !== undefined && outcome.at >= attempt.turnStartedAt && !outcome.workPending ? outcome : undefined
    const reportChanged = attempt.outcome !== fresh?.outcome || attempt.outcomeAt !== fresh?.at || attempt.note !== fresh?.note
    // Reports can be withdrawn when more work starts. Never release a stage using a cached
    // success that no longer exists in the authoritative outcome store.
    attempt.outcome = fresh?.outcome
    attempt.outcomeAt = fresh?.at
    attempt.note = fresh?.note
    if (fresh) {
      if (fresh.outcome === 'failed') {
        attempt.state = 'failed'
        attempt.error = fresh.note || 'The agent reported that the stage failed.'
        run.state = 'failed'
        run.error = attempt.error
        await this.checkpoint(run)
        return
      }
    }
    if (attempt.turnDoneAt === undefined || this.deps.held(attempt.nodeId) || !this.deps.settled(attempt.nodeId)) {
      if (reportChanged) await this.checkpoint(run)
      return
    }
    const step = run.template.steps[run.stepIndex]
    if (step.transition === 'manual') {
      if (attempt.state !== 'awaiting-approval' || reportChanged) {
        attempt.state = 'awaiting-approval'
        run.state = 'waiting-approval'
        await this.checkpoint(run)
      }
    } else if (attempt.outcome === 'succeeded') {
      this.finishStage(run, attempt)
      await this.checkpoint(run)
      this.kick(run.id)
    } else if (reportChanged) await this.checkpoint(run)
  }

  stop(): void { this.stopped = true; this.authorized.clear() }
  mayLaunch(runId: string, attemptId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const run = this.runs.find(r => r.id === runId)
      return !!run && !this.stopped && this.authorized.has(runId) && run.state === 'running' && currentWorkflowAttempt(run)?.id === attemptId
    })
  }
  /** A test/teardown barrier; it does not wait for running agents or external preparation. */
  async idle(): Promise<void> { await this.serial }
}
