import { promises as fs } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { writeFileAtomic } from './fs-atomic'
import { measureReadiness, readinessFiles, readinessGit, readinessHead } from './readiness-git'
import {
  parseAcceptance, parseReadinessReport, READINESS_INPUT_MAX,
  type AcceptanceCriterion, type CodeSnapshot, type ReadinessReportInput,
  type ReadinessResult, type ReadinessView, type TaskReadiness
} from '../shared/task-readiness'
import { isSafeNodeId } from '../shared/safe-id'
import type { CorePlatform } from './platform'
import { IPC } from '../shared/ipc'

export interface ReadinessTarget { projectRoot: string; cwd: string; author: string }
export type ReadinessResolver = (projectId: string, nodeId: string) => ReadinessTarget | undefined
const PAGE = 20
const SHA = /^[a-f0-9]{40,64}$/
const fail = (e: unknown): { ok: false; error: string } => ({ ok: false, error: e instanceof Error ? e.message : String(e) })

function snapshotValid(v: CodeSnapshot): boolean {
  if (!v || typeof v !== 'object') return false
  try { parseAcceptance(v.acceptance) } catch { return false }
  return isSafeNodeId(v.id) && Number.isFinite(v.at) && SHA.test(v.head) && /^[a-f0-9]{64}$/.test(v.fingerprint) && typeof v.checkout === 'string' && Number.isSafeInteger(v.criteriaRevision) && SHA.test(v.baseCommit) && Array.isArray(v.files) && v.files.every((p) => typeof p === 'string')
}
function decode(raw: string, nodeId: string): TaskReadiness {
  const state = JSON.parse(raw) as TaskReadiness
  if (!state || state.version !== 1 || state.nodeId !== nodeId || !Number.isSafeInteger(state.criteriaRevision) || state.criteriaRevision < 0 || !SHA.test(state.baseCommit) || typeof state.checkout !== 'string' || !Array.isArray(state.captures) || !Array.isArray(state.reports)) throw new Error('The readiness file is invalid; it was not overwritten.')
  state.criteria = parseAcceptance(state.criteria)
  if (state.captures.some((s) => !snapshotValid(s))) throw new Error('Invalid saved readiness snapshot.')
  state.reports = state.reports.map((r) => {
    if (!r || !isSafeNodeId(r.id) || !Number.isFinite(r.at) || !snapshotValid(r.snapshot) || typeof r.author !== 'string' || !['agent', 'user'].includes(r.source)) throw new Error('Invalid saved readiness report.')
    const payload = parseReadinessReport({ ...r, snapshotId: r.snapshot.id })
    const { snapshotId: _id, ...evidence } = payload
    return { ...r, ...evidence, acceptance: parseAcceptance(r.acceptance) }
  })
  return state
}

export class TaskReadinessService {
  private queues = new Map<string, Promise<unknown>>()
  private earlyBases = new Map<string, { checkout: string; head: string }>()
  constructor(private resolve: ReadinessResolver, private changed: (projectId: string, nodeId: string) => void = () => {}) {}

  private target(projectId: string, nodeId: string): ReadinessTarget {
    if (!isSafeNodeId(nodeId)) throw new Error('Invalid readiness node id.')
    const target = this.resolve(projectId, nodeId)
    if (!target) throw new Error('Readiness is available only for saved terminal cards in local Desktop projects.')
    return target
  }
  private async file(target: ReadinessTarget, nodeId: string, create = false): Promise<string> {
    const root = await fs.realpath(target.projectRoot)
    const dir = path.join(root, '.nodeterm', 'readiness')
    // Never follow app-state symlinks outside the owning project when writing sidecars.
    for (const p of [path.join(root, '.nodeterm'), dir]) {
      try { if ((await fs.lstat(p)).isSymbolicLink()) throw new Error('Readiness storage must be a directory inside the project.') }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (create) await fs.mkdir(p, { recursive: true })
    }
    const file = path.join(dir, `${nodeId}.json`)
    try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Readiness files must not be symlinks.') }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    return file
  }
  private async load(target: ReadinessTarget, nodeId: string): Promise<TaskReadiness | undefined> {
    try {
      const file = await this.file(target, nodeId)
      if ((await fs.stat(file)).size > 64 * 1024 * 1024) throw new Error('Readiness history exceeds the 64 MiB file limit.')
      return decode(await fs.readFile(file, 'utf8'), nodeId)
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
  }
  private async initial(target: ReadinessTarget, nodeId: string): Promise<TaskReadiness> {
    const current = await readinessHead(target.cwd)
    const early = this.earlyBases.get(nodeId)
    return { version: 1, nodeId, criteriaRevision: 0, criteria: [], baseCommit: early?.checkout === current.checkout ? early.head : current.head, checkout: current.checkout, captures: [], reports: [] }
  }
  private async save(target: ReadinessTarget, state: TaskReadiness): Promise<void> {
    const raw = JSON.stringify(state, null, 2)
    if (Buffer.byteLength(raw) > 64 * 1024 * 1024) throw new Error('Readiness history is full; no report was removed or overwritten.')
    await writeFileAtomic(await this.file(target, state.nodeId, true), raw)
  }
  private async serial<T>(projectId: string, nodeId: string, operation: (target: ReadinessTarget) => Promise<T>): Promise<ReadinessResult<T>> {
    try {
      const target = this.target(projectId, nodeId)
      const key = path.join(target.projectRoot, nodeId)
      const promise = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => operation(target))
      this.queues.set(key, promise)
      try { return { ok: true, value: await promise } }
      finally { if (this.queues.get(key) === promise) this.queues.delete(key) }
    } catch (e) { return fail(e) }
  }

  /** Called before a local PTY's first launch; a not-yet-saved node retains its base in memory. */
  async rememberBaseline(nodeId: string, cwd: string, projectId?: string): Promise<void> {
    if (!isSafeNodeId(nodeId)) return
    try {
      if (!this.earlyBases.has(nodeId)) this.earlyBases.set(nodeId, await readinessHead(cwd))
      if (projectId) await this.serial(projectId, nodeId, async (target) => {
        if (!(await this.load(target, nodeId))) await this.save(target, await this.initial(target, nodeId))
      })
    } catch { /* A non-Git terminal must still launch. The readiness UI reports availability. */ }
  }

  async read(projectId: string, nodeId: string, offset = 0): Promise<ReadinessResult<ReadinessView>> {
    return this.serial(projectId, nodeId, async (target) => {
      const state = await this.load(target, nodeId)
      if (!state) return { criteria: [], criteriaRevision: 0, baseCommit: '', reports: [], total: 0, freshness: 'none' }
      const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
      return { criteria: state.criteria, criteriaRevision: state.criteriaRevision, baseCommit: state.baseCommit, reports: [...state.reports].reverse().slice(start, start + PAGE), total: state.reports.length, freshness: state.reports.length ? 'unknown' : 'none' }
    })
  }
  async criteria(projectId: string, nodeId: string, raw: AcceptanceCriterion[], expectedRevision: number, baseCommit?: string): Promise<ReadinessResult<void>> {
    return this.serial(projectId, nodeId, async (target) => {
      const criteria = parseAcceptance(raw)
      const state = await this.load(target, nodeId) ?? await this.initial(target, nodeId)
      if (state.criteriaRevision !== expectedRevision) throw new Error('Acceptance criteria changed. Reload before saving.')
      let base = state.baseCommit
      if (baseCommit !== undefined) {
        if (!SHA.test(baseCommit)) throw new Error('Choose a full local commit SHA as the comparison base.')
        base = (await readinessGit(target.cwd, ['rev-parse', '--verify', `${baseCommit}^{commit}`])).toString().trim()
        const { checkout } = await readinessHead(target.cwd)
        if (state.checkout !== checkout) state.criteriaRevision++
        state.checkout = checkout
      }
      if (JSON.stringify(criteria) !== JSON.stringify(state.criteria) || base !== state.baseCommit) state.criteriaRevision++
      state.criteria = criteria
      state.baseCommit = base
      await this.save(target, state)
      this.changed(projectId, nodeId)
    })
  }
  async capture(projectId: string, nodeId: string): Promise<ReadinessResult<CodeSnapshot>> {
    return this.serial(projectId, nodeId, async (target) => {
      const state = await this.load(target, nodeId) ?? await this.initial(target, nodeId)
      const measurement = await measureReadiness(target.cwd)
      if (measurement.checkout !== state.checkout) throw new Error('The task checkout changed. Update its comparison base before creating another report.')
      const snapshot: CodeSnapshot = { id: randomUUID(), at: Date.now(), head: measurement.head, fingerprint: measurement.fingerprint, checkout: measurement.checkout, criteriaRevision: state.criteriaRevision, acceptance: state.criteria.map((c) => ({ ...c })), baseCommit: state.baseCommit, files: await readinessFiles(measurement.checkout, state.baseCommit, measurement.untracked) }
      if ((await measureReadiness(target.cwd)).fingerprint !== measurement.fingerprint) throw new Error('Code changed while the snapshot was being read. Try again.')
      state.captures = [...state.captures.slice(-31), snapshot]
      await this.save(target, state)
      this.changed(projectId, nodeId)
      return snapshot
    })
  }
  async report(projectId: string, nodeId: string, raw: ReadinessReportInput, source: 'agent' | 'user' = 'user', author = 'you'): Promise<ReadinessResult<void>> {
    return this.serial(projectId, nodeId, async (target) => {
      if (Buffer.byteLength(JSON.stringify(raw)) > READINESS_INPUT_MAX) throw new Error('Readiness report exceeds 256 KiB.')
      const payload = parseReadinessReport(raw)
      const state = await this.load(target, nodeId)
      if (!state) throw new Error('Capture a snapshot before submitting evidence.')
      const snapshot = state.captures.find((s) => s.id === payload.snapshotId)
      if (!snapshot) throw new Error('Unknown or already submitted snapshot. Capture a new snapshot before verification.')
      if (snapshot.criteriaRevision !== state.criteriaRevision) throw new Error('Acceptance criteria changed after this snapshot. Capture a new snapshot and assess the updated criteria.')
      if (payload.criteria.some((c) => !state.criteria.some((a) => a.id === c.id))) throw new Error('Report references an unknown acceptance criterion.')
      const { snapshotId: _id, ...evidence } = payload
      state.reports.push({ ...evidence, id: randomUUID(), at: Date.now(), author: source === 'agent' ? target.author : author.slice(0, 100), source, snapshot, acceptance: snapshot.acceptance.map((c) => ({ ...c })) })
      state.captures = state.captures.filter((s) => s.id !== snapshot.id)
      await this.save(target, state)
      this.changed(projectId, nodeId)
    })
  }
  async check(projectId: string, nodeId: string): Promise<ReadinessResult<ReadinessView>> {
    return this.serial(projectId, nodeId, async (target) => {
      const state = await this.load(target, nodeId)
      const reports = state ? [...state.reports].reverse().slice(0, PAGE) : []
      const view: ReadinessView = { criteria: state?.criteria ?? [], criteriaRevision: state?.criteriaRevision ?? 0, baseCommit: state?.baseCommit ?? '', reports, total: state?.reports.length ?? 0, freshness: reports.length ? 'unknown' : 'none' }
      if (!state || !reports[0]) {
        try { await readinessHead(target.cwd) }
        catch { view.unsupported = true; view.reason = 'Readiness requires an available local Git checkout.' }
        return view
      }
      try {
        const current = await measureReadiness(target.cwd)
        const snapshot = reports[0].snapshot
        view.freshness = current.checkout === snapshot.checkout && current.fingerprint === snapshot.fingerprint && state.criteriaRevision === snapshot.criteriaRevision ? 'current' : 'stale'
        if (view.freshness === 'stale') view.reason = 'Code or acceptance criteria changed since this report.'
      } catch (e) { view.reason = e instanceof Error ? e.message : 'Could not check code.' }
      return view
    })
  }
  async control(projectId: string, nodeId: string, args: Record<string, string | undefined>, verified: boolean): Promise<{ ok: boolean; message: string; error?: string }> {
    let result: ReadinessResult<unknown>
    try {
      if (!verified || (args.node !== undefined && args.node !== nodeId)) throw new Error('Readiness reports can address only the verified caller’s own card.')
      if (args.project !== undefined) throw new Error('Readiness uses the caller’s own project.')
      const action = args.action ?? 'read'
      if (action === 'read') result = await this.check(projectId, nodeId)
      else if (action === 'snapshot') result = await this.capture(projectId, nodeId)
      else if (action === 'criteria' || action === 'report') {
        const target = this.target(projectId, nodeId)
        if (!args.file) throw new Error('Use --file <JSON path> for criteria or report.')
        const file = path.resolve(target.cwd, args.file)
        const stat = await fs.stat(file)
        if (!stat.isFile() || stat.size > READINESS_INPUT_MAX) throw new Error('Readiness input must be a JSON file of at most 256 KiB.')
        const raw = JSON.parse(await fs.readFile(file, 'utf8'))
        if (action === 'report') result = await this.report(projectId, nodeId, raw, 'agent')
        else result = await this.criteria(projectId, nodeId, raw.criteria, raw.expectedRevision, raw.baseCommit)
      } else throw new Error('Readiness action must be read, criteria, snapshot or report.')
    } catch (e) { result = fail(e) }
    return result.ok ? { ok: true, message: JSON.stringify(result.value ?? { saved: true }) } : { ok: false, error: result.error, message: result.error }
  }
}

export function registerReadiness(platform: CorePlatform, service: TaskReadinessService): void {
  const bind = (channel: string, run: (projectId: string, nodeId: string, ...args: any[]) => Promise<unknown>): void => {
    platform.handleWithSender(channel, (sender, projectId: string, nodeId: string, ...args: any[]) => {
      if (!platform.isLocalClient?.(sender)) return { ok: false, error: 'Readiness is available only in the local Desktop window.', unsupported: true }
      return run(projectId, nodeId, ...args)
    })
  }
  bind(IPC.readinessRead, service.read.bind(service))
  bind(IPC.readinessCriteria, service.criteria.bind(service))
  bind(IPC.readinessCapture, service.capture.bind(service))
  bind(IPC.readinessReport, (projectId, nodeId, report) => service.report(projectId, nodeId, report))
  bind(IPC.readinessCheck, service.check.bind(service))
}
