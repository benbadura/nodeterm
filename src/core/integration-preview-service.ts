import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  detectPreviewCommands, previewOptionsValid, PREVIEW_HISTORY_LIMIT, PREVIEW_UNAVAILABLE,
  type PreviewInspection, type PreviewOptions, type PreviewReport, type PreviewOutcome
} from '../shared/integration-preview'
import { isValidGitRef, parseWorktreePorcelain } from '../shared/worktree'
import { resolveProjectSettings, type ProjectSettingsSnapshot } from '../shared/project-settings'
import { createSetupOutputStream } from './setup-output-stream'
import { previewProcessEnv, previewShell, runPreviewProcess, type PreviewProcessResult } from './integration-preview-process'

interface Target { cwd?: string; ssh?: unknown }
interface StoredRun {
  repoPath: string
  commonDir: string
  worktreePath: string
  pid?: number
  report: PreviewReport
}
interface RepositoryState { defaults?: PreviewOptions; runs: StoredRun[] }
interface State { version: 1; repositories: Record<string, RepositoryState> }
interface ActiveRun { entry: StoredRun; abort: AbortController; completion: Promise<void> }

export interface IntegrationPreviewDeps {
  userDataDir: string
  targetInfo(projectId: string): Target | null
  readSettings(projectId: string): Promise<ProjectSettingsSnapshot | null>
  emit(projectId: string, report: PreviewReport): void
}

const ROOT_FILES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  '.yarnrc.yml', 'pyproject.toml', 'uv.lock', 'requirements.txt', 'requirements-dev.txt', 'pytest.ini',
  'Cargo.toml', 'Cargo.lock', 'go.mod'
])
const CONTENT_FILES = new Set(['package.json', 'yarn.lock', 'pyproject.toml', 'requirements.txt', 'requirements-dev.txt'])
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const message = (e: unknown) => e instanceof Error ? e.message : String(e)

/** Desktop-owned previews. All mutations occur in detached, app-owned worktrees. */
export class IntegrationPreviewService {
  private state: State = { version: 1, repositories: {} }
  private loaded?: Promise<void>
  private writeChain: Promise<void> = Promise.resolve()
  private active = new Map<string, ActiveRun>()
  private starting = new Set<string>()
  private recovering = new Map<string, Promise<void>>()
  private knownProjects = new Map<string, Set<string>>()
  private disposed = false
  private directory: string

  constructor(private readonly deps: IntegrationPreviewDeps) {
    this.directory = path.join(deps.userDataDir, 'integration-preview')
  }

  private async load(): Promise<void> {
    if (!this.loaded) this.loaded = (async () => {
      await fs.mkdir(this.directory, { recursive: true })
      this.directory = await fs.realpath(this.directory)
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.directory, 'state.json'), 'utf8'))
        if (parsed.version !== 1 || !parsed.repositories || typeof parsed.repositories !== 'object') throw new Error('Invalid preview state.')
        for (const [key, value] of Object.entries(parsed.repositories)) {
          const repository = value as RepositoryState
          if (!repository || !Array.isArray(repository.runs)) continue
          const runs = repository.runs.filter((r) => r && typeof r.repoPath === 'string' && typeof r.commonDir === 'string' &&
            r.report && RUN_ID.test(r.report.runId) && previewOptionsValid(r.report.options) &&
            r.worktreePath === this.worktreePath(r.report.runId) && this.repoKey(r.commonDir) === key)
          this.state.repositories[key] = {
            defaults: previewOptionsValid(repository.defaults) ? repository.defaults : undefined,
            runs
          }
          for (const run of runs) {
            if (run.report.phase !== 'finished') {
              run.report.phase = 'finished'
              run.report.outcome = 'interrupted'
              run.report.finishedAt = new Date().toISOString()
              run.report.message = 'The application stopped before this preview completed.'
              run.report.seq++
            }
          }
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
    })()
    return this.loaded
  }

  private persist(): Promise<void> {
    // Snapshot now; queued writes cannot accidentally serialize a later run's state.
    const body = JSON.stringify(this.state)
    const write = this.writeChain.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true })
      const temporary = path.join(this.directory, `state-${randomUUID()}.tmp`)
      await fs.writeFile(temporary, body, { mode: 0o600 })
      await fs.rename(temporary, path.join(this.directory, 'state.json'))
    })
    this.writeChain = write
    return write
  }

  private repoKey(commonDir: string): string { return createHash('sha256').update(commonDir).digest('hex') }
  private worktreePath(runId: string): string { return path.join(this.directory, 'runs', runId, 'worktree') }

  private git(cwd: string, args: string[], run?: ActiveRun, output?: (text: string) => void): Promise<PreviewProcessResult> {
    return runPreviewProcess({
      executable: 'git', args: [
        '-c', `core.hooksPath=${path.join(this.directory, 'empty-hooks')}`,
        '-c', 'commit.gpgSign=false', '-c', 'merge.gpgSign=false', '-c', 'rerere.enabled=false',
        '-c', 'user.name=nodeterm integration preview', '-c', 'user.email=integration-preview@nodeterm.invalid', ...args
      ], cwd, timeoutMs: 60_000, signal: run?.abort.signal, onChunk: output,
      onPid: run ? (pid) => { run.entry.pid = pid; void this.persist().catch(() => {}) } : undefined
    })
  }

  private async repository(projectId: string): Promise<{ root: string; commonDir: string; key: string }> {
    const target = this.deps.targetInfo(projectId)
    if (!target?.cwd || target.ssh) throw new Error(PREVIEW_UNAVAILABLE)
    const rootRead = await this.git(target.cwd, ['rev-parse', '--show-toplevel'])
    if (rootRead.exitCode !== 0) throw new Error(rootRead.err || 'This project is not a Git repository.')
    const root = await fs.realpath(rootRead.out.trim())
    const commonRead = await this.git(root, ['rev-parse', '--git-common-dir'])
    if (commonRead.exitCode !== 0) throw new Error(commonRead.err || 'Could not read the Git directory.')
    const commonDir = await fs.realpath(path.resolve(root, commonRead.out.trim()))
    const key = this.repoKey(commonDir)
    const ids = this.knownProjects.get(key) ?? new Set<string>()
    ids.add(projectId)
    this.knownProjects.set(key, ids)
    return { root, commonDir, key }
  }

  private async refs(root: string): Promise<string[]> {
    const result = await this.git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])
    if (result.exitCode !== 0) throw new Error(result.err || 'Could not list branches.')
    return result.out.split('\n').filter((r) => r && !r.endsWith('/HEAD'))
  }

  private displayRef(ref: string): string { return ref.replace(/^refs\/(?:heads|remotes)\//, '') }
  private async resolveRef(root: string, name: string, refs: string[]): Promise<string> {
    if (!isValidGitRef(name)) throw new Error(`Invalid branch: ${name}`)
    // Prefer a local name; a remote-tracking name is unambiguous only when no local name matches.
    const ref = refs.find((r) => r === `refs/heads/${name}`) ?? refs.find((r) => r === `refs/remotes/${name}`)
    if (!ref) throw new Error(`Branch no longer exists: ${name}`)
    const result = await this.git(root, ['rev-parse', '--verify', `${ref}^{commit}`])
    if (result.exitCode !== 0 || !/^[a-f0-9]{40,64}\s*$/.test(result.out)) throw new Error(`Could not resolve branch: ${name}`)
    return result.out.trim()
  }

  async inspect(projectId: string, baseRef?: string): Promise<PreviewInspection> {
    try {
      await this.load()
      const repo = await this.repository(projectId)
      await this.recoverRepository(repo.key)
      const refs = await this.refs(repo.root)
      const branches = [...new Set(refs.map((r) => this.displayRef(r)))]
      const defaults = this.state.repositories[repo.key]?.defaults
      const settings = await this.deps.readSettings(projectId)
      const configured = resolveProjectSettings(settings?.local, settings?.shared ?? undefined).worktree.baseRef?.value
      const head = await this.git(repo.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      const defaultBaseRef = [configured, 'main', 'master', head.out.trim(), branches[0]].find((r) => r && branches.includes(r)) ?? ''
      const picked = baseRef ?? (defaults && branches.includes(defaults.baseRef) ? defaults.baseRef : defaultBaseRef)
      const sha = await this.resolveRef(repo.root, picked, refs)
      const tree = await this.git(repo.root, ['ls-tree', '-z', '--name-only', sha])
      if (tree.exitCode !== 0) throw new Error(tree.err || 'Could not inspect the base commit.')
      const files: Record<string, string> = Object.create(null)
      for (const name of tree.out.split('\0')) {
        if (!ROOT_FILES.has(name) && !/\.(sln|slnx|csproj|fsproj|vbproj)$/.test(name)) continue
        files[name] = ''
        if (CONTENT_FILES.has(name)) {
          const blob = await this.git(repo.root, ['show', `${sha}:${name}`])
          if (blob.exitCode === 0) files[name] = blob.out
        }
      }
      return { available: true, branches, defaultBaseRef: picked, suggestions: detectPreviewCommands(files, process.platform === 'win32'), defaults }
    } catch (e) {
      return { available: false, reason: message(e), branches: [], defaultBaseRef: '', suggestions: [] }
    }
  }

  async start(projectId: string, options: PreviewOptions): Promise<{ ok: boolean; runId?: string; message?: string }> {
    if (!previewOptionsValid(options)) return { ok: false, message: 'Select a base, at least two different branches, a test command, and a timeout from 1 to 120 minutes.' }
    let key: string | undefined
    let claimed = false
    try {
      if (this.disposed) throw new Error('Integration preview is shutting down.')
      await this.load()
      const repo = await this.repository(projectId)
      key = repo.key
      if (this.starting.has(key) || this.active.has(key)) throw new Error('An integration preview is already running for this repository.')
      this.starting.add(key)
      claimed = true
      await this.recoverRepository(key, true)
      const refs = await this.refs(repo.root)
      // Snapshot every ref before creating the worktree. A moving branch cannot change this run.
      const base = { name: options.baseRef, sha: await this.resolveRef(repo.root, options.baseRef, refs) }
      const branches = [] as PreviewReport['branches']
      for (const name of options.branches) branches.push({ name, sha: await this.resolveRef(repo.root, name, refs) })
      if (this.disposed) throw new Error('Integration preview is shutting down.')
      const runId = randomUUID()
      const entry: StoredRun = {
        repoPath: repo.root, commonDir: repo.commonDir, worktreePath: this.worktreePath(runId),
        report: {
          runId, projectId, seq: 0, phase: 'resolving', options: structuredClone(options), base, branches,
          mergedBranches: [], conflicts: [], startedAt: new Date().toISOString(),
          logs: { git: '', setup: '', tests: '' }, cleanup: 'pending'
        }
      }
      const repository = this.state.repositories[key] ??= { runs: [] }
      repository.defaults = structuredClone(options)
      repository.runs.unshift(entry)
      await this.persist() // Record ownership before the first filesystem mutation.
      const run: ActiveRun = { entry, abort: new AbortController(), completion: Promise.resolve() }
      this.active.set(key, run)
      this.publish(entry)
      run.completion = this.execute(run, key)
      return { ok: true, runId }
    } catch (e) { return { ok: false, message: message(e) } }
    finally { if (key && claimed) this.starting.delete(key) }
  }

  private publish(entry: StoredRun): void {
    entry.report.seq++
    const ids = this.knownProjects.get(this.repoKey(entry.commonDir)) ?? new Set([entry.report.projectId])
    for (const id of ids) this.deps.emit(id, structuredClone(entry.report))
  }

  private async execute(run: ActiveRun, key: string): Promise<void> {
    const entry = run.entry
    const report = entry.report
    const gitStream = createSetupOutputStream((chunk) => { report.logs.git += chunk; this.publish(entry) })
    let outcome: PreviewOutcome = 'git-error'
    try {
      await fs.mkdir(path.dirname(entry.worktreePath), { recursive: true })
      await fs.mkdir(path.join(this.directory, 'empty-hooks'), { recursive: true })
      const added = await this.git(entry.repoPath, ['worktree', 'add', '--detach', '--', entry.worktreePath, report.base!.sha], run, gitStream.append)
      if (added.exitCode !== 0) throw new Error(added.err || added.out || 'Could not create the integration worktree.')
      report.phase = 'merging'
      this.publish(entry)
      for (const branch of report.branches) {
        if (run.abort.signal.aborted) break
        report.currentBranch = branch.name
        gitStream.append(`\nMerging ${branch.name} (${branch.sha})\n`)
        this.publish(entry)
        const merged = await this.git(entry.worktreePath, ['merge', '--no-ff', '--no-edit', '--no-verify', '--no-gpg-sign', branch.sha], run, gitStream.append)
        if (merged.exitCode !== 0) {
          // Failure is a conflict ONLY when Git's index actually contains unmerged entries.
          const unmerged = await this.git(entry.worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z'])
          report.conflicts = unmerged.exitCode === 0 ? unmerged.out.split('\0').filter(Boolean) : []
          outcome = report.conflicts.length ? 'conflict' : 'git-error'
          report.message = merged.err || merged.out || `Could not merge ${branch.name}.`
          return
        }
        report.mergedBranches.push(branch.name)
      }
      if (run.abort.signal.aborted) return
      delete report.currentBranch
      gitStream.flush()
      for (const stage of ['setup', 'tests'] as const) {
        const command = stage === 'setup' ? report.options.setupCommand : report.options.testCommand
        if (!command.trim()) continue
        report.phase = stage === 'setup' ? 'preparing' : 'testing'
        this.publish(entry)
        const result = await runPreviewProcess({
          ...previewShell(command), cwd: entry.worktreePath, env: previewProcessEnv(entry.worktreePath),
          signal: run.abort.signal, timeoutMs: report.options.timeoutMinutes * 60_000,
          onPid: (pid) => { entry.pid = pid; void this.persist().catch(() => {}) },
          onChunk: (chunk) => { report.logs[stage] += chunk; this.publish(entry) }
        })
        if (stage === 'setup') report.setupExitCode = result.exitCode
        else report.testExitCode = result.exitCode
        if (run.abort.signal.aborted) return
        if (result.timedOut) { outcome = 'timed-out'; report.message = `${stage === 'setup' ? 'Preparation' : 'Tests'} exceeded the time limit.`; return }
        if (result.exitCode !== 0) { outcome = stage === 'setup' ? 'setup-failed' : 'tests-failed'; return }
      }
      outcome = 'passed'
    } catch (e) { report.message = message(e) }
    finally {
      gitStream.flush()
      report.outcome = run.abort.signal.aborted ? 'cancelled' : outcome
      report.phase = 'cleaning'
      this.publish(entry)
      // Keep the full diagnostic result durably before removing its checkout.
      try {
        await this.persist()
        await this.cleanup(entry)
      } catch (e) { report.cleanup = 'failed'; report.cleanupMessage = message(e) }
      report.phase = 'finished'
      report.finishedAt = new Date().toISOString()
      this.publish(entry)
      this.active.delete(key)
      this.trimHistory(key)
      await this.persist().catch((e) => { report.cleanupMessage = `Could not save the report: ${message(e)}`; this.publish(entry) })
    }
  }

  private trimHistory(key: string): void {
    const repo = this.state.repositories[key]
    if (repo) repo.runs = repo.runs.filter((r, i) => i < PREVIEW_HISTORY_LIMIT || r.report.cleanup !== 'done')
  }

  private processMayBeAlive(pid?: number): boolean {
    if (!Number.isInteger(pid) || !pid || pid <= 0) return false
    try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true }
    catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH' }
  }

  private async cleanup(entry: StoredRun): Promise<void> {
    const report = entry.report
    if (!RUN_ID.test(report.runId) || entry.worktreePath !== this.worktreePath(report.runId)) throw new Error('Unrecognized preview worktree.')
    if (this.processMayBeAlive(entry.pid)) throw new Error('A process from this preview may still be running. Retry cleanup after it exits.')
    const parent = path.dirname(entry.worktreePath)
    try {
      if (await fs.realpath(parent) !== parent) throw new Error('The preview directory was replaced by a symbolic link.')
      const stat = await fs.lstat(entry.worktreePath).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null
        throw e
      })
      if (stat?.isSymbolicLink()) throw new Error('The preview worktree was replaced by a symbolic link.')
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    const actual = await this.git(entry.repoPath, ['rev-parse', '--git-common-dir'])
    if (actual.exitCode !== 0 || await fs.realpath(path.resolve(entry.repoPath, actual.out.trim())) !== entry.commonDir) throw new Error('The repository could not be verified for cleanup.')
    const listed = await this.git(entry.repoPath, ['worktree', 'list', '--porcelain'])
    if (listed.exitCode !== 0) throw new Error(listed.err || 'Could not list worktrees for cleanup.')
    if (parseWorktreePorcelain(listed.out).some((w) => path.resolve(w.path) === entry.worktreePath)) {
      const removed = await this.git(entry.repoPath, ['worktree', 'remove', '--force', '--', entry.worktreePath])
      if (removed.exitCode !== 0) throw new Error(removed.err || removed.out || 'Could not remove the preview worktree.')
    } else {
      // An interrupted worktree-add can leave files without a registration. This exact, journaled
      // run directory is ours; no caller-supplied directory is ever accepted here.
      await fs.rm(entry.worktreePath, { recursive: true, force: true })
    }
    await fs.rmdir(path.dirname(entry.worktreePath)).catch(() => {})
    report.cleanup = 'done'
    delete report.cleanupMessage
    delete entry.pid
  }

  private async recoverRepository(key: string, ownStart = false): Promise<void> {
    if (this.active.has(key) || (this.starting.has(key) && !ownStart)) return
    const previous = this.recovering.get(key)
    if (previous) return previous
    const flight = (async () => {
      for (const entry of this.state.repositories[key]?.runs ?? []) {
        if (entry.report.cleanup === 'done') continue
        try { await this.cleanup(entry) }
        catch (e) { entry.report.cleanup = 'failed'; entry.report.cleanupMessage = message(e) }
      }
      this.trimHistory(key)
      await this.persist()
    })()
    this.recovering.set(key, flight)
    try { await flight } finally { this.recovering.delete(key) }
  }

  async initialize(): Promise<void> {
    await this.load()
    for (const key of Object.keys(this.state.repositories)) await this.recoverRepository(key)
  }

  async get(projectId: string): Promise<PreviewReport | null> {
    const reports = await this.listReports(projectId)
    return reports[0] ?? null
  }
  async listReports(projectId: string): Promise<PreviewReport[]> {
    await this.load()
    const repo = await this.repository(projectId)
    return structuredClone((this.state.repositories[repo.key]?.runs ?? []).slice(0, PREVIEW_HISTORY_LIMIT).map((r) => r.report))
  }
  async cancel(projectId: string, runId: string): Promise<boolean> {
    const repo = await this.repository(projectId)
    const run = this.active.get(repo.key)
    if (!run || run.entry.report.runId !== runId) return false
    run.abort.abort()
    return true
  }
  async retryCleanup(projectId: string, runId: string): Promise<boolean> {
    await this.load()
    const repo = await this.repository(projectId)
    if (this.active.has(repo.key) || this.starting.has(repo.key)) return false
    const entry = this.state.repositories[repo.key]?.runs.find((r) => r.report.runId === runId)
    if (!entry) return false
    this.starting.add(repo.key)
    try {
      await this.recovering.get(repo.key)
      try { await this.cleanup(entry) }
      catch (e) { entry.report.cleanup = 'failed'; entry.report.cleanupMessage = message(e) }
      this.publish(entry)
      await this.persist()
      return entry.report.cleanup === 'done'
    } finally { this.starting.delete(repo.key) }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    for (const run of this.active.values()) run.abort.abort()
    await Promise.allSettled([...this.active.values()].map((run) => run.completion))
    await this.writeChain.catch(() => {})
  }
}
