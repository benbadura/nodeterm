import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IntegrationPreviewService } from './integration-preview-service'
import { testTmpDir } from './test-tmp'
import { gitEnv } from './git-env'
import type { PreviewOptions, PreviewReport } from '../shared/integration-preview'

const services: IntegrationPreviewService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.dispose()))
  vi.unstubAllEnvs()
})

async function fixture(check = 'console.log("ok")') {
  const directory = await fs.realpath(testTmpDir('integration-preview-'))
  // Apple's /usr/bin/git creates an xcrun cache in TMPDIR. Keep it inside this fixture.
  if (process.platform === 'darwin') vi.stubEnv('TMPDIR', directory)
  const repo = path.join(directory, 'repo')
  const userDataDir = path.join(directory, 'app')
  await fs.mkdir(repo)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'commit.gpgSign', 'false')
  await fs.writeFile(path.join(repo, 'check.cjs'), check)
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node check.cjs' } }))
  await fs.writeFile(path.join(repo, 'shared.txt'), 'base\n')
  git('add', '.')
  git('commit', '-m', 'base')
  const branch = async (name: string, file: string, contents: string, base = 'main') => {
    git('switch', '-c', name, base)
    await fs.writeFile(path.join(repo, file), contents)
    git('add', file)
    git('commit', '-m', name)
    git('switch', 'main')
  }
  const options: PreviewOptions = { baseRef: 'main', branches: ['one', 'two'], setupCommand: '', testCommand: 'node check.cjs', timeoutMinutes: 1 }
  const events: PreviewReport[] = []
  const service = () => {
    const s = new IntegrationPreviewService({
      userDataDir, targetInfo: (id) => id === 'ssh' ? { cwd: repo, ssh: {} } : id === 'missing' ? null : { cwd: repo },
      readSettings: async () => ({ shared: null, local: {} }),
      emit: (_id, report) => events.push(report)
    })
    services.push(s)
    return s
  }
  return { directory, repo, userDataDir, git, branch, options, events, service }
}

async function finished(service: IntegrationPreviewService): Promise<PreviewReport> {
  let report: PreviewReport | null = null
  await vi.waitFor(async () => {
    report = await service.get('project')
    expect(report?.phase).toBe('finished')
  }, { timeout: 10_000, interval: 30 })
  return report!
}

describe('integration preview with real Git repositories', () => {
  it('merges pinned commits, runs isolated commands and preserves dirty source worktrees and hooks', async () => {
    const f = await fixture('const fs = require("fs"); if (!fs.existsSync("one.txt") || !fs.existsSync("two.txt")) process.exit(1); console.log("combined passed")')
    await f.branch('one', 'one.txt', 'one')
    await f.branch('two', 'two.txt', 'two')
    const hook = path.join(f.repo, '.git', 'hooks', 'post-merge')
    await fs.writeFile(hook, '#!/bin/sh\necho hook > "' + path.join(f.repo, 'hook-ran') + '"\n', { mode: 0o755 })
    await fs.writeFile(path.join(f.repo, 'shared.txt'), 'dirty source\n')
    await fs.writeFile(path.join(f.repo, 'untracked.txt'), 'keep')
    const sourceWorktree = path.join(f.directory, 'agent-worktree')
    f.git('worktree', 'add', sourceWorktree, 'one')
    await fs.writeFile(path.join(sourceWorktree, 'one.txt'), 'dirty agent')
    const refsBefore = f.git('show-ref')
    const statusBefore = f.git('status', '--porcelain')
    const s = f.service()
    expect((await s.inspect('project')).suggestions[0].testCommand).toBe('npm run test')
    expect((await s.start('project', { ...f.options, setupCommand: 'node -e "require(\'fs\').writeFileSync(\'prepared.txt\', \'ready\')"' })).ok).toBe(true)
    const report = await finished(s)
    expect(report.outcome).toBe('passed')
    expect(report.cleanup).toBe('done')
    expect(report.logs.tests).toContain('combined passed')
    expect(report.mergedBranches).toEqual(['one', 'two'])
    expect(f.git('show-ref')).toBe(refsBefore)
    expect(f.git('status', '--porcelain')).toBe(statusBefore)
    expect(await fs.readFile(path.join(sourceWorktree, 'one.txt'), 'utf8')).toBe('dirty agent')
    expect(await fs.stat(path.join(f.repo, 'hook-ran')).catch(() => null)).toBeNull()
    expect(await fs.stat(path.join(f.repo, 'prepared.txt')).catch(() => null)).toBeNull()
    expect(f.git('worktree', 'list', '--porcelain')).not.toContain('integration-preview/runs')
    expect(await fs.readdir(path.join(f.userDataDir, 'integration-preview', 'runs'))).toEqual([])
    const reloaded = f.service()
    expect((await reloaded.listReports('project'))[0].runId).toBe(report.runId)
  })

  it('captures conflicts and stops before setup, tests or later branches', async () => {
    const f = await fixture()
    await f.branch('one', 'shared.txt', 'one\n')
    await f.branch('two', 'shared.txt', 'two\n')
    await f.branch('three', 'three.txt', 'three')
    const s = f.service()
    await s.start('project', { ...f.options, branches: ['one', 'two', 'three'] })
    const report = await finished(s)
    expect(report.outcome).toBe('conflict')
    expect(report.conflicts).toEqual(['shared.txt'])
    expect(report.currentBranch).toBe('two')
    expect(report.mergedBranches).toEqual(['one'])
    expect(report.testExitCode).toBeUndefined()
    expect(report.cleanup).toBe('done')
  })

  it('exposes a test failure caused by combining otherwise passing changes', async () => {
    const f = await fixture('const fs = require("fs"); if (fs.existsSync("one.txt") && fs.existsSync("two.txt")) { console.error("incompatible together"); process.exit(7); }')
    await f.branch('one', 'one.txt', 'one')
    await f.branch('two', 'two.txt', 'two')
    for (const ref of ['main', 'one', 'two']) {
      f.git('switch', ref)
      execFileSync(process.execPath, ['check.cjs'], { cwd: f.repo })
    }
    f.git('switch', 'main')
    const s = f.service()
    await s.start('project', f.options)
    const report = await finished(s)
    expect(report.outcome).toBe('tests-failed')
    expect(report.testExitCode).toBe(7)
    expect(report.logs.tests).toContain('incompatible together')
    expect(report.cleanup).toBe('done')
  })

  it('distinguishes setup failures and missing executables from test results', async () => {
    const f = await fixture()
    await f.branch('one', 'one.txt', 'one')
    await f.branch('two', 'two.txt', 'two')
    const s = f.service()
    await s.start('project', { ...f.options, setupCommand: 'node -e "process.exit(3)"' })
    expect(await finished(s)).toMatchObject({ outcome: 'setup-failed', setupExitCode: 3, cleanup: 'done' })
    expect((await s.get('project'))?.testExitCode).toBeUndefined()
    await s.start('project', { ...f.options, testCommand: 'nodeterm-command-that-does-not-exist' })
    expect(await finished(s)).toMatchObject({ outcome: 'tests-failed', cleanup: 'done' })
  })

  it('serializes starts across project aliases and cancels a process tree', async () => {
    const f = await fixture('setTimeout(() => {}, 30000)')
    await f.branch('one', 'one.txt', 'one')
    await f.branch('two', 'two.txt', 'two')
    const s = f.service()
    const results = await Promise.all([s.start('project', f.options), s.start('alias', f.options), s.start('third-alias', f.options)])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    await vi.waitFor(async () => expect((await s.get('project'))?.phase).toBe('testing'), { timeout: 5000 })
    const report = (await s.get('project'))!
    expect(await s.cancel('project', 'wrong-run')).toBe(false)
    expect(await s.cancel('project', report.runId)).toBe(true)
    expect(await finished(s)).toMatchObject({ outcome: 'cancelled', cleanup: 'done' })
  })

  it('pins a branch even if its ref moves while preparation is running', async () => {
    const f = await fixture('const fs = require("fs"); if (fs.existsSync("later.txt")) process.exit(1)')
    await f.branch('one', 'one.txt', 'one')
    await f.branch('two', 'two.txt', 'two')
    const original = f.git('rev-parse', 'one')
    const s = f.service()
    await s.start('project', { ...f.options, setupCommand: 'node -e "setTimeout(() => {}, 500)"' })
    await vi.waitFor(async () => expect((await s.get('project'))?.phase).toBe('preparing'), { timeout: 5000 })
    f.git('switch', 'one')
    await fs.writeFile(path.join(f.repo, 'later.txt'), 'later')
    f.git('add', 'later.txt'); f.git('commit', '-m', 'later'); f.git('switch', 'main')
    const report = await finished(s)
    expect(report.branches[0].sha).toBe(original)
    expect(report.outcome).toBe('passed')
  })

  it('refuses invalid refs, unavailable projects and missing branches before creating worktrees', async () => {
    const f = await fixture()
    await f.branch('one', 'one.txt', 'one')
    await f.branch('two', 'two.txt', 'two')
    const s = f.service()
    for (const branches of [['one', '--help'], ['one', 'gone']]) expect((await s.start('project', { ...f.options, branches })).ok).toBe(false)
    expect((await s.inspect('ssh')).available).toBe(false)
    expect((await s.start('missing', f.options)).ok).toBe(false)
    expect(f.git('worktree', 'list', '--porcelain')).not.toContain('integration-preview/runs')
  })

  it('reports unrelated histories as a Git error instead of claiming a file conflict', async () => {
    const f = await fixture()
    await f.branch('one', 'one.txt', 'one')
    f.git('switch', '--orphan', 'two')
    await fs.writeFile(path.join(f.repo, 'other.txt'), 'unrelated')
    f.git('add', 'other.txt'); f.git('commit', '-m', 'orphan'); f.git('switch', 'main')
    const s = f.service()
    await s.start('project', f.options)
    const report = await finished(s)
    expect(report.outcome).toBe('git-error')
    expect(report.conflicts).toEqual([])
    expect(report.testExitCode).toBeUndefined()
    expect(report.cleanup).toBe('done')
  })

  it('recovers interrupted runs, preserves their diagnostics and retains the last ten reports', async () => {
    const f = await fixture()
    await f.branch('one', 'one.txt', 'one')
    await f.branch('two', 'two.txt', 'two')
    const s = f.service()
    await s.start('project', f.options)
    const result = await finished(s)
    await s.dispose()
    const stateFile = path.join(f.userDataDir, 'integration-preview', 'state.json')
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    const repository = Object.values(state.repositories)[0] as { runs: Array<{ worktreePath: string; report: PreviewReport }> }
    const entry = repository.runs[0]
    await fs.mkdir(path.dirname(entry.worktreePath), { recursive: true })
    f.git('worktree', 'add', '--detach', entry.worktreePath, 'main')
    entry.report.phase = 'testing'
    entry.report.cleanup = 'pending'
    delete entry.report.outcome
    entry.report.logs.tests = 'diagnostics before crash'
    for (let i = 0; i < 11; i++) {
      const clone = structuredClone(entry)
      clone.report.runId = randomUUID()
      clone.worktreePath = path.join(f.userDataDir, 'integration-preview', 'runs', clone.report.runId, 'worktree')
      clone.report.phase = 'finished'
      clone.report.cleanup = 'done'
      repository.runs.push(clone)
    }
    await fs.writeFile(stateFile, JSON.stringify(state))
    const recovered = f.service()
    await recovered.initialize()
    const report = (await recovered.get('project'))!
    expect(report).toMatchObject({ runId: result.runId, outcome: 'interrupted', cleanup: 'done' })
    expect(report.logs.tests).toBe('diagnostics before crash')
    expect(await recovered.listReports('project')).toHaveLength(10)
    expect(f.git('worktree', 'list', '--porcelain')).not.toContain('integration-preview/runs')
  })

  it('reports a refused cleanup and never follows a replaced run directory into the source repo', async () => {
    const f = await fixture()
    await f.branch('one', 'one.txt', 'one')
    await f.branch('two', 'two.txt', 'two')
    const s = f.service()
    await s.start('project', f.options)
    await finished(s)
    await s.dispose()
    const stateFile = path.join(f.userDataDir, 'integration-preview', 'state.json')
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    const repository = Object.values(state.repositories)[0] as { runs: Array<{ worktreePath: string; report: PreviewReport }> }
    const entry = repository.runs[0]
    entry.report.cleanup = 'pending'
    await fs.mkdir(path.dirname(entry.worktreePath), { recursive: true })
    await fs.symlink(f.repo, entry.worktreePath, process.platform === 'win32' ? 'junction' : 'dir')
    await fs.writeFile(stateFile, JSON.stringify(state))
    const recovered = f.service()
    await recovered.initialize()
    expect((await recovered.get('project'))?.cleanup).toBe('failed')
    expect(await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8')).toBe('base\n')
    await fs.unlink(entry.worktreePath)
    expect(await recovered.retryCleanup('project', entry.report.runId)).toBe(true)
    expect((await recovered.get('project'))?.cleanup).toBe('done')
  })
})
