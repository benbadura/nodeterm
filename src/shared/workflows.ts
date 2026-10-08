import type { AgentId } from './agents/config'
import { normalizeIssueRef, type IssueRef } from './github-issue-ref'
import { isSafeNodeId } from './safe-id'

export type WorkflowTransition = 'success' | 'manual'

export interface WorkflowStep {
  id: string
  title: string
  agentId: AgentId
  model?: string
  instruction: string
  transition: WorkflowTransition
}

export interface WorkflowTemplate {
  id: string
  name: string
  steps: WorkflowStep[]
}

/** Shared definitions are content only. Loading one never authorizes a launch. */
export interface ProjectWorkflows {
  templates: WorkflowTemplate[]
  defaultTemplateId?: string
}

export type WorkflowRunState =
  | 'preparing' | 'running' | 'waiting-approval' | 'paused' | 'failed' | 'completed' | 'cancelled'
export type WorkflowAttemptState = 'starting' | 'running' | 'awaiting-approval' | 'succeeded' | 'failed' | 'uncertain'

export interface WorkflowStageAttempt {
  id: string
  stepId: string
  nodeId: string
  state: WorkflowAttemptState
  startedAt: number
  finishedAt?: number
  turnStartedAt?: number
  turnDoneAt?: number
  outcome?: 'succeeded' | 'failed'
  outcomeAt?: number
  note?: string
  error?: string
}

/** Host-local execution history; never stored in project.json or accepted from a canvas peer. */
export interface WorkflowRun {
  id: string
  projectId: string
  issueRef: IssueRef
  template: WorkflowTemplate
  state: WorkflowRunState
  stepIndex: number
  attempts: WorkflowStageAttempt[]
  createdAt: number
  updatedAt: number
  groupId: string
  worktree?: { repoPath: string; path: string; branch: string; baseRef: string }
  prepared?: true
  error?: string
}

export type WorkflowAction = 'approve' | 'retry' | 'pause' | 'resume' | 'cancel'
export type WorkflowResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface WorkflowsApi {
  saveTemplates(projectId: string, workflows: ProjectWorkflows): Promise<WorkflowResult<ProjectWorkflows>>
  start(projectId: string, templateId: string, issueRef: IssueRef): Promise<WorkflowResult<WorkflowRun>>
  list(projectId: string): Promise<WorkflowRun[]>
  act(projectId: string, runId: string, action: WorkflowAction): Promise<WorkflowResult<WorkflowRun>>
  onChanged(listener: (projectId: string, runs: WorkflowRun[]) => void): () => void
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !v.includes('\0')
const id = (v: unknown): v is string => typeof v === 'string' && v.length <= 100 && isSafeNodeId(v)
const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

export function sanitizeWorkflowTemplate(raw: unknown): WorkflowTemplate | undefined {
  if (!record(raw) || !id(raw.id) || !text(raw.name, 160) || !Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 32) return
  const steps: WorkflowStep[] = []
  const seen = new Set<string>()
  for (const s of raw.steps) {
    if (!record(s) || !id(s.id) || seen.has(s.id) || !text(s.title, 160) || !text(s.agentId, 160) ||
      !text(s.instruction, 32_000) || (s.transition !== 'success' && s.transition !== 'manual') ||
      (s.model !== undefined && !text(s.model, 256))) return
    seen.add(s.id)
    steps.push({ id: s.id, title: s.title.trim(), agentId: s.agentId, instruction: s.instruction,
      transition: s.transition, ...(s.model !== undefined ? { model: s.model } : {}) })
  }
  return { id: raw.id, name: raw.name.trim(), steps }
}

export function sanitizeProjectWorkflows(raw: unknown): ProjectWorkflows | undefined {
  if (!record(raw) || !Array.isArray(raw.templates) || raw.templates.length > 50) return
  const templates: WorkflowTemplate[] = []
  const seen = new Set<string>()
  for (const t of raw.templates) {
    const safe = sanitizeWorkflowTemplate(t)
    if (!safe || seen.has(safe.id)) return
    seen.add(safe.id)
    templates.push(safe)
  }
  return { templates, ...(typeof raw.defaultTemplateId === 'string' && seen.has(raw.defaultTemplateId)
    ? { defaultTemplateId: raw.defaultTemplateId } : {}) }
}

const RUN_STATES = new Set<WorkflowRunState>(['preparing', 'running', 'waiting-approval', 'paused', 'failed', 'completed', 'cancelled'])
const ATTEMPT_STATES = new Set<WorkflowAttemptState>(['starting', 'running', 'awaiting-approval', 'succeeded', 'failed', 'uncertain'])

export function sanitizeWorkflowRun(raw: unknown): WorkflowRun | undefined {
  if (!record(raw) || !id(raw.id) || !id(raw.projectId) || !id(raw.groupId) ||
    !RUN_STATES.has(raw.state as WorkflowRunState) || !timestamp(raw.createdAt) || !timestamp(raw.updatedAt)) return
  const template = sanitizeWorkflowTemplate(raw.template)
  const issueRef = normalizeIssueRef(raw.issueRef)
  if (!template || !issueRef || !Number.isInteger(raw.stepIndex) || (raw.stepIndex as number) < 0 ||
    (raw.stepIndex as number) > template.steps.length || !Array.isArray(raw.attempts) || raw.attempts.length > 1000) return
  const attempts: WorkflowStageAttempt[] = []
  const seen = new Set<string>()
  for (const a of raw.attempts) {
    if (!record(a) || !id(a.id) || seen.has(a.id) || !id(a.nodeId) || !id(a.stepId) ||
      !template.steps.some(s => s.id === a.stepId) || !ATTEMPT_STATES.has(a.state as WorkflowAttemptState) || !timestamp(a.startedAt)) return
    seen.add(a.id)
    const attempt: WorkflowStageAttempt = { id: a.id, stepId: a.stepId, nodeId: a.nodeId, state: a.state as WorkflowAttemptState, startedAt: a.startedAt }
    for (const k of ['finishedAt', 'turnStartedAt', 'turnDoneAt', 'outcomeAt'] as const) {
      if (a[k] !== undefined) { if (!timestamp(a[k])) return; attempt[k] = a[k] }
    }
    if (a.outcome !== undefined) {
      if (a.outcome !== 'succeeded' && a.outcome !== 'failed') return
      attempt.outcome = a.outcome
    }
    for (const k of ['note', 'error'] as const) {
      if (a[k] !== undefined) { if (!text(a[k], 2000)) return; attempt[k] = a[k] }
    }
    attempts.push(attempt)
  }
  let worktree: WorkflowRun['worktree']
  if (raw.worktree !== undefined) {
    if (!record(raw.worktree)) return
    const w = raw.worktree
    if (!text(w.repoPath, 4096) || !text(w.path, 4096) || !text(w.branch, 256) || !text(w.baseRef, 256)) return
    worktree = { repoPath: w.repoPath, path: w.path, branch: w.branch, baseRef: w.baseRef }
  }
  return { id: raw.id, projectId: raw.projectId, groupId: raw.groupId, issueRef, template,
    state: raw.state as WorkflowRunState, stepIndex: raw.stepIndex as number, attempts,
    createdAt: raw.createdAt, updatedAt: raw.updatedAt, ...(worktree ? { worktree } : {}),
    ...(raw.prepared === true ? { prepared: true } : {}),
    ...(text(raw.error, 2000) ? { error: raw.error } : {}) }
}

export function workflowFinished(run: Pick<WorkflowRun, 'state'>): boolean {
  return run.state === 'completed' || run.state === 'cancelled'
}

export function currentWorkflowAttempt(run: WorkflowRun): WorkflowStageAttempt | undefined {
  const step = run.template.steps[run.stepIndex]
  return step ? run.attempts.filter(a => a.stepId === step.id).at(-1) : undefined
}

export function builtinWorkflows(agentId: AgentId): ProjectWorkflows {
  const tail: Array<[string, string, string]> = [
    ['implement', 'Implementation', 'Implement the requested change using the findings of the first stage. Keep changes focused and leave them uncommitted.'],
    ['tests', 'Tests', 'Add or update meaningful tests for the change and run the relevant checks. Report failure if those checks fail. Leave changes uncommitted.'],
    ['review', 'Review', 'Review the diff for correctness, regressions, and missing test coverage. Do not edit files. Give a concrete list of findings, or state that there are none. Success means the review was completed, even if it found issues.'],
    ['fixes', 'Corrections', 'Read the review findings and address each one. If there are no findings, make no changes. Leave changes uncommitted.'],
    ['verify', 'Final verification', 'Verify that every review finding was addressed and rerun the relevant tests and checks. Report failure if any finding remains unresolved or a check fails. Summarize the local changes and checks. Leave all changes uncommitted.']
  ]
  const starters: Array<[string, string, string, string]> = [
    ['fix-bug', 'Fix a bug', 'Reproduction', 'Read the issue, reproduce the bug, and identify its cause. Record the reproduction and expected behavior. Do not implement the fix yet. Report failure if you cannot establish a reproduction or an evidence-based diagnosis.'],
    ['add-endpoint', 'Add an endpoint', 'Endpoint contract', 'Read the issue and inspect existing API conventions. Establish the endpoint contract, authentication, validation, response behavior, and acceptance criteria. Record them for the implementation stage.'],
    ['update-dependency', 'Update a dependency', 'Dependency analysis', 'Read the issue and inspect the dependency and its target version. Identify compatibility requirements, migration steps, and checks needed to validate the update. Record a focused update plan.']
  ]
  return { defaultTemplateId: 'fix-bug', templates: starters.map(([templateId, name, firstTitle, firstInstruction]) => ({
    id: templateId, name, steps: [['analysis', firstTitle, firstInstruction], ...tail].map(([stepId, title, instruction]) => ({
      id: stepId, title, instruction, agentId, transition: 'success' as const
    }))
  })) }
}
