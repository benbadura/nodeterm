import { describe, expect, it } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import { boardLogEvents } from './boardLogDiff'

const col = (id: string, title: string) => ({ id, title, color: '#111' })
const board = (columns: ProjectKanban['columns'], assignments: ProjectKanban['assignments']): ProjectKanban => ({
  columns,
  assignments
})
// Every real node is relevant by default; a pruned node returns '' (see prune test).
const title = (id: string) => `card-${id}`

describe('boardLogEvents', () => {
  it('assignment added → card-moved from Ungrouped to the new column', () => {
    const cols = [col('c1', 'To Do')]
    const prev = board(cols, [])
    const next = board(cols, [{ nodeId: 'n1', columnId: 'c1' }])
    expect(boardLogEvents(prev, next, title)).toEqual([
      { nodeId: 'n1', event: { type: 'card-moved', from: 'Ungrouped', to: 'To Do' } }
    ])
  })

  it('assignment columnId changed → card-moved from old to new column name', () => {
    const cols = [col('c1', 'To Do'), col('c2', 'Done')]
    const prev = board(cols, [{ nodeId: 'n1', columnId: 'c1' }])
    const next = board(cols, [{ nodeId: 'n1', columnId: 'c2' }])
    expect(boardLogEvents(prev, next, title)).toEqual([
      { nodeId: 'n1', event: { type: 'card-moved', from: 'To Do', to: 'Done' } }
    ])
  })

  it('assignment removed while node still relevant → card-moved to Ungrouped', () => {
    const cols = [col('c1', 'To Do')]
    const prev = board(cols, [{ nodeId: 'n1', columnId: 'c1' }])
    const next = board(cols, [])
    expect(boardLogEvents(prev, next, title)).toEqual([
      { nodeId: 'n1', event: { type: 'card-moved', from: 'To Do', to: 'Ungrouped' } }
    ])
  })

  it('assignment removed by prune (node gone) → no move', () => {
    const cols = [col('c1', 'To Do')]
    const prev = board(cols, [{ nodeId: 'gone', columnId: 'c1' }])
    const next = board(cols, [])
    // cardTitle('gone') === '' → the node no longer exists (pruneAssignments), so no move noise.
    expect(boardLogEvents(prev, next, (id) => (id === 'gone' ? '' : `card-${id}`))).toEqual([])
  })

  it('column added → column-added {title}', () => {
    const prev = board([col('c1', 'To Do')], [])
    const next = board([col('c1', 'To Do'), col('c2', 'Done')], [])
    expect(boardLogEvents(prev, next, title)).toEqual([{ event: { type: 'column-added', title: 'Done' } }])
  })

  it('column title changed → column-renamed {from,to}', () => {
    const prev = board([col('c1', 'To Do')], [])
    const next = board([col('c1', 'Doing')], [])
    expect(boardLogEvents(prev, next, title)).toEqual([{ event: { type: 'column-renamed', from: 'To Do', to: 'Doing' } }])
  })

  it('column deleted → only column-deleted {title}; per-card moves to Ungrouped are suppressed', () => {
    const prev = board([col('c1', 'To Do'), col('c2', 'Done')], [
      { nodeId: 'n1', columnId: 'c2' },
      { nodeId: 'n2', columnId: 'c2' }
    ])
    // deleteColumn('c2') removes the column AND both assignments.
    const next = board([col('c1', 'To Do')], [])
    expect(boardLogEvents(prev, next, title)).toEqual([{ event: { type: 'column-deleted', title: 'Done' } }])
  })

  it('pure column reorder → []', () => {
    const prev = board([col('c1', 'To Do'), col('c2', 'Done')], [])
    const next = board([col('c2', 'Done'), col('c1', 'To Do')], [])
    expect(boardLogEvents(prev, next, title)).toEqual([])
  })

  it('intra-column card order change → []', () => {
    const cols = [col('c1', 'To Do')]
    const prev = board(cols, [
      { nodeId: 'a', columnId: 'c1' },
      { nodeId: 'b', columnId: 'c1' }
    ])
    const next = board(cols, [
      { nodeId: 'b', columnId: 'c1' },
      { nodeId: 'a', columnId: 'c1' }
    ])
    expect(boardLogEvents(prev, next, title)).toEqual([])
  })

  it('no change at all → []', () => {
    const cols = [col('c1', 'To Do')]
    const b = board(cols, [{ nodeId: 'a', columnId: 'c1' }])
    expect(boardLogEvents(b, b, title)).toEqual([])
  })

  it('dangling prev assignment (column already missing) resolves from-name to Ungrouped', () => {
    // Assignment points at a column that exists in neither board (a leftover from elsewhere);
    // moving it into a real column reads as coming from Ungrouped.
    const prev = board([col('c1', 'To Do')], [{ nodeId: 'n1', columnId: 'dead' }])
    const next = board([col('c1', 'To Do')], [{ nodeId: 'n1', columnId: 'c1' }])
    expect(boardLogEvents(prev, next, title)).toEqual([
      { nodeId: 'n1', event: { type: 'card-moved', from: 'Ungrouped', to: 'To Do' } }
    ])
  })
})

describe('card meta events', () => {
  const enes = { name: 'enes', color: '#0a84ff' }
  const mehmet = { name: 'mehmet', color: '#bf5af2' }
  const titles = (id: string) => (id === 'dead' ? '' : 'card ' + id)
  const base = () => board([col('c1', 'To Do')], [])
  it('assigning and unassigning members emit per-person events', () => {
    const next = { ...base(), meta: [{ nodeId: 'n1', assignees: [enes, mehmet] }] }
    expect(boardLogEvents(base(), next, titles)).toEqual([
      { nodeId: 'n1', event: { type: 'member-assigned', to: 'enes' } },
      { nodeId: 'n1', event: { type: 'member-assigned', to: 'mehmet' } }
    ])
    const back = boardLogEvents(next, { ...base(), meta: [{ nodeId: 'n1', assignees: [enes] }] }, titles)
    expect(back).toEqual([{ nodeId: 'n1', event: { type: 'member-unassigned', to: 'mehmet' } }])
  })
  it('due set / changed / cleared emit due events with ISO stamps', () => {
    const at = Date.UTC(2026, 6, 21, 10, 0, 0)
    const withDue = { ...base(), meta: [{ nodeId: 'n2', dueAt: at }] }
    expect(boardLogEvents(base(), withDue, titles)).toEqual([
      { nodeId: 'n2', event: { type: 'due-set', to: new Date(at).toISOString() } }
    ])
    expect(boardLogEvents(withDue, base(), titles)).toEqual([
      { nodeId: 'n2', event: { type: 'due-cleared' } }
    ])
  })
  it('meta of a dead node (prune) emits nothing; unchanged meta emits nothing', () => {
    const withMeta = { ...base(), meta: [{ nodeId: 'dead', assignees: [enes], dueAt: 5 }] }
    expect(boardLogEvents(withMeta, base(), titles)).toEqual([])
    expect(boardLogEvents(withMeta, withMeta, titles)).toEqual([])
  })
})

describe('priority events', () => {
  const titles = (id: string) => 'card ' + id
  const base = () => board([col('c1', 'To Do')], [])
  it('set / changed / cleared', () => {
    const hi = { ...base(), meta: [{ nodeId: 'n1', priority: 'high' as const }] }
    expect(boardLogEvents(base(), hi, titles)).toEqual([
      { nodeId: 'n1', event: { type: 'priority-set', to: 'high' } }
    ])
    const ur = { ...base(), meta: [{ nodeId: 'n1', priority: 'urgent' as const }] }
    expect(boardLogEvents(hi, ur, titles)).toEqual([
      { nodeId: 'n1', event: { type: 'priority-set', to: 'urgent' } }
    ])
    expect(boardLogEvents(ur, base(), titles)).toEqual([
      { nodeId: 'n1', event: { type: 'priority-cleared' } }
    ])
  })
})

// The UI's board-change funnel runs on every commit; a card's assignees come from a hand-editable
// file and may not be a list at all.
describe('boardLogEvents — hostile meta.assignees', () => {
  it('never throws, and reads a non-list as nobody', () => {
    const cols = [col('a', 'A')]
    for (const bad of [5, {}, true, 'enes']) {
      const prev = { ...board(cols, []), meta: [{ nodeId: 'n', assignees: bad }] } as unknown as ProjectKanban
      const next = {
        ...board(cols, []),
        meta: [{ nodeId: 'n', assignees: [{ name: 'sam', color: '#fff' }] }]
      } as ProjectKanban
      expect(boardLogEvents(prev, next, title)).toEqual([{ nodeId: 'n', event: { type: 'member-assigned', to: 'sam' } }])
    }
  })
})
