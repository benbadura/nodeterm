import { execFileSync } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testTmpDir } from './test-tmp'
import { TaskReadinessService, registerReadiness } from './task-readiness'
import { measureReadiness } from './readiness-git'
import type { ReadinessReportInput, ReadinessResult } from '../shared/task-readiness'
import { IPC } from '../shared/ipc'
import type { CorePlatform } from './platform'

let cwd: string
let service: TaskReadinessService
const changed = vi.fn()
const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function value<T>(result: ReadinessResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}
function report(snapshotId: string): ReadinessReportInput {
  return { snapshotId, criteria: [{ id: 'c1', status: 'met', note: 'Checked expected behavior' }], tests: { status: 'recorded', items: [{ command: 'npm test', status: 'passed', exitCode: 0, summary: 'All tests passed' }] }, review: { status: 'recorded', items: [{ summary: 'Reviewed the change', outcome: 'passed', findings: [] }] }, preview: { status: 'not-applicable', reason: 'No UI change', items: [] } }
}
async function setupCriteria(): Promise<void> {
  value(await service.criteria('p', 'n', [{ id: 'c1', text: 'Expected behavior works' }], 0))
}
beforeEach(async () => {
  changed.mockClear()
  cwd = testTmpDir('nodeterm-readiness-')
  // Apple's /usr/bin/git shim writes an xcrun cache in its child TMPDIR. Keep it in the
  // test-owned, snapshot-excluded directory rather than leaking into the run-wide sandbox.
  const childTmp = path.join(cwd, '.nodeterm', 'test-tmp')
  await fs.mkdir(childTmp, { recursive: true })
  vi.stubEnv('TMPDIR', childTmp)
  git('init', '-q')
  git('config', 'user.email', 'readiness@example.com')
  git('config', 'user.name', 'Readiness Test')
  await fs.writeFile(path.join(cwd, 'code.txt'), 'initial\n')
  await fs.writeFile(path.join(cwd, '.gitignore'), 'generated/\n')
  git('add', '.')
  git('commit', '-qm', 'Initial code')
  service = new TaskReadinessService((p, n) => p === 'p' && n === 'n' ? { projectRoot: cwd, cwd, author: 'codex' } : undefined, changed)
})
afterEach(() => vi.unstubAllEnvs())

describe('readiness snapshots and durable evidence', { timeout: 15000 }, () => {
  it('is current after saving, survives restart, and ignores its own data and comments', async () => {
    await setupCriteria()
    const snapshot = value(await service.capture('p', 'n'))
    value(await service.report('p', 'n', report(snapshot.id), 'agent'))
    await fs.writeFile(path.join(cwd, '.nodeterm', 'board-log.jsonl'), '{"comment":"updated"}\n')
    await fs.mkdir(path.join(cwd, 'generated'))
    await fs.writeFile(path.join(cwd, 'generated', 'output'), 'ignored')
    service = new TaskReadinessService(() => ({ projectRoot: cwd, cwd, author: 'codex' }))
    const view = value(await service.check('p', 'n'))
    expect(view.freshness).toBe('current')
    expect(view.reports[0]).toMatchObject({ source: 'agent', author: 'codex', snapshot })
    expect(view.reports[0].snapshot.files).toEqual([])
  })

  it('detects repeated content edits to the same already dirty file, not only file names', async () => {
    await setupCriteria()
    await fs.writeFile(path.join(cwd, 'code.txt'), 'first change\n')
    const snapshot = value(await service.capture('p', 'n'))
    value(await service.report('p', 'n', report(snapshot.id)))
    expect(value(await service.check('p', 'n')).freshness).toBe('current')
    await fs.writeFile(path.join(cwd, 'code.txt'), 'other change\n')
    expect(value(await service.check('p', 'n')).freshness).toBe('stale')
    expect(value(await service.read('p', 'n')).reports[0].snapshot).toEqual(snapshot)
  })

  it('keeps evidence on its pre-check snapshot when the code changes before submission', async () => {
    await setupCriteria()
    const snapshot = value(await service.capture('p', 'n'))
    await fs.writeFile(path.join(cwd, 'code.txt'), 'changed during checks\n')
    value(await service.report('p', 'n', report(snapshot.id)))
    const view = value(await service.check('p', 'n'))
    expect(view.freshness).toBe('stale')
    expect(view.reports[0].snapshot.fingerprint).toBe(snapshot.fingerprint)
  })

  it('detects staged changes and commits and uses the original base for changed files', async () => {
    await setupCriteria()
    const base = git('rev-parse', 'HEAD')
    const snapshot = value(await service.capture('p', 'n'))
    value(await service.report('p', 'n', report(snapshot.id)))
    await fs.writeFile(path.join(cwd, 'code.txt'), 'committed change\n')
    git('add', 'code.txt')
    expect(value(await service.check('p', 'n')).freshness).toBe('stale')
    git('commit', '-qm', 'Task change')
    const next = value(await service.capture('p', 'n'))
    expect(next.baseCommit).toBe(base)
    expect(next.files).toEqual(['code.txt'])
    value(await service.report('p', 'n', report(next.id)))
    expect(value(await service.check('p', 'n')).freshness).toBe('current')
    expect(value(await service.read('p', 'n')).total).toBe(2)
  })

  it('refuses Git flags that can hide working file modifications', async () => {
    await setupCriteria()
    const snapshot = value(await service.capture('p', 'n'))
    value(await service.report('p', 'n', report(snapshot.id)))
    git('update-index', '--assume-unchanged', 'code.txt')
    await fs.writeFile(path.join(cwd, 'code.txt'), 'hidden change')
    expect(value(await service.check('p', 'n')).freshness).toBe('unknown')
    expect((await service.capture('p', 'n')).ok).toBe(false)
  })

  it('hashes untracked binary files and detects deletion and renames', async () => {
    await setupCriteria()
    await fs.writeFile(path.join(cwd, 'new file.bin'), Buffer.from([0, 1, 2, 255]))
    const snapshot = value(await service.capture('p', 'n'))
    expect(snapshot.files).toContain('new file.bin')
    value(await service.report('p', 'n', report(snapshot.id)))
    await fs.writeFile(path.join(cwd, 'new file.bin'), Buffer.from([0, 2, 2, 255]))
    expect(value(await service.check('p', 'n')).freshness).toBe('stale')
    await fs.rename(path.join(cwd, 'code.txt'), path.join(cwd, 'renamed.txt'))
    const next = value(await service.capture('p', 'n'))
    expect(next.files).toEqual(['code.txt', 'new file.bin', 'renamed.txt'])
  })

  it('preserves historical requirements and rejects a result for an edited checklist', async () => {
    await setupCriteria()
    const snapshot = value(await service.capture('p', 'n'))
    value(await service.report('p', 'n', report(snapshot.id)))
    const pending = value(await service.capture('p', 'n'))
    value(await service.criteria('p', 'n', [{ id: 'c1', text: 'Updated requirements' }], 1))
    expect(value(await service.check('p', 'n')).freshness).toBe('stale')
    expect(value(await service.read('p', 'n')).reports[0].acceptance[0].text).toBe('Expected behavior works')
    expect(await service.report('p', 'n', report(pending.id))).toMatchObject({ ok: false, error: expect.stringContaining('criteria changed') })
  })

  it('serializes competing checklist updates and refuses stale revisions', async () => {
    await setupCriteria()
    const results = await Promise.all([
      service.criteria('p', 'n', [{ id: 'a', text: 'First edit' }], 1),
      service.criteria('p', 'n', [{ id: 'b', text: 'Second edit' }], 1)
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(value(await service.read('p', 'n')).criteriaRevision).toBe(2)
  })

  it('does not overwrite a corrupt sidecar', async () => {
    await setupCriteria()
    const file = path.join(cwd, '.nodeterm', 'readiness', 'n.json')
    await fs.writeFile(file, '{broken')
    expect((await service.capture('p', 'n')).ok).toBe(false)
    expect(await fs.readFile(file, 'utf8')).toBe('{broken')
  })

  it('reports unknown when a worktree is removed instead of displaying current', async () => {
    const wt = path.join(testTmpDir('nodeterm-readiness-wt-'), 'checkout')
    git('worktree', 'add', '-qb', 'readiness-task', wt)
    service = new TaskReadinessService(() => ({ projectRoot: cwd, cwd: wt, author: 'agent' }))
    await setupCriteria()
    const snapshot = value(await service.capture('p', 'n'))
    value(await service.report('p', 'n', report(snapshot.id)))
    await fs.writeFile(path.join(cwd, 'code.txt'), 'unrelated main checkout edit')
    expect(value(await service.check('p', 'n')).freshness).toBe('current')
    git('worktree', 'remove', wt)
    expect(value(await service.check('p', 'n')).freshness).toBe('unknown')
  })

  it('does not follow a readiness directory symlink outside the project', async () => {
    const outside = testTmpDir('nodeterm-readiness-outside-')
    await fs.mkdir(path.join(cwd, '.nodeterm'), { recursive: true })
    await fs.symlink(outside, path.join(cwd, '.nodeterm', 'readiness'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await service.capture('p', 'n')).ok).toBe(false)
    expect(await fs.readdir(outside)).toEqual([])
  })

  it('records a baseline before launch, including for a node not yet saved', async () => {
    const baseline = git('rev-parse', 'HEAD')
    await service.rememberBaseline('n', cwd)
    await fs.writeFile(path.join(cwd, 'code.txt'), 'task output')
    git('add', 'code.txt'); git('commit', '-qm', 'Task output')
    await setupCriteria()
    const snapshot = value(await service.capture('p', 'n'))
    expect(snapshot.baseCommit).toBe(baseline)
    expect(snapshot.files).toEqual(['code.txt'])
  })

  it('pages immutable report history without silently removing earlier reports', async () => {
    await setupCriteria()
    // Reports all deliberately reference independent captures of the same measured code.
    for (let i = 0; i < 21; i++) {
      const snapshot = value(await service.capture('p', 'n'))
      value(await service.report('p', 'n', report(snapshot.id)))
    }
    expect(value(await service.read('p', 'n')).reports).toHaveLength(20)
    expect(value(await service.read('p', 'n', 20)).reports).toHaveLength(1)
    expect(value(await service.read('p', 'n')).total).toBe(21)
  }, 30000)
})

describe('readiness boundaries and CLI', { timeout: 15000 }, () => {
  it('marks a non-Git directory unsupported before presenting a report editor', async () => {
    const childTmp = process.env.TMPDIR!
    vi.stubEnv('TMPDIR', process.env.NODETERM_TEST_TMPDIR!)
    const empty = testTmpDir('nodeterm-readiness-nongit-')
    vi.stubEnv('TMPDIR', childTmp)
    service = new TaskReadinessService(() => ({ projectRoot: empty, cwd: empty, author: 'agent' }))
    expect(value(await service.check('p', 'n'))).toMatchObject({ freshness: 'none', unsupported: true })
    expect((await service.capture('p', 'n')).ok).toBe(false)
  })

  it('writes only the caller’s own card and refuses an unverified caller', async () => {
    expect(await service.control('p', 'n', { action: 'snapshot', node: 'other' }, true)).toMatchObject({ ok: false })
    expect(await service.control('p', 'n', { action: 'snapshot' }, false)).toMatchObject({ ok: false })
    expect(await service.capture('other-project', 'n')).toMatchObject({ ok: false })
    expect(await service.capture('p', '../n')).toMatchObject({ ok: false })
  })

  it('accepts a structured agent report without executing its command', async () => {
    await setupCriteria()
    const reply = await service.control('p', 'n', { action: 'snapshot' }, true)
    expect(reply.ok).toBe(true)
    const snapshot = JSON.parse(reply.message)
    const input = report(snapshot.id)
    input.tests.items[0].command = 'touch this-command-must-never-run'
    const file = path.join(cwd, '.nodeterm', 'report-input.json')
    await fs.writeFile(file, JSON.stringify(input))
    expect(await service.control('p', 'n', { action: 'report', file }, true)).toMatchObject({ ok: true })
    expect(value(await service.check('p', 'n')).freshness).toBe('current')
    expect(value(await service.read('p', 'n')).reports[0].source).toBe('agent')
    expect(await fs.stat(path.join(cwd, 'this-command-must-never-run')).catch(() => null)).toBeNull()
  })

  it('rejects relay IPC even when it supplies a valid node id', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    registerReadiness({ handleWithSender: (channel: string, fn: (...args: any[]) => unknown) => { handlers.set(channel, fn) }, isLocalClient: (id: number) => id === 1 } as unknown as CorePlatform, service)
    expect(await handlers.get(IPC.readinessCapture)!(2, 'p', 'n')).toMatchObject({ ok: false, unsupported: true })
    expect(await handlers.get(IPC.readinessRead)!(1, 'p', 'n')).toMatchObject({ ok: true })
  })

  it('refuses unfinished merge state rather than assuming it was verified', async () => {
    const branch = git('symbolic-ref', '--short', 'HEAD')
    git('checkout', '-qb', 'conflicting')
    await fs.writeFile(path.join(cwd, 'code.txt'), 'theirs\n')
    git('commit', '-qam', 'Theirs')
    git('checkout', '-q', branch)
    await fs.writeFile(path.join(cwd, 'code.txt'), 'ours\n')
    git('commit', '-qam', 'Ours')
    expect(() => git('merge', 'conflicting')).toThrow()
    await expect(measureReadiness(cwd)).rejects.toThrow('merge conflicts')
  })
})
