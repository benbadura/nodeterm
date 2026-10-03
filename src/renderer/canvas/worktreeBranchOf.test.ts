import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../state/workspace'
import { kanbanSessionsFrom, worktreeBranchOf } from './toKanbanSession'

const node = (id: string, over: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, type: 'terminal', position: { x: 0, y: 0 }, data: {}, ...over }) as CanvasNode

const group = (id: string, branch?: string, parentId?: string): CanvasNode => node(id, {
  type: 'group',
  ...(parentId ? { parentId } : {}),
  data: (branch ? { worktree: { repoPath: '/r', branch, baseRef: 'main', path: `/w/${branch}`, createdByApp: true } } : {}) as never
})

describe('worktreeBranchOf', () => {
  it('finds the nearest bound group, through unbound frames', () => {
    const nodes = [group('outer', 'feat/outer'), group('inner', undefined, 'outer'), node('t', { parentId: 'inner' })]
    const byId = new Map(nodes.map((n) => [n.id, n]))
    expect(worktreeBranchOf(byId.get('t')!, byId)).toBe('feat/outer')
  })

  it('the innermost bound group wins', () => {
    const nodes = [group('outer', 'feat/outer'), group('inner', 'feat/inner', 'outer'), node('t', { parentId: 'inner' })]
    const byId = new Map(nodes.map((n) => [n.id, n]))
    expect(worktreeBranchOf(byId.get('t')!, byId)).toBe('feat/inner')
  })

  it('a top-level node, or a hand-edited parent loop, has no branch', () => {
    const loop = [group('a', undefined, 'b'), group('b', undefined, 'a'), node('t', { parentId: 'a' })]
    const byId = new Map(loop.map((n) => [n.id, n]))
    expect(worktreeBranchOf(node('solo'), byId)).toBeUndefined()
    expect(worktreeBranchOf(byId.get('t')!, byId)).toBeUndefined()
  })
})

describe('kanbanSessionsFrom', () => {
  const nodes = [group('g', 'feat/x'), node('t', { parentId: 'g', data: { title: 'Agent' } as never })]

  it('cards in a worktree group carry its branch', () => {
    expect(kanbanSessionsFrom(nodes, { ssh: false })[0].worktreeBranch).toBe('feat/x')
  })

  it('on an SSH project no card carries a branch, so the face, the move and the modal agree', () => {
    expect(kanbanSessionsFrom(nodes, { ssh: true })[0]).not.toHaveProperty('worktreeBranch')
  })
})
