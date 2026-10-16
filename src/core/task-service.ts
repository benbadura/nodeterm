import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { TaskStore } from './task-store'
import { measureReadiness, readinessFiles, readinessGit } from './readiness-git'
import { rankBetween } from '../shared/kanban-rank'
import { issueKey, normalizeIssueRef } from '../shared/github-issue-ref'
import { isSafeNodeId } from '../shared/safe-id'
import { parseReadinessReport, READINESS_INPUT_MAX, type CodeSnapshot, type ReadinessFreshness, type ReadinessReportInput } from '../shared/task-readiness'
import { latestTaskResult, latestTaskRun, taskCriteria, taskMeta, taskResultWarnings, taskText, TASK_STAGES,
  type TaskAction, type TaskCreate, type TaskRecord, type TaskReply, type TaskRun, type TaskView } from '../shared/tasks'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'

export interface TaskServiceDeps {
  hostId: string
  root(projectId: string): Promise<string>
  checkCheckout?(projectId: string, task: TaskRecord): Promise<void>
  node(projectId: string, nodeId: string): Promise<{ cwd: string; agentId: string; remote?: boolean } | undefined>
  state(nodeId: string): { state?: string; verified?: boolean; error?: boolean } | undefined
  settled?(nodeId: string): Promise<boolean>
  prepare(projectId: string, task: TaskRecord, workspace: 'worktree' | 'current'): Promise<NonNullable<TaskRecord['checkout']>>
  launch(projectId: string, task: TaskRecord, run: TaskRun, prompt: string, mayDeliver: () => Promise<boolean>): Promise<void>
  validate(agentId: string, accountId?: string): void
  limit(projectId: string): number
  changed(projectId: string): void
}
const fail = <T = never>(error: unknown): TaskReply<T> => ({ ok: false, error: error instanceof Error ? error.message : String(error) })
const event = (task: TaskRecord, text: string, author = 'You'): void => { task.events.push({ id: randomUUID(), at: Date.now(), author, text }) }
const active = (r?: TaskRun): boolean => !!r && ['starting', 'working', 'waiting'].includes(r.state)
const id = (v: unknown): v is string => typeof v === 'string' && isSafeNodeId(v)

/** Host-owned orchestration. Reading shared files never authorizes a new launch. */
export class TaskService {
  readonly store = new TaskStore()
  private queue = new Map<string, { projectId: string; taskId: string; runId: string; workspace: 'worktree' | 'current' }>()
  private draining = new Set<string>()
  private bindings = new Map<string, { projectId: string; taskId: string; runId: string }>()
  private stopped = false
  private epoch = new Set<string>()
  private recovered = new Set<string>()
  private jobs = new Set<Promise<unknown>>()
  constructor(readonly deps: TaskServiceDeps) {}
  private async busy(run?: TaskRun): Promise<boolean> {
    if (!run || run.state === 'queued') return false
    const state = this.deps.state(run.nodeId)
    if (['working', 'waiting', 'blocked'].includes(state?.state ?? '')) return true
    if (active(run)) return true
    if (run.settledAt) return false
    return this.deps.settled ? !await this.deps.settled(run.nodeId) : false
  }
  async rememberCheckout(projectId: string, taskId: string, checkout: NonNullable<TaskRecord['checkout']>): Promise<void> {
    await this.change(projectId, taskId, t => { t.checkout = checkout })
  }
  private async readTask(projectId: string, taskId: string): Promise<TaskRecord> { return this.store.read(await this.deps.root(projectId), taskId) }
  private async save(projectId: string, task: TaskRecord): Promise<void> {
    task.revision++; task.updatedAt = Date.now()
    await this.store.write(await this.deps.root(projectId), task)
    this.deps.changed(projectId)
  }
  private async change(projectId: string, taskId: string, operation: (task: TaskRecord) => Promise<void | false> | void | false): Promise<TaskRecord> {
    const root = await this.deps.root(projectId)
    return this.store.lock(root, async () => { const task = await this.store.read(root, taskId); if (await operation(task) !== false) await this.save(projectId, task); return task })
  }
  private async freshness(task: TaskRecord, projectId: string): Promise<{ freshness: ReadinessFreshness; reason?: string }> {
    const result = latestTaskResult(task)
    if (!result?.report) return { freshness: 'none' }
    if (task.checkout?.hostId !== this.deps.hostId) return { freshness: 'unknown', reason: 'This result belongs to another host or workspace.' }
    try {
      await this.deps.checkCheckout?.(projectId, task)
      const code = await measureReadiness(task.checkout.cwd)
      const snapshot = result.report.snapshot
      const current = code.checkout === snapshot.checkout && code.fingerprint === snapshot.fingerprint && task.criteriaRevision === snapshot.criteriaRevision
      return { freshness: current ? 'current' : 'stale', ...(!current ? { reason: 'Code or acceptance criteria changed since verification.' } : {}) }
    } catch (e) { return { freshness: 'unknown', reason: e instanceof Error ? e.message : 'Code could not be verified.' } }
  }
  async list(projectId: string): Promise<TaskReply<TaskRecord[]>> {
    try {
      const tasks = await this.store.list(await this.deps.root(projectId))
      // Recover links, not launches. A copied project cannot adopt another host's process.
      for (const t of tasks) {
        const r = latestTaskRun(t)
        if (r?.hostId === this.deps.hostId && t.stage !== 'done' && !t.archivedAt) {
          this.bindings.set(r.nodeId, { projectId, taskId: t.id, runId: r.id })
          if (!this.epoch.has(r.id) && !this.recovered.has(r.id)) {
            this.recovered.add(r.id)
            if (r.state !== 'queued' && await this.busy(r)) {
              const updated = await this.change(projectId, t.id, task => {
                const current = latestTaskRun(task)!
                if (current.id !== r.id || current.state === 'queued') return
                const live = this.deps.state(r.nodeId)
                current.state = live?.verified && live.state === 'done' ? task.results.some(result => result.runId === r.id) ? 'reported' : 'idle' : 'unknown'
                event(task, 'Session recovered after restart. No launch was repeated; inspect the session if its state is unknown.', 'nodeterm')
              })
              Object.assign(t, updated)
            }
          }
        }
      }
      return { ok: true, value: tasks }
    } catch (e) { return fail(e) }
  }
  async read(projectId: string, taskId: string): Promise<TaskReply<TaskView>> {
    try { const task = await this.readTask(projectId, taskId); const freshness = await this.freshness(task, projectId); return { ok: true, value: { task, ...freshness, warnings: taskResultWarnings(task, freshness.freshness) } } }
    catch (e) { return fail(e) }
  }
  async diff(projectId: string, taskId: string): Promise<TaskReply<string>> {
    try {
      const t = await this.readTask(projectId, taskId)
      if (!t.checkout || t.checkout.hostId !== this.deps.hostId) throw new Error('The local checkout is unavailable.')
      await this.deps.checkCheckout?.(projectId, t)
      const code = await measureReadiness(t.checkout.cwd)
      const base = t.checkout.baseCommit ?? code.head
      if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error('Invalid comparison base.')
      const diff = (await readinessGit(code.checkout, ['diff', '--no-ext-diff', '--no-textconv', base, '--', '.', ':(exclude).nodeterm', ':(exclude,glob)**/.nodeterm/**'])).toString()
      return { ok: true, value: diff + (code.untracked.length ? `\nUntracked files (listed separately):\n${code.untracked.join('\n')}` : '') }
    } catch (e) { return fail(e) }
  }
  async create(projectId: string, input: TaskCreate): Promise<TaskReply<TaskRecord>> {
    try {
      if (!input || typeof input !== 'object') throw new Error('Invalid task.')
      const title = taskText(input.title, 200, true); const description = taskText(input.description ?? '', 32000)
      const criteria = taskCriteria(input.criteria)
      const ref = input.issueRef ? normalizeIssueRef(input.issueRef) : undefined
      if (input.issueRef && !ref) throw new Error('Invalid issue reference.')
      const root = await this.deps.root(projectId)
      const task = await this.store.lock(root, async () => {
        const all = await this.store.list(root)
        const existing = all.find(t => ref && issueKey(t.issueRef) === issueKey(ref) || input.legacyNodeId && t.legacyNodeIds.includes(input.legacyNodeId))
        if (existing) return existing
        if (input.legacyNodeId) {
          const node = await this.deps.node(projectId, input.legacyNodeId)
          if (!node || node.remote) throw new Error('Select an available local agent session.')
        }
        const stage = input.stage ?? 'todo'
        if (!TASK_STAGES.some(s => s.id === stage)) throw new Error('Unknown task stage.')
        if (stage === 'done') throw new Error('Create a task first, then explicitly accept it after reviewing any gaps.')
        const first = all.filter(t => t.stage === stage).sort((a, b) => a.rank < b.rank ? -1 : 1)[0]
        const now = Date.now()
        const t: TaskRecord = { version: 1, id: randomUUID(), revision: 0, title, description, criteria, criteriaRevision: 0,
          stage, rank: rankBetween(null, first?.rank ?? null), createdAt: now, updatedAt: now,
          planFirst: input.planFirst === true, autoReview: input.autoReview === true,
          issueRef: ref, meta: taskMeta(input.meta), legacyNodeIds: input.legacyNodeId ? [input.legacyNodeId] : [],
          runs: [], results: [], captures: [], acceptances: [], events: [] }
        event(t, input.legacyNodeId ? 'Created from an existing session; its original history remains available.' : 'Task created.')
        await this.save(projectId, t); return t
      })
      return { ok: true, value: task }
    } catch (e) { return fail(e) }
  }
  async act(projectId: string, taskId: string, expectedRevision: number, action: TaskAction): Promise<TaskReply<TaskRecord>> {
    try {
      if (!action || typeof action !== 'object') throw new Error('Invalid task action.')
      const root = await this.deps.root(projectId)
      const task = await this.store.lock(root, async () => {
        const t = await this.store.read(root, taskId)
        const requestId = 'requestId' in action ? action.requestId : undefined
        if (requestId && t.runs.some(r => r.id === requestId)) return t
        if (!Number.isSafeInteger(expectedRevision) || t.revision !== expectedRevision) throw Object.assign(new Error('This task changed. Reload before applying your action.'), { conflict: t })
        const last = latestTaskRun(t)
        if (action.type === 'edit') {
          if (t.stage === 'done') throw new Error('Reopen the task before changing its scope.')
          const criteria = taskCriteria(action.criteria)
          const title = taskText(action.title, 200, true); const description = taskText(action.description, 32000)
          if (JSON.stringify(criteria) !== JSON.stringify(t.criteria) || description !== t.description || title !== t.title) { t.criteriaRevision++; t.captures = [] }
          Object.assign(t, { title, description, criteria, planFirst: action.planFirst === true, autoReview: action.autoReview === true })
          if ('meta' in action) t.meta = taskMeta(action.meta)
          event(t, 'Task brief updated.')
        } else if (action.type === 'start' || action.type === 'approve-plan') {
          if (t.archivedAt || t.stage === 'done') throw new Error('Restore or reopen this task first.')
          if (await this.busy(last)) throw new Error('The current session is active or its state is unknown. Inspect it before starting another run.')
          if (last?.state === 'queued') throw new Error('This task is already queued.')
          if (!id(action.requestId)) throw new Error('A launch request id is required.')
          if (action.type === 'start' && !['worktree', 'current'].includes(action.workspace)) throw new Error('Choose a task workspace.')
          if (action.type === 'approve-plan' && (!last?.plan || last.planApprovedAt || last.scopeRevision !== t.criteriaRevision)) throw new Error('There is no current pending plan. Request a revised plan if the brief changed.')
          const role = action.type === 'start' ? action.role ?? 'implementation' : 'implementation'
          if (!['implementation', 'review'].includes(role)) throw new Error('Unknown task run role.')
          if (role === 'review' && !latestTaskResult(t)) throw new Error('Submit an implementation result before requesting review.')
          const agentId = action.type === 'start' ? taskText(action.agentId, 150, true) : last!.agentId
          const accountId = action.type === 'start' ? action.accountId : last!.accountId
          this.deps.validate(agentId, accountId)
          if (accountId !== undefined) taskText(accountId, 150, true)
          const instructions = action.type === 'start' ? taskText(action.instructions ?? '', 32000) : `Implement the approved plan:\n${last!.plan}`
          const implementation = latestTaskRun(t, 'implementation')
          const approval = action.type === 'approve-plan' ? Date.now() : implementation?.scopeRevision === t.criteriaRevision ? implementation.planApprovedAt : undefined
          const run: TaskRun = { id: action.requestId, nodeId: `task-${randomUUID()}`, hostId: this.deps.hostId, role, agentId, accountId,
            state: 'queued', createdAt: Date.now(), updatedAt: Date.now(), instructions, scopeRevision: t.criteriaRevision,
            workspace: action.type === 'start' ? action.workspace : last?.workspace ?? 'worktree', planApprovedAt: approval }
          if (action.type === 'approve-plan') last!.planApprovedAt = Date.now()
          t.runs.push(run); t.captures = []; t.stage = 'in_progress'
          event(t, role === 'review' ? 'Review queued.' : instructions ? 'A new implementation run was requested.' : 'Implementation queued.')
        } else if (action.type === 'attach') {
          if (t.stage === 'done' || t.archivedAt || await this.busy(last) || last?.state === 'queued') throw new Error('Finish the current run or reopen the task before attaching a session.')
          const node = await this.deps.node(projectId, action.nodeId)
          if (!node || node.remote) throw new Error('Select a local agent session from this project.')
          if (t.checkout && path.resolve(t.checkout.cwd) !== path.resolve(node.cwd)) throw new Error('Attach a session from this task’s checkout.')
          const bound = (await this.store.list(root)).some(other => other.id !== t.id && other.stage !== 'done' && !other.archivedAt && latestTaskRun(other)?.nodeId === action.nodeId)
          if (bound) throw new Error('This session already belongs to another active task.')
          if (!t.legacyNodeIds.includes(action.nodeId)) t.legacyNodeIds.push(action.nodeId)
          // Attaching is association only: it neither sends a prompt nor claims work succeeded.
          t.runs.push({ id: randomUUID(), nodeId: action.nodeId, agentId: node.agentId, hostId: this.deps.hostId, role: 'implementation', scopeRevision: t.criteriaRevision, state: 'unknown', createdAt: Date.now(), updatedAt: Date.now() })
          if (!t.checkout) t.checkout = { cwd: node.cwd, hostId: this.deps.hostId }
          t.stage = 'in_progress'; event(t, 'Existing session attached. No instructions were sent.')
        } else if (action.type === 'accept' || action.type === 'move' && action.stage === 'done') {
          if (await this.busy(last)) throw new Error('Wait for the active session or inspect its unknown state before accepting its work.')
          if (last?.state === 'queued') throw new Error('This task has a queued run.')
          const result = latestTaskResult(t)
          if (action.type === 'accept' && action.resultId !== result?.id) throw new Error('The result changed. Reload before accepting.')
          const freshness = await this.freshness(t, projectId)
          const warnings = taskResultWarnings(t, freshness.freshness)
          if (warnings.length && (action.type !== 'accept' || !action.allowWarnings)) throw new Error('Review the missing or outdated evidence, then use Accept despite gaps.')
          t.acceptances.push({ id: randomUUID(), at: Date.now(), author: 'You', resultId: result?.id, snapshot: result?.report?.snapshot, warnings })
          t.stage = 'done'; event(t, warnings.length ? `Accepted despite gaps: ${warnings.join(' ')}` : 'Result accepted.')
        } else if (action.type === 'move') {
          if (!TASK_STAGES.some(s => s.id === action.stage)) throw new Error('Unknown task stage.')
          if (t.stage === 'done') throw new Error('Reopen the task before moving it.')
          if (action.stage === 'ready_for_acceptance' && !latestTaskResult(t)) throw new Error('Record a result before moving to acceptance.')
          if ((await this.busy(last) || last?.state === 'queued') && action.stage !== 'in_progress') throw new Error('The task has an active or queued run.')
          const others = (await this.store.list(root)).filter(o => o.id !== t.id && o.stage === action.stage && !o.archivedAt).sort((a,b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id.localeCompare(b.id))
          const index = action.beforeId ? others.findIndex(o => o.id === action.beforeId) : 0
          if (index < 0) throw new Error('The destination changed. Reload the board.')
          t.rank = rankBetween(index ? others[index - 1].rank : null, others[index]?.rank ?? null)
          t.stage = action.stage; event(t, `Moved to ${TASK_STAGES.find(s => s.id === t.stage)!.label}.`)
        } else if (action.type === 'reopen') { if (t.stage !== 'done') throw new Error('Only accepted tasks can be reopened.'); t.stage = 'todo'; event(t, 'Task reopened; earlier acceptances remain in history.') }
        else if (action.type === 'cancel-queued') {
          if (last?.state !== 'queued') throw new Error('This task is not queued.')
          this.queue.delete(last.id); last.state = 'failed'; last.error = 'Cancelled before launch.'
          event(t, 'Queued run cancelled.')
        } else if (action.type === 'confirm-settled') {
          if (!last || last.state === 'queued' || ['working', 'waiting', 'blocked'].includes(this.deps.state(last.nodeId)?.state ?? '')) throw new Error('This session is still active.')
          last.state = t.results.some(r => r.runId === last.id) ? 'reported' : 'idle'; last.settledAt = Date.now()
          event(t, 'User inspected the session and confirmed that its turn has ended.')
        } else if (action.type === 'archive') {
          if (await this.busy(last) || last?.state === 'queued') throw new Error('Finish the current run before archiving.')
          t.archivedAt = action.archived ? Date.now() : undefined; event(t, action.archived ? 'Task archived.' : 'Task restored.')
        } else if (action.type === 'comment') event(t, taskText(action.text, 32000, true))
        else throw new Error('Unknown task action.')
        await this.save(projectId, t); return t
      })
      const run = latestTaskRun(task)
      if (run?.hostId === this.deps.hostId && task.stage !== 'done') this.bindings.set(run.nodeId, { projectId, taskId, runId: run.id })
      if ((action.type === 'start' || action.type === 'approve-plan') && run?.state === 'queued' && run.id === action.requestId) {
        this.queue.set(run.id, { projectId, taskId, runId: run.id, workspace: run.workspace ?? 'worktree' })
        void this.drain(projectId)
      }
      if (action.type === 'confirm-settled') void this.drain(projectId)
      return { ok: true, value: task }
    } catch (e) { return { ...fail(e), ...(e && typeof e === 'object' && 'conflict' in e ? { conflict: (e as { conflict: TaskRecord }).conflict } : {}) } }
  }
  private async drain(projectId: string): Promise<void> {
    if (this.stopped || this.draining.has(projectId)) return
    this.draining.add(projectId)
    try {
      for (;;) {
        const tasks = await this.store.list(await this.deps.root(projectId))
        const occupied = (await Promise.all(tasks.map(async t => { const r = latestTaskRun(t); return !t.archivedAt && t.stage !== 'done' && r?.hostId === this.deps.hostId && await this.busy(r) }))).filter(Boolean).length
        if (occupied >= Math.max(1, Math.min(8, this.deps.limit(projectId)))) return
        const entry = [...this.queue.values()].find(e => e.projectId === projectId)
        if (!entry || this.stopped) return
        this.queue.delete(entry.runId)
        let task = tasks.find(t => t.id === entry.taskId)
        if (!task || latestTaskRun(task)?.id !== entry.runId || task.archivedAt || task.stage === 'done') continue
        const run = latestTaskRun(task)!
        try {
          this.deps.validate(run.agentId, run.accountId)
          task = await this.change(projectId, task.id, t => { latestTaskRun(t)!.state = 'starting'; latestTaskRun(t)!.updatedAt = Date.now() })
          this.epoch.add(run.id)
          const checkout = await this.deps.prepare(projectId, task, entry.workspace)
          task = await this.change(projectId, task.id, t => { t.checkout = checkout; t.stage = 'in_progress'; latestTaskRun(t)!.state = 'working' })
          this.bindings.set(run.nodeId, { projectId, taskId: task.id, runId: run.id })
          await this.deps.launch(projectId, task, latestTaskRun(task)!, this.prompt(task, latestTaskRun(task)!), async () => {
            if (this.stopped || !this.epoch.has(run.id)) return false
            const current = await this.readTask(projectId, task!.id)
            return latestTaskRun(current)?.id === run.id && current.stage === 'in_progress' && !current.archivedAt
          })
        } catch (e) {
          await this.change(projectId, task.id, t => { const r = t.runs.find(r => r.id === run.id)!; r.state = 'failed'; r.error = (e instanceof Error ? e.message : String(e)).slice(0, 8000); r.updatedAt = Date.now(); event(t, `Run could not start: ${r.error}`, 'nodeterm') })
        }
      }
    } catch (e) { console.error('[tasks] queue:', e) }
    finally { this.draining.delete(projectId) }
  }
  prompt(task: TaskRecord, run: TaskRun): string {
    const planning = task.planFirst && !run.planApprovedAt && run.role === 'implementation'
    return [
      `You are ${run.role === 'review' ? 'reviewing' : 'working on'} nodeterm task ${task.id}, run ${run.id}: ${task.title}.`,
      task.description, `Acceptance criteria:\n${task.criteria.map(c => `- ${c.id}: ${c.text}`).join('\n') || 'No criteria recorded; make missing expectations explicit in your result.'}`,
      run.instructions ?? '',
      'Use the nodeterm canvas-control CLI supplied in your agent instructions. The task verb addresses only your own current run. Start with: task --action read.',
      planning ? 'First inspect the context and prepare a concrete plan. Do not implement yet. Save {"plan":"..."} as JSON in a temporary directory and submit task --action plan --file <path>. Then end your turn and wait for the user to approve it.' :
        run.role === 'review' ? 'Review the implementation in this checkout. Record concrete findings and evidence. Keep the checkout unchanged; corrections are a separate user decision.' : 'Implement the task and run the relevant checks. Work only in this task checkout.',
      'Before running checks capture code with task --action snapshot. Use its returned id as evidence.snapshotId and assess those exact contents. Then submit task --action report --file <JSON path>. The input is {"summary":"What changed, checks, issues and manual test steps","evidence":{"snapshotId":"...","criteria":[{"id":"c1","status":"met|unmet|unknown","note":"..."}],"tests":{"status":"recorded|missing|not-applicable","items":[{"command":"...","status":"passed|failed|skipped|unknown","summary":"...","exitCode":0}]},"review":{"status":"recorded|missing|not-applicable","items":[{"summary":"...","outcome":"passed|issues","findings":[]}]},"preview":{"status":"recorded|missing|not-applicable","items":[{"label":"...","url":"http://..."}]}}}. Replace c1 with actual criterion ids from the task. Not-applicable sections need a reason and empty items. Missing checks remain missing. For a non-Git task, submit summary without evidence and explain the limitation.',
      'Keep report input in a temporary directory or .nodeterm/task-input so it does not change the measured code. Do not reuse earlier evidence under a new snapshot. task --action block --file <JSON path> accepts {"reason":"..."} when you cannot continue.',
      'The user accepts the result. Task acceptance, commits, merges, pushes, pull requests, issue closure and checkout cleanup are separate user actions. End your turn after submitting your plan or result.'
    ].filter(Boolean).join('\n\n')
  }
  async capture(projectId: string, taskId: string, runId: string): Promise<TaskReply<CodeSnapshot>> {
    try {
      let result!: CodeSnapshot
      await this.change(projectId, taskId, async t => {
        const run = this.currentRun(t, runId)
        await this.deps.checkCheckout?.(projectId, t)
        if (run.scopeRevision !== undefined && run.scopeRevision !== t.criteriaRevision) throw new Error('The brief changed. Start a new run against the current criteria.')
        if (!t.checkout || t.checkout.hostId !== this.deps.hostId) throw new Error('The task checkout is unavailable on this host.')
        const m = await measureReadiness(t.checkout.cwd)
        t.checkout.baseCommit ||= m.head
        result = { id: randomUUID(), at: Date.now(), head: m.head, fingerprint: m.fingerprint, checkout: m.checkout,
          criteriaRevision: t.criteriaRevision, acceptance: t.criteria, baseCommit: t.checkout.baseCommit,
          files: await readinessFiles(m.checkout, t.checkout.baseCommit, m.untracked) }
        if ((await measureReadiness(t.checkout.cwd)).fingerprint !== m.fingerprint) throw new Error('Code changed during capture. Try again.')
        t.captures = [...t.captures.slice(-31), { runId, snapshot: result }]
      })
      return { ok: true, value: result }
    } catch (e) { return fail(e) }
  }
  private currentRun(task: TaskRecord, runId: string): TaskRun {
    const run = latestTaskRun(task)
    if (!run || run.id !== runId || run.hostId !== this.deps.hostId || task.stage === 'done' || task.archivedAt || ['queued','failed'].includes(run.state)) throw new Error('This is not the current task run.')
    return run
  }
  async report(projectId: string, taskId: string, runId: string, summary: string, evidence?: ReadinessReportInput, author = 'You'): Promise<TaskReply<TaskRecord>> {
    try {
      const task = await this.change(projectId, taskId, t => {
        const run = this.currentRun(t, runId)
        if (run.scopeRevision !== undefined && run.scopeRevision !== t.criteriaRevision) throw new Error('The brief changed. Start a new run against the current criteria.')
        if (t.planFirst && run.role === 'implementation' && !run.planApprovedAt) throw new Error('Submit a plan and wait for user approval before reporting implementation.')
        summary = taskText(summary, 32000, true)
        let report: TaskRecord['results'][number]['report']
        if (evidence !== undefined) {
          if (Buffer.byteLength(JSON.stringify(evidence)) > READINESS_INPUT_MAX) throw new Error('Evidence exceeds 256 KiB.')
          const parsed = parseReadinessReport(evidence)
          const capture = t.captures.find(c => c.runId === runId && c.snapshot.id === parsed.snapshotId)
          if (!capture || capture.snapshot.criteriaRevision !== t.criteriaRevision) throw new Error('Capture the current criteria before checking code. The snapshot is missing, already submitted, or outdated.')
          if (parsed.criteria.some(c => !capture.snapshot.acceptance.some(a => a.id === c.id))) throw new Error('Unknown acceptance criterion.')
          const { snapshotId: _id, ...sections } = parsed
          report = { ...sections, id: randomUUID(), at: Date.now(), author, source: author === 'You' ? 'user' : 'agent', snapshot: capture.snapshot, acceptance: capture.snapshot.acceptance }
          t.captures = t.captures.filter(c => c !== capture)
        }
        t.results.push({ id: randomUUID(), runId, at: Date.now(), author, summary, report, criteriaRevision: t.criteriaRevision })
        run.state = 'reported'; run.updatedAt = Date.now(); t.stage = 'ready_for_acceptance'
        event(t, run.role === 'review' ? 'Review result submitted.' : 'Implementation result submitted.', author)
      })
      return { ok: true, value: task }
    } catch (e) { return fail(e) }
  }
  async resumeQueue(projectId: string): Promise<TaskReply<void>> {
    const all = await this.list(projectId)
    if (!all.ok) return all
    for (const t of all.value) { const run = latestTaskRun(t); if (run?.state === 'queued' && run.hostId === this.deps.hostId && !t.archivedAt && t.stage !== 'done') this.queue.set(run.id, { projectId, taskId: t.id, runId: run.id, workspace: run.workspace ?? 'worktree' }) }
    void this.drain(projectId)
    return { ok: true, value: undefined }
  }
  onAgentEvent(ev: NormalizedAgentEvent): void {
    if (this.stopped || !ev.verified || ev.kind !== 'state' || !ev.state) return
    const binding = this.bindings.get(ev.nodeId)
    if (!binding) return
    const job = this.change(binding.projectId, binding.taskId, t => {
      const r = latestTaskRun(t)
      if (!r || r.id !== binding.runId || t.stage === 'done' || t.archivedAt) return false
      const state = this.deps.state(r.nodeId)?.state ?? ev.state
      if (ev.idle && r.state === 'waiting') return false
      const next = ev.errored ? 'failed' : state === 'working' ? 'working' : state === 'done' ? t.results.some(result => result.runId === r.id) ? 'reported' : 'idle' : 'waiting'
      if (r.state === next && !ev.errored && !ev.newTurn) return false
      r.settledAt = undefined
      r.state = next
      if (ev.newTurn) r.error = undefined
      if (ev.errored) { r.error = 'The agent turn ended with an error. Inspect the session.'; event(t, r.error, 'nodeterm') }
      r.updatedAt = Date.now()
    }).then(async t => {
      const r = latestTaskRun(t)!
      if (r.id !== binding.runId) return
      if (!ev.errored && !ev.idle && ev.state === 'done' && t.autoReview && r.role === 'implementation' && t.results.some(result => result.runId === r.id) && !r.plan) await this.act(binding.projectId, t.id, t.revision, { type: 'start', requestId: `review-${r.id}`, agentId: r.agentId, accountId: r.accountId, role: 'review', workspace: 'current' })
      void this.drain(binding.projectId)
    }).catch(e => console.error('[tasks] agent update:', e))
    this.jobs.add(job)
    void job.finally(() => this.jobs.delete(job))
  }
  async control(projectId: string, nodeId: string, args: Record<string, string | undefined>, verified: boolean): Promise<{ ok: boolean; message: string; error?: string }> {
    try {
      if (!verified || args.node && args.node !== nodeId || args.project) throw new Error('Task commands address only the verified caller’s own run.')
      const tasks = await this.list(projectId)
      if (!tasks.ok) throw new Error(tasks.error)
      const task = tasks.value.find(t => latestTaskRun(t)?.nodeId === nodeId && latestTaskRun(t)?.hostId === this.deps.hostId && t.stage !== 'done' && !t.archivedAt)
      if (!task) throw new Error('This session is not assigned to an active task.')
      const run = latestTaskRun(task)!
      const action = args.action ?? 'read'
      let result: TaskReply<unknown>
      if (action === 'read') result = await this.read(projectId, task.id)
      else if (action === 'snapshot') result = await this.capture(projectId, task.id, run.id)
      else {
        if (!args.file || !task.checkout) throw new Error('Use --file <JSON path>.')
        const file = path.resolve(task.checkout.cwd, args.file)
        if ((await fs.stat(file)).size > READINESS_INPUT_MAX) throw new Error('Task input exceeds 256 KiB.')
        const raw = JSON.parse(await fs.readFile(file, 'utf8'))
        if (action === 'report') result = await this.report(projectId, task.id, run.id, raw.summary, raw.evidence, run.agentId)
        else if (action === 'plan' || action === 'block') {
          const value = taskText(action === 'plan' ? raw.plan : raw.reason, 32000, true)
          result = { ok: true, value: await this.change(projectId, task.id, t => {
            const current = this.currentRun(t, run.id)
            if (action === 'plan') { if (!t.planFirst || current.role !== 'implementation' || current.planApprovedAt || current.scopeRevision !== t.criteriaRevision) throw new Error('This run does not require plan approval.'); current.plan = value; current.state = 'idle' }
            else { current.error = value; current.state = 'failed' }
            current.updatedAt = Date.now(); event(t, action === 'plan' ? 'Plan submitted for approval.' : `Agent reported a blocker: ${value}`, run.agentId)
          }) }
        } else throw new Error('Task action must be read, snapshot, plan, block or report.')
      }
      return result.ok ? { ok: true, message: JSON.stringify(result.value ?? { saved: true }) } : { ok: false, message: result.error, error: result.error }
    } catch (e) { const error = e instanceof Error ? e.message : String(e); return { ok: false, message: error, error } }
  }
  stop(): void { this.stopped = true; this.queue.clear(); this.epoch.clear() }
  async idle(): Promise<void> {
    while (this.jobs.size || this.draining.size) {
      await Promise.all([...this.jobs])
      if (this.draining.size) await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
}
