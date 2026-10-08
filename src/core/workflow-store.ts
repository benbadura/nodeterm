import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './fs-atomic'
import { sanitizeWorkflowRun, workflowFinished, type WorkflowRun } from '../shared/workflows'

export interface WorkflowPersistence {
  load(): Promise<WorkflowRun[]>
  save(runs: WorkflowRun[]): Promise<void>
}

/** A private host ledger, separate from the git-shared canvas and template definitions. */
export class WorkflowRunStore implements WorkflowPersistence {
  private readonly file: string
  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'orchestration-state', 'workflow-runs.json')
  }
  async load(): Promise<WorkflowRun[]> {
    let raw: string
    try { raw = await fs.readFile(this.file, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('Workflow history could not be read. Its file was left untouched.')
    }
    try {
      if (Buffer.byteLength(raw) > 64 * 1024 * 1024) throw new Error('oversized')
      const doc = JSON.parse(raw)
      if (doc.version !== 1 || !Array.isArray(doc.runs) || doc.runs.length > 1000) throw new Error('shape')
      const seen = new Set<string>()
      return doc.runs.map((r: unknown) => {
        const run = sanitizeWorkflowRun(r)
        if (!run || seen.has(run.id)) throw new Error('invalid run')
        seen.add(run.id)
        return run
      })
    } catch {
      throw new Error('Workflow history is invalid. Its file was left untouched.')
    }
  }
  async save(runs: WorkflowRun[]): Promise<void> {
    const live = runs.filter(r => !workflowFinished(r))
    const history = runs.filter(workflowFinished).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200)
    if (live.length + history.length > 1000) throw new Error('Workflow history is full.')
    const json = JSON.stringify({ version: 1, runs: [...live, ...history] }, null, 2)
    if (Buffer.byteLength(json) > 64 * 1024 * 1024) throw new Error('Workflow history is full.')
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await writeFileAtomic(this.file, json, { mode: 0o600 })
  }
}
