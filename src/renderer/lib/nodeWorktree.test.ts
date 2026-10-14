import { describe, expect, it } from 'vitest'
import type { GroupWorktree, WorktreeEntry } from '@shared/worktree'
import { nodeWorktree } from './nodeWorktree'

type Node = Parameters<typeof nodeWorktree>[0]
const entry = (path: string, extra: Partial<WorktreeEntry> = {}): WorktreeEntry =>
  ({ path, branch: 'feature', head: 'abc', isBare: false, ...extra })
const binding = (path: string): GroupWorktree =>
  ({ path, repoPath: '/repo', branch: 'feature', baseRef: 'main', createdByApp: true })
const group = (id: string, path: string, parentId?: string): Node =>
  ({ id, parentId, type: 'group', data: { worktree: binding(path) } })
const terminal = (cwd?: string, parentId?: string): Node =>
  ({ id: 'terminal', type: 'terminal', parentId, data: { cwd } })
const known = [entry('/repo'), entry('/repo.worktrees/feature')]
const resolve = (node: Node, nodes: Node[] = [], entries = known) =>
  nodeWorktree(node, (id) => nodes.find((n) => n.id === id), entries, { cwd: '/repo' })

describe('nodeWorktree', () => {
  it('uses the actual node path even after it is dragged into a different worktree frame', () => {
    const frame = group('frame', '/repo.worktrees/feature')
    expect(resolve(terminal('/repo/src', frame.id), [frame])).toEqual({
      kind: 'worktree', path: '/repo', main: true, missing: false
    })
    expect(resolve(terminal('/repo.worktrees/feature/src'), [frame])).toEqual({
      kind: 'worktree', path: '/repo.worktrees/feature', main: false, missing: false
    })
    expect(resolve(terminal('/repo.worktrees/feature-other'))).toEqual({
      kind: 'unknown', path: '/repo.worktrees/feature-other'
    })
  })

  it('locates editor/diff files in the deepest checkout, including Windows paths', () => {
    for (const type of ['editor', 'diff', 'video']) {
      expect(resolve({ id: 'file', type, data: { cwd: '/repo', filePath: '/repo/wt/src/app.ts' } },
        [], [entry('/repo'), entry('/repo/wt')])).toMatchObject({ path: '/repo/wt', main: false })
    }
    expect(resolve(terminal('C:\\repo\\wt\\src\\'), [], [entry('C:/repo/'), entry('C:/repo/wt/')]))
      .toMatchObject({ kind: 'worktree', path: 'C:/repo/wt', main: false })
  })

  it('inherits context for pathless nodes and resolves bound frames before git data arrives', () => {
    const outer = group('outer', '/repo.worktrees/feature')
    const inner: Node = { id: 'inner', type: 'group', parentId: outer.id, data: {} }
    const sticky: Node = { id: 'note', type: 'sticky', parentId: inner.id, data: {} }
    expect(resolve(sticky, [outer, inner], [])).toMatchObject({ kind: 'worktree', path: outer.data.worktree!.path })
    expect(resolve(outer, [], [])).toMatchObject({ kind: 'worktree', path: outer.data.worktree!.path })
    expect(resolve({ id: 'browser', type: 'browser', data: {} })).toMatchObject({ path: '/repo', main: true })
    inner.parentId = inner.id
    expect(resolve(sticky, [inner])).toMatchObject({ path: '/repo', main: true })
  })

  it('does not confuse a non-repository directory, bare repository or missing facts with the main checkout', () => {
    expect(resolve(terminal('/elsewhere'))).toEqual({ kind: 'unknown', path: '/elsewhere' })
    expect(resolve(terminal('/repo'), [], [entry('/repo', { isBare: true })])).toEqual({ kind: 'unknown', path: '/repo' })
    expect(resolve(terminal('/repo'), [], [])).toEqual({ kind: 'unknown', path: '/repo' })
    expect(nodeWorktree(terminal(), () => undefined, [], {})).toEqual({ kind: 'unknown' })
  })

  it('does not attach local worktrees to SSH terminals, files or projects', () => {
    for (const data of [{ ssh: {} }, { sshRemoteTmux: true }, { sshFs: true }]) {
      expect(resolve({ ...terminal('/repo'), data: { cwd: '/repo', ...data } })).toEqual({ kind: 'remote' })
    }
    expect(nodeWorktree(terminal('/repo'), () => undefined, known, { cwd: '/repo', ssh: true }))
      .toEqual({ kind: 'remote' })
  })

  it('marks deleted worktrees from both the git listing and a stale group observation', () => {
    const frame = group('frame', '/repo.worktrees/feature')
    expect(resolve(terminal(frame.data.worktree!.path), [], [known[0], { ...known[1], prunable: true }]))
      .toMatchObject({ kind: 'worktree', missing: true })
    expect(nodeWorktree(terminal(frame.data.worktree!.path, frame.id), () => frame, known,
      { cwd: '/repo' }, [frame.id])).toMatchObject({ kind: 'worktree', missing: true })
  })
})
