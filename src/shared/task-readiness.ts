import { isSafeNodeId } from './safe-id'

export interface AcceptanceCriterion { id: string; text: string }
export interface CriterionResult { id: string; status: 'met' | 'unmet' | 'unknown'; note: string }
export interface ReadinessTest { command: string; status: 'passed' | 'failed' | 'skipped' | 'unknown'; summary: string; exitCode?: number }
export interface ReviewFinding { summary: string; severity: 'info' | 'warning' | 'blocking'; file?: string; line?: number }
export interface ReadinessReview { summary: string; outcome: 'passed' | 'issues'; sourceNodeId?: string; findings: ReviewFinding[] }
export interface ReadinessPreview { label: string; url: string }
export interface EvidenceSection<T> { status: 'recorded' | 'not-applicable' | 'missing'; reason?: string; items: T[] }
export interface CodeSnapshot {
  id: string
  at: number
  head: string
  fingerprint: string
  checkout: string
  criteriaRevision: number
  acceptance: AcceptanceCriterion[]
  baseCommit: string
  files: string[]
}
export interface ReadinessReportInput {
  snapshotId: string
  criteria: CriterionResult[]
  tests: EvidenceSection<ReadinessTest>
  review: EvidenceSection<ReadinessReview>
  preview: EvidenceSection<ReadinessPreview>
}
export interface ReadinessReport extends Omit<ReadinessReportInput, 'snapshotId'> {
  id: string
  at: number
  author: string
  source: 'agent' | 'user'
  snapshot: CodeSnapshot
  acceptance: AcceptanceCriterion[]
}
export interface TaskReadiness {
  version: 1
  nodeId: string
  criteriaRevision: number
  criteria: AcceptanceCriterion[]
  baseCommit: string
  checkout: string
  captures: CodeSnapshot[]
  reports: ReadinessReport[]
}
export type ReadinessFreshness = 'current' | 'stale' | 'unknown' | 'none'
export interface ReadinessView {
  criteria: AcceptanceCriterion[]
  criteriaRevision: number
  baseCommit: string
  reports: ReadinessReport[]
  total: number
  freshness: ReadinessFreshness
  reason?: string
  unsupported?: boolean
}
export type ReadinessResult<T> = { ok: true; value: T } | { ok: false; error: string; unsupported?: boolean }
export interface ReadinessApi {
  read(projectId: string, nodeId: string, offset?: number): Promise<ReadinessResult<ReadinessView>>
  criteria(projectId: string, nodeId: string, criteria: AcceptanceCriterion[], expectedRevision: number, baseCommit?: string): Promise<ReadinessResult<void>>
  capture(projectId: string, nodeId: string): Promise<ReadinessResult<CodeSnapshot>>
  report(projectId: string, nodeId: string, report: ReadinessReportInput): Promise<ReadinessResult<void>>
  check(projectId: string, nodeId: string): Promise<ReadinessResult<ReadinessView>>
  onChanged(listener: (projectId: string, nodeId: string) => void): () => void
}

export const READINESS_INPUT_MAX = 256 * 1024
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max = 8000): v is string => typeof v === 'string' && v.length <= max && !/[\u0000\u001b]/.test(v)
const id = (v: unknown): v is string => typeof v === 'string' && isSafeNodeId(v)
const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max

export function parseAcceptance(raw: unknown): AcceptanceCriterion[] {
  if (!list(raw, 100)) throw new Error('At most 100 acceptance criteria are allowed.')
  const seen = new Set<string>()
  return raw.map((v) => {
    if (!object(v) || !id(v.id) || seen.has(v.id) || !text(v.text, 2000) || !v.text.trim()) throw new Error('Invalid or duplicate acceptance criterion.')
    seen.add(v.id)
    return { id: v.id, text: v.text.trim() }
  })
}

function section<T>(raw: unknown, parse: (v: unknown) => T): EvidenceSection<T> {
  if (!object(raw) || !['recorded', 'not-applicable', 'missing'].includes(String(raw.status)) || !list(raw.items, 100)) throw new Error('Invalid evidence section.')
  if (raw.reason !== undefined && !text(raw.reason, 2000)) throw new Error('Invalid section reason.')
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : undefined
  if (raw.status === 'not-applicable' && !reason) throw new Error('Not applicable needs a reason.')
  if (raw.status !== 'recorded' && raw.items.length) throw new Error('Only recorded sections may contain evidence.')
  if (raw.status === 'recorded' && !raw.items.length) throw new Error('Recorded sections need evidence.')
  return { status: raw.status as EvidenceSection<T>['status'], ...(reason ? { reason } : {}), items: raw.items.map(parse) }
}

export function parseReadinessReport(raw: unknown): ReadinessReportInput {
  if (!object(raw) || !id(raw.snapshotId) || !list(raw.criteria, 100)) throw new Error('Invalid readiness report or snapshot id.')
  const seen = new Set<string>()
  const criteria = raw.criteria.map((v): CriterionResult => {
    if (!object(v) || !id(v.id) || seen.has(v.id) || !['met', 'unmet', 'unknown'].includes(String(v.status)) || !text(v.note, 2000)) throw new Error('Invalid criterion result.')
    seen.add(v.id)
    return { id: v.id, status: v.status as CriterionResult['status'], note: v.note }
  })
  const tests = section(raw.tests, (v): ReadinessTest => {
    if (!object(v) || !text(v.command, 2000) || !v.command.trim() || !text(v.summary) || !['passed', 'failed', 'skipped', 'unknown'].includes(String(v.status))) throw new Error('Invalid test evidence.')
    if (v.exitCode !== undefined && (!Number.isSafeInteger(v.exitCode) || (v.status === 'passed' && v.exitCode !== 0))) throw new Error('Invalid test exit code.')
    return { command: v.command, status: v.status as ReadinessTest['status'], summary: v.summary, ...(typeof v.exitCode === 'number' ? { exitCode: v.exitCode } : {}) }
  })
  const review = section(raw.review, (v): ReadinessReview => {
    if (!object(v) || !text(v.summary) || !['passed', 'issues'].includes(String(v.outcome)) || !list(v.findings, 100) || (v.sourceNodeId !== undefined && !id(v.sourceNodeId))) throw new Error('Invalid review evidence.')
    const findings = v.findings.map((f): ReviewFinding => {
      if (!object(f) || !text(f.summary) || !f.summary.trim() || !['info', 'warning', 'blocking'].includes(String(f.severity)) || (f.file !== undefined && !text(f.file, 2000)) || (f.line !== undefined && (!Number.isSafeInteger(f.line) || Number(f.line) < 1))) throw new Error('Invalid review finding.')
      return { summary: f.summary, severity: f.severity as ReviewFinding['severity'], ...(typeof f.file === 'string' ? { file: f.file } : {}), ...(typeof f.line === 'number' ? { line: f.line } : {}) }
    })
    if (v.outcome === 'passed' && findings.some((f) => f.severity === 'blocking')) throw new Error('A passing review cannot contain blocking findings.')
    return { summary: v.summary, outcome: v.outcome as ReadinessReview['outcome'], findings, ...(typeof v.sourceNodeId === 'string' ? { sourceNodeId: v.sourceNodeId } : {}) }
  })
  const preview = section(raw.preview, (v): ReadinessPreview => {
    if (!object(v) || !text(v.label, 300) || !text(v.url, 2000)) throw new Error('Invalid preview.')
    let url: URL
    try { url = new URL(v.url) } catch { throw new Error('Preview needs an HTTP(S) URL.') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Preview needs an HTTP(S) URL without credentials.')
    return { label: v.label, url: url.href }
  })
  return { snapshotId: raw.snapshotId, criteria, tests, review, preview }
}

export function reportCompleteness(report: ReadinessReport): 'complete' | 'incomplete' | 'problems' {
  if (report.criteria.some((c) => c.status === 'unmet') || report.tests.items.some((t) => t.status === 'failed') || report.review.items.some((r) => r.outcome === 'issues' || r.findings.some((f) => f.severity === 'blocking'))) return 'problems'
  if (!report.acceptance.length || report.acceptance.some((c) => !report.criteria.some((r) => r.id === c.id && r.status === 'met')) || [report.tests, report.review, report.preview].some((s) => s.status === 'missing') || report.tests.items.some((t) => t.status !== 'passed')) return 'incomplete'
  return 'complete'
}

export const unavailableReadiness: ReadinessApi = {
  read: async () => ({ ok: false, error: 'Readiness is available for local Git projects in Desktop.', unsupported: true }),
  criteria: async () => ({ ok: false, error: 'Readiness is unavailable here.', unsupported: true }),
  capture: async () => ({ ok: false, error: 'Readiness is unavailable here.', unsupported: true }),
  report: async () => ({ ok: false, error: 'Readiness is unavailable here.', unsupported: true }),
  check: async () => ({ ok: false, error: 'Readiness is unavailable here.', unsupported: true }),
  onChanged: () => () => {}
}
