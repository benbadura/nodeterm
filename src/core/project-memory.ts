import { promises as fs } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileAtomic } from './fs-atomic'
import type { CorePlatform } from './platform'
import { IPC } from '../shared/ipc'
import { checkMemoryRevision, emptyMemoryProject, memoryId, parseCheckpoint, parseDecision, parseMemorySources, renderMemoryPacket, MEMORY_INPUT_MAX, type DecisionInput, type MemoryCheckpointInput, type MemoryDecision, type MemoryPacket, type MemoryProject, type MemoryResult, type MemoryReviewAction, type MemorySelection, type MemorySource, type MemoryTask, type MemoryView } from '../shared/project-memory'

export interface MemoryTarget { root: string; node?: { cwd: string; author: string; title: string } }
export interface MemoryResolver {
  project(projectId: string, nodeId?: string): MemoryTarget | undefined
  projectForNode(nodeId: string): string | undefined
}
const queues = new Map<string, Promise<unknown>>()
const MAX_FILE = 64 * 1024 * 1024
const failure = (e: unknown): MemoryResult<never> => ({ ok: false, error: e instanceof Error ? e.message : String(e) })
const validRevision = (n: unknown): boolean => Number.isSafeInteger(n) && Number(n) >= 0

function decodeDecisions(raw: unknown): MemoryDecision[] {
  if (!Array.isArray(raw)) throw new Error('Invalid saved decisions.')
  const ids = new Set<string>()
  return raw.map((d) => {
    const content = parseDecision(d)
    memoryId(d.id)
    if (ids.has(d.id) || !['proposed', 'approved', 'rejected', 'superseded', 'withdrawn'].includes(d.status) || typeof d.author !== 'string' || !Number.isFinite(d.at) || (d.reviewedAt !== undefined && !Number.isFinite(d.reviewedAt)) || (d.reviewedBy !== undefined && typeof d.reviewedBy !== 'string')) throw new Error('Invalid saved decision metadata.')
    ids.add(d.id)
    return { ...content, id: d.id, status: d.status, author: d.author, at: d.at, ...(d.reviewedAt !== undefined ? { reviewedAt: d.reviewedAt, reviewedBy: d.reviewedBy } : {}) }
  })
}

/** Folder-backed memory, deliberately separate from the canvas save/merge lifecycle. */
export class ProjectMemoryService {
  constructor(private resolver: MemoryResolver, private changed: (projectId: string) => void = () => {}) {}

  private async file(root: string, relative: string, create = false): Promise<string> {
    const real = await fs.realpath(root)
    const segments = ['.nodeterm', 'memory', ...relative.split('/')]
    let current = real
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i])
      try {
        const stat = await fs.lstat(current)
        if (stat.isSymbolicLink() || (i < segments.length - 1 && !stat.isDirectory())) throw new Error('Memory storage must stay inside the project and cannot use symlinks.')
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (create && i < segments.length - 1) await fs.mkdir(current, { recursive: true })
    }
    return current
  }
  private async load(root: string, relative: string): Promise<any | undefined> {
    try {
      const file = await this.file(root, relative)
      if ((await fs.stat(file)).size > MAX_FILE) throw new Error('Memory record exceeds 64 MiB.')
      return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
  }
  private async save(root: string, relative: string, value: unknown): Promise<void> {
    const body = JSON.stringify(value, null, 2) + '\n'
    if (Buffer.byteLength(body) > MAX_FILE) throw new Error('Memory history is full; no record was removed.')
    await writeFileAtomic(await this.file(root, relative, true), body)
  }
  private async project(root: string): Promise<MemoryProject> {
    const p = await this.load(root, 'project.json')
    if (p === undefined) return emptyMemoryProject()
    if (p?.version !== 1 || !validRevision(p.revision) || !p.nodeTasks || typeof p.nodeTasks !== 'object' || Array.isArray(p.nodeTasks)) throw new Error('Invalid project memory; it was not overwritten.')
    for (const [node, task] of Object.entries(p.nodeTasks)) { memoryId(node); memoryId(task) }
    const decisions = decodeDecisions(p.decisions)
    if (decisions.some((d) => d.scope !== 'project')) throw new Error('Invalid project decision scope.')
    return { version: 1, revision: p.revision, nodeTasks: { ...p.nodeTasks }, decisions }
  }
  private async task(root: string, id: string): Promise<MemoryTask> {
    memoryId(id)
    const t = await this.load(root, `tasks/${id}.json`)
    if (t?.version !== 1 || t.id !== id || !validRevision(t.revision) || typeof t.title !== 'string' || t.title.length > 200 || !Array.isArray(t.checkpoints)) throw new Error('Task memory is missing or invalid; it was not overwritten.')
    const decisions = decodeDecisions(t.decisions)
    if (decisions.some((d) => d.scope !== 'task')) throw new Error('Invalid task decision scope.')
    const checkpoints = t.checkpoints.map((c: any) => {
      const fields = parseCheckpoint(c)
      memoryId(c.id)
      if (typeof c.author !== 'string' || !Number.isFinite(c.at)) throw new Error('Invalid checkpoint metadata.')
      if (c.nodeId !== undefined) memoryId(c.nodeId)
      return { ...fields, id: c.id, at: c.at, author: c.author, ...(c.nodeId ? { nodeId: c.nodeId } : {}) }
    })
    return { version: 1, id, revision: t.revision, title: t.title, decisions, checkpoints }
  }
  private select(p: MemoryProject, selection: MemorySelection): string | undefined {
    if (selection.nodeId !== undefined) memoryId(selection.nodeId)
    if (selection.taskId !== undefined) memoryId(selection.taskId)
    const bound = selection.nodeId ? p.nodeTasks[selection.nodeId] : undefined
    if (bound && selection.taskId && bound !== selection.taskId) throw new Error('This session belongs to another task.')
    const id = selection.taskId ?? bound
    if (id && !Object.values(p.nodeTasks).includes(id)) throw new Error('Task is not in this project.')
    return id
  }
  private async ensureTask(target: MemoryTarget, p: MemoryProject, selection: MemorySelection): Promise<MemoryTask> {
    const id = this.select(p, selection)
    if (id) return this.task(target.root, id)
    if (!selection.nodeId) throw new Error('Select a task session first.')
    const task: MemoryTask = { version: 1, id: randomUUID(), revision: 0, title: (target.node?.title || 'Task').slice(0, 200), decisions: [], checkpoints: [] }
    await this.save(target.root, `tasks/${task.id}.json`, task)
    p.nodeTasks[selection.nodeId] = task.id
    p.revision++
    await this.save(target.root, 'project.json', p)
    return task
  }
  private async view(target: MemoryTarget, p: MemoryProject, selection: MemorySelection): Promise<MemoryView> {
    const tasks = await Promise.all([...new Set(Object.values(p.nodeTasks))].map((id) => this.task(target.root, id)))
    const selected = this.select(p, selection)
    return { project: p, task: tasks.find((t) => t.id === selected), tasks: tasks.map((t) => ({ id: t.id, title: t.title, updatedAt: t.checkpoints.at(-1)?.at })) }
  }
  private async run<T>(projectId: string, selection: MemorySelection, write: boolean, operation: (target: MemoryTarget, p: MemoryProject) => Promise<T>): Promise<MemoryResult<T>> {
    try {
      if (!selection || typeof selection !== 'object') throw new Error('Invalid memory selection.')
      if (selection.nodeId !== undefined) memoryId(selection.nodeId)
      const target = this.resolver.project(projectId, selection.nodeId)
      if (!target) return { ok: false, unsupported: true, error: 'Project memory is available for local folder projects in Desktop.' }
      target.root = await fs.realpath(target.root)
      const key = target.root
      const promise = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
        let lock: Awaited<ReturnType<typeof fs.open>> | undefined
        let lockPath = ''
        if (write) {
          lockPath = await this.file(target.root, 'write.lock', true)
          // Exclusive across desktop processes. A crashed writer leaves an actionable error,
          // never a guessed stale timeout that could evict a live writer.
          try { lock = await fs.open(lockPath, 'wx'); await lock.writeFile(String(process.pid)) }
          catch { throw new Error('Memory is being written by another process (write.lock). Retry; after a crash, remove the stale lock only when no writer is running.') }
        }
        try { return await operation(target, await this.project(target.root)) }
        finally { if (lock) { await lock.close(); await fs.unlink(lockPath) } }
      })
      queues.set(key, promise)
      try { return { ok: true, value: await promise } }
      finally { if (queues.get(key) === promise) queues.delete(key) }
    } catch (e) { return failure(e) }
  }
  read(projectId: string, selection: MemorySelection = {}): Promise<MemoryResult<MemoryView>> {
    return this.run(projectId, selection, false, (target, p) => this.view(target, p, selection))
  }
  propose(projectId: string, selection: MemorySelection, raw: DecisionInput, expectedRevision: number, author = 'User'): Promise<MemoryResult<MemoryView>> {
    return this.run(projectId, selection, true, async (target, p) => {
      const input = parseDecision(raw)
      const id = this.select(p, selection)
      // Check BEFORE allocating a task, so stale requests cannot create side effects.
      const existing = input.scope === 'task' && id ? await this.task(target.root, id) : undefined
      checkMemoryRevision(input.scope === 'project' ? p.revision : existing?.revision ?? 0, expectedRevision)
      const doc = input.scope === 'project' ? p : existing ?? await this.ensureTask(target, p, selection)
      if (input.replaces && !doc.decisions.some((d) => d.id === input.replaces && ['approved', 'proposed'].includes(d.status))) throw new Error('The decision to replace is no longer active.')
      doc.decisions.push({ ...input, id: randomUUID(), status: 'proposed', at: Date.now(), author })
      doc.revision++
      await this.save(target.root, input.scope === 'project' ? 'project.json' : `tasks/${(doc as MemoryTask).id}.json`, doc)
      this.changed(projectId)
      return this.view(target, p, selection)
    })
  }
  checkpoint(projectId: string, selection: MemorySelection, raw: MemoryCheckpointInput, expectedRevision: number, author = 'User'): Promise<MemoryResult<MemoryView>> {
    return this.run(projectId, selection, true, async (target, p) => {
      const input = parseCheckpoint(raw)
      const id = this.select(p, selection)
      const existing = id ? await this.task(target.root, id) : undefined
      checkMemoryRevision(existing?.revision ?? 0, expectedRevision)
      const task = existing ?? await this.ensureTask(target, p, selection)
      task.title = input.goal.slice(0, 200)
      task.checkpoints.push({ ...input, id: randomUUID(), at: Date.now(), author, ...(selection.nodeId ? { nodeId: selection.nodeId } : {}) })
      task.revision++
      await this.save(target.root, `tasks/${task.id}.json`, task)
      this.changed(projectId)
      return this.view(target, p, selection)
    })
  }
  review(projectId: string, selection: MemorySelection, scope: 'project' | 'task', id: string, action: MemoryReviewAction, expectedRevision: number): Promise<MemoryResult<MemoryView>> {
    return this.run(projectId, selection, true, async (target, p) => {
      if (!['project', 'task'].includes(scope) || !['approve', 'reject', 'withdraw'].includes(action)) throw new Error('Invalid decision action.')
      const taskId = this.select(p, selection)
      const doc = scope === 'project' ? p : taskId ? await this.task(target.root, taskId) : undefined
      if (!doc) throw new Error('Task not found.')
      checkMemoryRevision(doc.revision, expectedRevision)
      const d = doc.decisions.find((item) => item.id === id)
      if (!d || (action === 'withdraw' ? d.status !== 'approved' : d.status !== 'proposed')) throw new Error('Decision changed. Reload before reviewing.')
      if (action === 'approve' && d.replaces) {
        const previous = doc.decisions.find((item) => item.id === d.replaces)
        if (!previous || !['approved', 'proposed'].includes(previous.status)) throw new Error('The replaced decision changed. Submit a new proposal.')
        previous.status = 'superseded'
        previous.reviewedAt = Date.now(); previous.reviewedBy = 'User'
      }
      d.status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'withdrawn'
      d.reviewedAt = Date.now(); d.reviewedBy = 'User'
      doc.revision++
      await this.save(target.root, scope === 'project' ? 'project.json' : `tasks/${taskId}.json`, doc)
      this.changed(projectId)
      return this.view(target, p, selection)
    })
  }
  bind(projectId: string, taskId: string, nodeId: string): Promise<MemoryResult<void>> {
    return this.run(projectId, {}, true, async (target, p) => {
      memoryId(nodeId); memoryId(taskId)
      this.select(p, { taskId })
      await this.task(target.root, taskId)
      if (p.nodeTasks[nodeId] === taskId) return
      if (p.nodeTasks[nodeId]) throw new Error('Session already belongs to a different task.')
      p.nodeTasks[nodeId] = taskId; p.revision++
      await this.save(target.root, 'project.json', p)
      this.changed(projectId)
    })
  }
  packet(projectId: string, selection: MemorySelection = {}, startup = false): Promise<MemoryResult<MemoryPacket>> {
    return this.run(projectId, selection, true, async (target, p) => {
      const existing = this.select(p, selection)
      if (startup && !existing && !p.decisions.some((d) => d.status === 'approved')) return { body: '' }
      if (selection.nodeId && !existing && !startup) await this.ensureTask(target, p, selection)
      const view = await this.view(target, p, selection)
      const body = renderMemoryPacket(view, target.root)
      const filePath = await this.file(target.root, `packets/${randomUUID()}.md`, true)
      await writeFileAtomic(filePath, body)
      return { body, filePath, taskId: view.task?.id }
    })
  }
  source(projectId: string, raw: MemorySource): Promise<MemoryResult<string>> {
    return this.run(projectId, {}, false, async (target) => {
      const source = parseMemorySources([raw])[0]
      if (source.kind !== 'file') throw new Error('Use the source URL or session reference.')
      const location = source.location.replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/, '')
      if (source.commit) {
        try {
          const { stdout } = await promisify(execFile)('git', ['-C', target.root, 'show', `${source.commit}:${location}`], { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 5000, windowsHide: true })
          if (stdout.includes('\0')) throw new Error('Binary source')
          return `Git ${source.commit}:${location}\n\n${stdout}`
        } catch { throw new Error('Original Git source unavailable or larger than 64 KiB. The saved excerpt is still available.') }
      }
      let file: string
      try { file = await fs.realpath(path.resolve(target.root, location)) }
      catch { throw new Error('Original file unavailable. The saved excerpt is still available.') }
      const relative = path.relative(target.root, file)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Original file is outside this project.')
      const handle = await fs.open(file, 'r')
      try {
        if (!(await handle.stat()).isFile()) throw new Error('Source is not a regular file.')
        const bytes = Buffer.alloc(64 * 1024)
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        const text = bytes.subarray(0, bytesRead).toString('utf8')
        if (text.includes('\0')) throw new Error('Binary source; use the saved excerpt.')
        return text + (bytesRead === bytes.length ? '\n[Preview limited to 64 KiB.]' : '')
      } finally { await handle.close() }
    })
  }
  async prepare(nodeId: string): Promise<MemoryResult<MemoryPacket>> {
    const projectId = this.resolver.projectForNode(nodeId)
    if (!projectId) return { ok: false, unsupported: true, error: 'No local owning project for memory.' }
    return this.packet(projectId, { nodeId }, true)
  }
  async control(projectId: string, nodeId: string, args: Record<string, string>, verified: boolean): Promise<{ ok: boolean; message: string; error?: string }> {
    try {
      if (!verified) throw new Error('Project memory requires verified node identity.')
      const target = this.resolver.project(projectId, nodeId)
      if (!target?.node) throw new Error('Memory is available only to local agent sessions in this project.')
      let result: MemoryResult<unknown>
      const selection = { nodeId }
      if (args.action === 'read') result = await this.read(projectId, selection)
      else if (args.action === 'packet') result = await this.packet(projectId, selection)
      else if (args.action === 'propose' || args.action === 'checkpoint') {
        if (!args.file) throw new Error('Use --file <JSON path>.')
        const file = path.resolve(target.node.cwd, args.file)
        if (!(await fs.stat(file)).isFile() || (await fs.stat(file)).size > MEMORY_INPUT_MAX) throw new Error('Memory input must be a JSON file of at most 256 KiB.')
        const input = JSON.parse(await fs.readFile(file, 'utf8'))
        result = args.action === 'propose'
          ? await this.propose(projectId, selection, input.decision, input.expectedRevision, target.node.author)
          : await this.checkpoint(projectId, selection, input.checkpoint, input.expectedRevision, target.node.author)
      } else throw new Error('Memory action must be read, propose, checkpoint or packet. Decisions can only be approved in Desktop.')
      return result.ok ? { ok: true, message: JSON.stringify(result.value) } : { ok: false, error: result.error, message: result.error }
    } catch (e) { const result = failure(e) as { error: string }; return { ok: false, error: result.error, message: result.error } }
  }
}

export function registerProjectMemory(platform: CorePlatform, service: ProjectMemoryService): void {
  const methods = ['read', 'propose', 'checkpoint', 'review', 'packet', 'source', 'bind', 'prepare'] as const
  for (const method of methods) platform.handleWithSender(`${IPC.projectMemoryPrefix}${method}`, (sender, ...args: any[]) => {
    if (!platform.isLocalClient?.(sender)) return { ok: false, unsupported: true, error: 'Project memory is available only in the local Desktop window.' }
    // Explicit method allowlist above; agents never reach the review IPC through control.
    return (service[method] as (...values: any[]) => unknown).apply(service, args)
  })
}
