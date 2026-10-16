import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './fs-atomic'
import { isSafeNodeId } from '../shared/safe-id'
import { isValidRank } from '../shared/kanban-rank'
import { normalizeIssueRef } from '../shared/github-issue-ref'
import { TASK_STAGES, taskCriteria, taskMeta, taskText, type TaskRecord } from '../shared/tasks'
import { parseReadinessReport } from '../shared/task-readiness'

const MAX = 64 * 1024 * 1024
const queues = new Map<string, Promise<unknown>>()
const validId = (id: unknown): id is string => typeof id === 'string' && isSafeNodeId(id)
const timestamp = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0

/** Refuse corrupt history rather than silently dropping reports or manufacturing empty tasks. */
export function decodeTask(raw: string, expectedId: string): TaskRecord {
  if (Buffer.byteLength(raw) > MAX) throw new Error('Task history exceeds 64 MiB.')
  const t = JSON.parse(raw) as TaskRecord
  if (!t || t.version !== 1 || t.id !== expectedId || !validId(t.id) || !Number.isSafeInteger(t.revision) || t.revision < 0 ||
    !Number.isSafeInteger(t.criteriaRevision) || t.criteriaRevision < 0 || !TASK_STAGES.some(s => s.id === t.stage) || !isValidRank(t.rank) ||
    !timestamp(t.createdAt) || !timestamp(t.updatedAt) || typeof t.planFirst !== 'boolean' || typeof t.autoReview !== 'boolean' ||
    ![t.runs, t.results, t.acceptances, t.events, t.captures, t.legacyNodeIds].every(Array.isArray)) throw new Error('Invalid task history; its file was left untouched.')
  taskText(t.title, 200, true); taskText(t.description, 32000); taskCriteria(t.criteria)
  t.meta = taskMeta(t.meta)
  if (t.archivedAt !== undefined && !timestamp(t.archivedAt)) throw new Error('Invalid archive timestamp.')
  if (t.issueRef && !normalizeIssueRef(t.issueRef)) throw new Error('Invalid task issue reference.')
  if (t.legacyNodeIds.some(id => !validId(id))) throw new Error('Invalid linked session.')
  if (new Set(t.runs.map(r => r.id)).size !== t.runs.length) throw new Error('Duplicate task runs.')
  if (new Set(t.results.map(r => r.id)).size !== t.results.length) throw new Error('Duplicate task results.')
  if (t.stage === 'done' && !t.acceptances.length) throw new Error('A completed task needs an acceptance decision.')
  for (const r of t.runs) {
    if (!validId(r.id) || !validId(r.nodeId) || !validId(r.hostId) || !['implementation', 'review'].includes(r.role) ||
      !['queued', 'starting', 'working', 'waiting', 'idle', 'failed', 'reported', 'unknown'].includes(r.state) || !timestamp(r.createdAt) || !timestamp(r.updatedAt)) throw new Error('Invalid task run.')
    taskText(r.agentId, 150, true)
    if (r.plan !== undefined) taskText(r.plan, 32000)
    if (r.instructions !== undefined) taskText(r.instructions, 32000)
    if (r.accountId !== undefined) taskText(r.accountId, 150, true)
    if (r.error !== undefined) taskText(r.error, 32000)
    if (r.workspace !== undefined && !['worktree', 'current'].includes(r.workspace)) throw new Error('Invalid run workspace.')
    if (r.scopeRevision !== undefined && (!Number.isSafeInteger(r.scopeRevision) || r.scopeRevision < 0)) throw new Error('Invalid run scope.')
  }
  const snapshot = (s: TaskRecord['captures'][number]['snapshot']): void => {
    if (!s || !validId(s.id) || !timestamp(s.at) || !/^[a-f0-9]{40,64}$/.test(s.head) || !/^[a-f0-9]{64}$/.test(s.fingerprint) ||
      !/^[a-f0-9]{40,64}$/.test(s.baseCommit) || !Number.isSafeInteger(s.criteriaRevision) || !Array.isArray(s.files) || s.files.some(f => typeof f !== 'string')) throw new Error('Invalid task code snapshot.')
    taskText(s.checkout, 32000, true); taskCriteria(s.acceptance)
  }
  for (const c of t.captures) { if (!t.runs.some(r => r.id === c.runId)) throw new Error('Unknown snapshot run.'); snapshot(c.snapshot) }
  for (const r of t.results) {
    if (!validId(r.id) || !t.runs.some(run => run.id === r.runId) || !timestamp(r.at) || !Number.isSafeInteger(r.criteriaRevision) || r.criteriaRevision < 0) throw new Error('Invalid task result.')
    taskText(r.summary, 32000, true); taskText(r.author, 150, true)
    if (r.report) { snapshot(r.report.snapshot); parseReadinessReport({ ...r.report, snapshotId: r.report.snapshot.id }); taskCriteria(r.report.acceptance) }
  }
  for (const a of t.acceptances) {
    if (!validId(a.id) || !timestamp(a.at) || !Array.isArray(a.warnings) || a.warnings.some(w => typeof w !== 'string')) throw new Error('Invalid task acceptance.')
    taskText(a.author, 150, true)
    if (a.resultId && !t.results.some(r => r.id === a.resultId)) throw new Error('Unknown accepted result.')
    if (a.snapshot) snapshot(a.snapshot)
  }
  for (const e of t.events) { if (!validId(e.id) || !timestamp(e.at)) throw new Error('Invalid task activity.'); taskText(e.text, 32000); taskText(e.author, 150, true) }
  if (t.checkout) {
    taskText(t.checkout.cwd, 32000, true); if (!validId(t.checkout.hostId)) throw new Error('Invalid checkout owner.')
    if (t.checkout.baseCommit !== undefined && !/^[a-f0-9]{40,64}$/.test(t.checkout.baseCommit)) throw new Error('Invalid checkout base commit.')
    if (t.checkout.branch !== undefined) { taskText(t.checkout.branch, 300, true); taskText(t.checkout.repoPath, 32000, true) }
  }
  return t
}

/** Each project owns these sidecars, even when its agents work in another checkout. */
export class TaskStore {
  async directory(root: string, create = false): Promise<string> {
    root = await fs.realpath(root)
    const state = path.join(root, '.nodeterm'); const dir = path.join(state, 'tasks')
    for (const p of [state, dir]) {
      try { if ((await fs.lstat(p)).isSymbolicLink()) throw new Error('Task storage must be inside its owning project, without symlinks.') }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (create) await fs.mkdir(p, { recursive: true })
    }
    return dir
  }
  private async file(root: string, id: string): Promise<string> {
    if (!validId(id)) throw new Error('Invalid task id.')
    const file = path.join(await this.directory(root), `${id}.json`)
    try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Task files must not be symlinks.') }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    return file
  }
  async read(root: string, id: string): Promise<TaskRecord> {
    const file = await this.file(root, id)
    if ((await fs.stat(file)).size > MAX) throw new Error('Task history exceeds 64 MiB.')
    return decodeTask(await fs.readFile(file, 'utf8'), id)
  }
  async list(root: string): Promise<TaskRecord[]> {
    let names: string[]
    try { names = await fs.readdir(await this.directory(root)) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
    if (names.length > 10000) throw new Error('This project has too many task files.')
    const tasks: TaskRecord[] = []
    // Bound open file descriptors; a board may have thousands of archived tasks.
    for (const name of names.filter(n => n.endsWith('.json')).sort()) tasks.push(await this.read(root, name.slice(0, -5)))
    return tasks
  }
  async write(root: string, task: TaskRecord): Promise<void> {
    await this.directory(root, true)
    const raw = JSON.stringify(task, null, 2)
    decodeTask(raw, task.id)
    await writeFileAtomic(await this.file(root, task.id), raw, { mode: 0o600 })
  }
  async lock<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const key = await fs.realpath(root)
    const pending = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const dir = await this.directory(root, true)
      const file = path.join(dir, 'write.lock')
      let lock: Awaited<ReturnType<typeof fs.open>>
      try { lock = await fs.open(file, 'wx'); await lock.writeFile(String(process.pid)) }
      catch { throw new Error('Tasks are being written by another process. Retry; after a crash, remove .nodeterm/tasks/write.lock only after the writer has stopped.') }
      try { return await operation() }
      finally { await lock.close(); await fs.unlink(file) }
    })
    queues.set(key, pending)
    try { return await pending } finally { if (queues.get(key) === pending) queues.delete(key) }
  }
}
