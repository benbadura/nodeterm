import type { AcceptanceCriterion, CodeSnapshot, ReadinessFreshness, ReadinessReportInput, ReadinessReport } from './task-readiness'
import { parseAcceptance, reportCompleteness } from './task-readiness'
import type { IssueRef } from './github-issue-ref'
import type { KanbanCardMeta } from './types'

export const TASK_STAGES = [
  { id: 'todo', label: 'To do' }, { id: 'in_progress', label: 'In progress' },
  { id: 'ready_for_acceptance', label: 'Ready to accept' }, { id: 'done', label: 'Done' }
] as const
export type TaskStage = typeof TASK_STAGES[number]['id']
export type TaskRunState = 'queued' | 'starting' | 'working' | 'waiting' | 'idle' | 'failed' | 'reported' | 'unknown'
export interface TaskRun {
  id: string; nodeId: string; hostId: string; role: 'implementation' | 'review'; agentId: string; accountId?: string
  state: TaskRunState; createdAt: number; updatedAt: number; error?: string; instructions?: string
  plan?: string; planApprovedAt?: number; workspace?: 'worktree' | 'current'; scopeRevision?: number; settledAt?: number
}
export interface TaskResult {
  id: string; runId: string; at: number; author: string; summary: string
  report?: ReadinessReport; criteriaRevision: number
}
export interface TaskAcceptance {
  id: string; at: number; author: string; resultId?: string; snapshot?: CodeSnapshot; warnings: string[]
}
export interface TaskEvent { id: string; at: number; author: string; text: string }
export interface TaskRecord {
  version: 1; id: string; revision: number; title: string; description: string; criteria: AcceptanceCriterion[]
  criteriaRevision: number; stage: TaskStage; rank: string; createdAt: number; updatedAt: number; archivedAt?: number
  planFirst: boolean; autoReview: boolean; meta?: Omit<KanbanCardMeta, 'nodeId'>; issueRef?: IssueRef
  legacyNodeIds: string[]; runs: TaskRun[]; results: TaskResult[]; acceptances: TaskAcceptance[]; events: TaskEvent[]
  checkout?: { cwd: string; baseCommit?: string; branch?: string; groupId?: string; repoPath?: string; hostId: string }
  captures: Array<{ runId: string; snapshot: CodeSnapshot }>
}
export interface TaskView { task: TaskRecord; freshness: ReadinessFreshness; reason?: string; warnings: string[] }
export interface TaskBoardPreference { enabled: boolean; maxConcurrent: number }
export function taskBoardPreference(settings: { taskBoards?: Record<string, TaskBoardPreference> }, projectId: string): TaskBoardPreference {
  const p = settings.taskBoards?.[projectId]
  return { enabled: p?.enabled === true, maxConcurrent: Number.isInteger(p?.maxConcurrent) ? Math.max(1, Math.min(8, p!.maxConcurrent)) : 1 }
}
export interface TaskCreate {
  title: string; description?: string; criteria?: AcceptanceCriterion[]; planFirst?: boolean; autoReview?: boolean
  issueRef?: IssueRef; legacyNodeId?: string; stage?: TaskStage; meta?: Omit<KanbanCardMeta, 'nodeId'>
}
export type TaskAction =
  | { type: 'edit'; title: string; description: string; criteria: AcceptanceCriterion[]; planFirst: boolean; autoReview: boolean; meta?: TaskRecord['meta'] }
  | { type: 'move'; stage: TaskStage; beforeId?: string }
  | { type: 'start'; requestId: string; agentId: string; accountId?: string; workspace: 'worktree' | 'current'; role?: 'implementation' | 'review'; instructions?: string }
  | { type: 'approve-plan'; requestId: string }
  | { type: 'attach'; nodeId: string }
  | { type: 'cancel-queued' } | { type: 'confirm-settled' }
  | { type: 'accept'; allowWarnings: boolean; resultId?: string }
  | { type: 'reopen' } | { type: 'archive'; archived: boolean }
  | { type: 'comment'; text: string }
export type TaskReply<T> = { ok: true; value: T } | { ok: false; error: string; unsupported?: boolean; conflict?: TaskRecord }
export interface TaskApi {
  list(projectId: string): Promise<TaskReply<TaskRecord[]>>
  read(projectId: string, taskId: string): Promise<TaskReply<TaskView>>
  create(projectId: string, input: TaskCreate): Promise<TaskReply<TaskRecord>>
  act(projectId: string, taskId: string, expectedRevision: number, action: TaskAction): Promise<TaskReply<TaskRecord>>
  capture(projectId: string, taskId: string, runId: string): Promise<TaskReply<CodeSnapshot>>
  report(projectId: string, taskId: string, runId: string, summary: string, evidence?: ReadinessReportInput): Promise<TaskReply<TaskRecord>>
  resumeQueue(projectId: string): Promise<TaskReply<void>>
  diff(projectId: string, taskId: string): Promise<TaskReply<string>>
  onChanged(listener: (projectId: string) => void): () => void
}
export const unavailableTasks: TaskApi = {
  list: async () => ({ ok: false, error: 'Task boards are available for local Desktop projects.', unsupported: true }),
  read: async () => ({ ok: false, error: 'Task boards are unavailable here.', unsupported: true }),
  create: async () => ({ ok: false, error: 'Task boards are unavailable here.', unsupported: true }),
  act: async () => ({ ok: false, error: 'Task boards are unavailable here.', unsupported: true }),
  capture: async () => ({ ok: false, error: 'Task boards are unavailable here.', unsupported: true }),
  report: async () => ({ ok: false, error: 'Task boards are unavailable here.', unsupported: true }),
  resumeQueue: async () => ({ ok: false, error: 'Task boards are unavailable here.', unsupported: true }),
  diff: async () => ({ ok: false, error: 'Task boards are unavailable here.', unsupported: true }),
  onChanged: () => () => {}
}
export function taskText(value: unknown, max = 8000, required = false): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000\u001b]/.test(value) || (required && !value.trim())) throw new Error('Invalid or oversized task text.')
  return value.trim()
}
export function taskCriteria(value: unknown): AcceptanceCriterion[] { return parseAcceptance(value ?? []) }
export function taskMeta(value: unknown): TaskRecord['meta'] {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid task metadata.')
  const v = value as NonNullable<TaskRecord['meta']>
  if (v.priority !== undefined && !['low', 'medium', 'high', 'urgent'].includes(v.priority)) throw new Error('Invalid task priority.')
  if (v.dueAt !== undefined && (!Number.isFinite(v.dueAt) || v.dueAt < 0)) throw new Error('Invalid task due date.')
  if (v.labels !== undefined && (!Array.isArray(v.labels) || v.labels.length > 100)) throw new Error('Invalid task labels.')
  if (v.assignees !== undefined && (!Array.isArray(v.assignees) || v.assignees.length > 50)) throw new Error('Invalid task assignees.')
  return { priority: v.priority, dueAt: v.dueAt, labels: v.labels?.map(l => taskText(l, 150, true)), assignees: v.assignees?.map(a => ({ name: taskText(a.name, 150, true), color: taskText(a.color, 100, true) })) }
}
export function latestTaskRun(task: TaskRecord, role?: TaskRun['role']): TaskRun | undefined {
  return [...task.runs].reverse().find(r => !role || r.role === role)
}
export function latestTaskResult(task: TaskRecord): TaskResult | undefined {
  const implementation = latestTaskRun(task, 'implementation')
  return implementation ? [...task.results].reverse().find(r => r.runId === implementation.id) : undefined
}
export function taskResultWarnings(task: TaskRecord, freshness: ReadinessFreshness): string[] {
  const result = latestTaskResult(task)
  const warnings: string[] = []
  if (!task.criteria.length) warnings.push('No acceptance criteria recorded.')
  const pending = latestTaskRun(task)
  if (pending?.plan && !pending.planApprovedAt) warnings.push('The implementation plan has not been approved.')
  if (!result) warnings.push('No result from the current implementation.')
  if (!result?.report) warnings.push('No verification evidence recorded.')
  else {
    const complete = reportCompleteness(result.report)
    if (complete === 'problems') warnings.push('Checks or review reported problems.')
    if (complete === 'incomplete') warnings.push('Some criteria or verification evidence are missing.')
    if (freshness !== 'current') warnings.push(freshness === 'stale' ? 'Code or acceptance criteria changed after verification.' : 'The code version cannot be verified.')
  }
  const run = latestTaskRun(task)
  if (run?.role === 'review') {
    const review = [...task.results].reverse().find(r => r.runId === run.id)
    if (!review) warnings.push('The requested review has no result.')
    else if (!review.report || review.report.review.status !== 'recorded' || review.report.review.items.some(r => r.outcome === 'issues' || r.findings.some(f => f.severity === 'blocking'))) warnings.push('Review evidence is incomplete or reports problems.')
    else if (review.report.snapshot.fingerprint !== result?.report?.snapshot.fingerprint || review.criteriaRevision !== task.criteriaRevision) warnings.push('The review covers a different code snapshot or scope.')
  }
  return warnings
}
export interface TaskAttention { kind: 'question' | 'failure' | 'plan' | 'result' | 'missing' | 'stale'; label: string; action: string; priority: number; at: number; nodeId?: string }
export function taskAttention(task: TaskRecord, state?: { state?: string; pendingId?: string; lastTurnError?: unknown; dropped?: boolean }, view?: TaskView): TaskAttention | undefined {
  if (task.archivedAt || task.stage === 'done') return undefined
  const run = latestTaskRun(task)
  const at = run?.updatedAt ?? task.updatedAt
  const nodeId = run?.nodeId
  if (state?.state === 'waiting' || state?.state === 'blocked' || run?.state === 'waiting') return { kind: 'question', label: 'An agent needs your answer', action: 'Answer', priority: 0, at, nodeId }
  if (run?.state === 'failed' || run?.state === 'unknown' && run.error || state?.lastTurnError || state?.dropped) return { kind: 'failure', label: run?.error || 'The agent stopped with a problem', action: 'Inspect problem', priority: 1, at, nodeId }
  if (run?.plan && !run.planApprovedAt) return { kind: 'plan', label: 'A plan is ready for approval', action: 'Review plan', priority: 2, at, nodeId }
  if (task.stage === 'ready_for_acceptance') {
    const stale = view?.freshness === 'stale' || latestTaskResult(task)?.criteriaRevision !== undefined && latestTaskResult(task)!.criteriaRevision !== task.criteriaRevision
    return { kind: stale ? 'stale' : 'result', label: stale ? 'Verification needs a refresh' : 'A result is ready to accept', action: 'Review result', priority: 3, at, nodeId }
  }
  if (run && (run.state === 'idle' || run.state === 'unknown') && !task.results.some(r => r.runId === run.id)) return { kind: 'missing', label: 'The session has no result report', action: 'Open session', priority: 4, at, nodeId }
  return undefined
}
