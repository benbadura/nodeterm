// Ranks exist so two machines moving cards on the same git-shared board produce edits git can merge.
// This runs the real three-way merge (`git merge-file`) over the board block as it is written to
// `.nodeterm/project.json` (pretty-printed, 2-space JSON) rather than asserting a diff shape by hand.
//
// Scope, stated honestly: the FILE's own header also changes on every save (`rev`, `savedAt`), and
// two concurrent saves still disagree on `savedAt` — a pre-existing property of project.json that
// ranks do not touch. What is measured here is the board block the move itself writes.
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ProjectKanban } from '../shared/types'
import { columnOrder, placeAssignment } from '../shared/kanban-order'

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const dir = mkdtempSync(path.join(tmpdir(), 'kanban-merge-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const text = (k: ProjectKanban): string => `${JSON.stringify(k, null, 2)}\n`

/** Three-way merge; returns the merged board, or null when git reports a conflict. */
function merge(base: ProjectKanban, ours: ProjectKanban, theirs: ProjectKanban): ProjectKanban | null {
  const [b, o, t] = ['base', 'ours', 'theirs'].map((n) => path.join(dir, `${n}.json`))
  writeFileSync(b, text(base))
  writeFileSync(o, text(ours))
  writeFileSync(t, text(theirs))
  try {
    return JSON.parse(execFileSync('git', ['merge-file', '-p', o, b, t], { encoding: 'utf8' })) as ProjectKanban
  } catch {
    return null // non-zero exit = conflicts
  }
}

const changedLines = (a: ProjectKanban, b: ProjectKanban): number => {
  const x = text(a).split('\n')
  const y = text(b).split('\n')
  if (x.length !== y.length) return Number.POSITIVE_INFINITY
  return x.filter((line, i) => line !== y[i]).length
}

const move = (k: ProjectKanban, nodeId: string, columnId: string, anchor: Parameters<typeof placeAssignment>[3]): ProjectKanban => ({
  ...k,
  assignments: placeAssignment(k.assignments, nodeId, columnId, anchor)
})

/** A board as the field has it after a while: cards filed across three columns, all ranked
 *  (the first write into each column ranks it). */
function fieldBoard(): ProjectKanban {
  let k: ProjectKanban = {
    columns: [
      { id: 'todo', title: 'To Do', color: '#0a84ff' },
      { id: 'doing', title: 'In Progress', color: '#ffd60a' },
      { id: 'done', title: 'Done', color: '#32d74b' }
    ],
    assignments: []
  }
  for (const [id, col] of [
    ['t1', 'todo'], ['t2', 'todo'], ['t3', 'todo'], ['t4', 'todo'],
    ['p1', 'doing'], ['p2', 'doing'],
    ['d1', 'done'], ['d2', 'done'], ['d3', 'done']
  ] as const) {
    k = move(k, id, col, 'end')
  }
  return k
}

describe.skipIf(!hasGit)('rank strings under a real three-way merge', () => {
  it('a card filed at the top of Done, from before Done in the file, is a two-line change', () => {
    const base = fieldBoard()
    const moved = move(base, 'p1', 'done', 'top')
    expect(changedLines(base, moved)).toBe(2) // "columnId" and "rank" of the one entry
  })

  it('two machines filing DIFFERENT cards into Done merge cleanly, and both moves survive', () => {
    const base = fieldBoard()
    const ours = move(base, 't1', 'done', 'top')
    const theirs = move(base, 'p2', 'done', 'top')
    const merged = merge(base, ours, theirs)
    expect(merged).not.toBeNull()
    const done = columnOrder(merged!.assignments, 'done').map((a) => a.nodeId)
    expect(done).toContain('t1')
    expect(done).toContain('p2')
    expect(done.slice(2)).toEqual(['d1', 'd2', 'd3'])
    expect(merged!.assignments).toHaveLength(base.assignments.length)
  })

  // The contrast that is the reason for ranks. MEASURED, not assumed: filing two NON-adjacent cards
  // into one column merges cleanly even without ranks (git pairs the similar JSON blocks), but two
  // ADJACENT cards filed concurrently — the ordinary case of two agents finishing neighbouring
  // stations — make array-only placement edit the same stretch of the file on both sides, and git
  // stops at a conflict. With ranks each card changes in place, two lines apiece, and it merges.
  // (Both sides mint the same key there — the tie keeps array order, and the next write into the
  // column re-keys it; see @shared/kanban-order.)
  it('two ADJACENT cards filed concurrently: conflict without ranks, clean with them', () => {
    const arrayOnly = (k: ProjectKanban, nodeId: string, columnId: string): ProjectKanban => {
      const without = k.assignments
        .filter((a) => a.nodeId !== nodeId)
        .map(({ nodeId: n, columnId: c }) => ({ nodeId: n, columnId: c }))
      const at = without.findIndex((a) => a.columnId === columnId)
      const i = at === -1 ? without.length : at
      return { ...k, assignments: [...without.slice(0, i), { nodeId, columnId }, ...without.slice(i)] }
    }
    const unranked = (k: ProjectKanban): ProjectKanban => ({
      ...k,
      assignments: k.assignments.map(({ nodeId, columnId }) => ({ nodeId, columnId }))
    })
    const plain = unranked(fieldBoard())
    expect(merge(plain, arrayOnly(plain, 't1', 'done'), arrayOnly(plain, 't2', 'done'))).toBeNull()

    const base = fieldBoard()
    const merged = merge(base, move(base, 't1', 'done', 'top'), move(base, 't2', 'done', 'top'))
    expect(merged).not.toBeNull()
    expect(columnOrder(merged!.assignments, 'done').map((a) => a.nodeId)).toEqual(['t1', 't2', 'd1', 'd2', 'd3'])
  })

  it('a reorder in one column and a move in another merge cleanly', () => {
    const base = fieldBoard()
    const ours = move(base, 't4', 'todo', 'top') // reorder within To Do (moves a block)
    const theirs = move(base, 'd3', 'done', 'top') // reorder within Done
    const merged = merge(base, ours, theirs)
    expect(merged).not.toBeNull()
    expect(columnOrder(merged!.assignments, 'todo').map((a) => a.nodeId)).toEqual(['t4', 't1', 't2', 't3'])
    expect(columnOrder(merged!.assignments, 'done').map((a) => a.nodeId)).toEqual(['d3', 'd1', 'd2'])
  })
})
