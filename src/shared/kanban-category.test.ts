import { describe, expect, it } from 'vitest'
import type { KanbanColumn, ProjectKanban } from './types'
import {
  CATEGORY_LABELS,
  KANBAN_COLUMN_CATEGORIES,
  boardProgress,
  categoryChangeImpact,
  categoryChangeMessage,
  columnCategory,
  defaultCompletionColumnId,
  isCompletedCategory
} from './kanban-category'

const col = (id: string, category?: unknown): KanbanColumn =>
  ({ id, title: id, color: '#fff', ...(category !== undefined ? { category } : {}) }) as KanbanColumn

const board = (): ProjectKanban => ({
  columns: [col('todo', 'unstarted'), col('doing', 'started'), col('done', 'done'), col('gone', 'closed')],
  assignments: [
    { nodeId: 'a', columnId: 'todo' },
    { nodeId: 'b', columnId: 'doing' },
    { nodeId: 'c', columnId: 'done' },
    { nodeId: 'd', columnId: 'gone' },
    { nodeId: 'dead', columnId: 'done' }
  ]
})

describe('columnCategory', () => {
  it('reads the four known values', () => {
    for (const c of KANBAN_COLUMN_CATEGORIES) expect(columnCategory(col('x', c))).toBe(c)
  })

  it('reads an absent, unknown or non-string value as ABSENT (never throws)', () => {
    expect(columnCategory(col('x'))).toBeUndefined()
    expect(columnCategory(col('x', 'blocked'))).toBeUndefined()
    expect(columnCategory(col('x', 'constructor'))).toBeUndefined()
    expect(columnCategory(col('x', 3))).toBeUndefined()
    expect(columnCategory(col('x', { evil: true }))).toBeUndefined()
    expect(columnCategory(undefined)).toBeUndefined()
  })

  it('labels every category', () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual([...KANBAN_COLUMN_CATEGORIES].sort())
  })

  it('done and closed are the completed categories', () => {
    expect(KANBAN_COLUMN_CATEGORIES.filter(isCompletedCategory)).toEqual(['done', 'closed'])
    expect(isCompletedCategory(undefined)).toBe(false)
  })
})

describe('boardProgress', () => {
  it('counts live cards in done+closed columns over every live card, Ungrouped included', () => {
    // e is unassigned (Ungrouped) — unfinished work; `dead` is not a live card.
    expect(boardProgress(board(), ['a', 'b', 'c', 'd', 'e'])).toEqual({ complete: 2, total: 5 })
  })

  it('is null when no column says what "complete" means', () => {
    const k: ProjectKanban = {
      columns: [col('x'), col('y', 'started')],
      assignments: [{ nodeId: 'a', columnId: 'x' }]
    }
    expect(boardProgress(k, ['a'])).toBeNull()
  })

  it('is null for an empty board (0/0 is not progress)', () => {
    expect(boardProgress(board(), [])).toBeNull()
  })

  it('a dangling assignment is Ungrouped, not complete', () => {
    const k: ProjectKanban = { ...board(), assignments: [{ nodeId: 'a', columnId: 'deleted' }] }
    expect(boardProgress(k, ['a'])).toEqual({ complete: 0, total: 1 })
  })
})

describe('defaultCompletionColumnId', () => {
  it('prefers the first done column', () => {
    expect(defaultCompletionColumnId([col('a', 'done'), col('b', 'closed'), col('c', 'done')])).toBe('a')
  })

  it('falls back to the first closed column', () => {
    expect(defaultCompletionColumnId([col('a', 'started'), col('b', 'closed')])).toBe('b')
  })

  it('falls back to the last column when nothing is categorized (the old default)', () => {
    expect(defaultCompletionColumnId([col('a'), col('b')])).toBe('b')
  })

  it('is undefined with no columns', () => {
    expect(defaultCompletionColumnId([])).toBeUndefined()
  })
})

describe('categoryChangeImpact', () => {
  it('names the live cards a change would re-mean', () => {
    expect(categoryChangeImpact(board(), 'doing', 'done', ['a', 'b', 'c', 'd'])).toEqual({
      cards: 1,
      from: 'started',
      to: 'done'
    })
  })

  it('is null for an empty column — nothing to re-mean', () => {
    expect(categoryChangeImpact(board(), 'doing', 'done', ['a', 'c'])).toBeNull()
  })

  it('is null when the category does not actually change', () => {
    expect(categoryChangeImpact(board(), 'doing', 'started', ['b'])).toBeNull()
  })

  it('treats an unknown stored value as absent, so clearing it is not a change', () => {
    const k: ProjectKanban = { columns: [col('x', 'blocked')], assignments: [{ nodeId: 'a', columnId: 'x' }] }
    expect(categoryChangeImpact(k, 'x', undefined, ['a'])).toBeNull()
    expect(categoryChangeImpact(k, 'x', 'done', ['a'])).toEqual({ cards: 1, from: undefined, to: 'done' })
  })

  it('is null for an unknown column', () => {
    expect(categoryChangeImpact(board(), 'nope', 'done', ['a'])).toBeNull()
  })
})

describe('categoryChangeMessage', () => {
  it('says the cards will count as finished when a column becomes done', () => {
    const m = categoryChangeMessage('Review', { cards: 1, from: 'started', to: 'done' }, false)
    expect(m).toContain('"Review"')
    expect(m).toContain('Started')
    expect(m).toContain('Done')
    expect(m).toContain('1 card will count as finished')
  })

  it('says they will no longer count when a done column stops being one', () => {
    expect(categoryChangeMessage('Done', { cards: 3, from: 'done', to: undefined }, false)).toContain(
      '3 cards will no longer count as finished'
    )
  })

  it('warns that the cards disappear from view when a column becomes closed and closed is hidden', () => {
    const hidden = categoryChangeMessage('Old', { cards: 2, from: undefined, to: 'closed' }, true)
    expect(hidden).toContain('hidden')
    const shown = categoryChangeMessage('Old', { cards: 2, from: undefined, to: 'closed' }, false)
    expect(shown).not.toContain('hidden')
  })

  it('still names the count for a change between two unfinished categories', () => {
    expect(categoryChangeMessage('Q', { cards: 4, from: 'unstarted', to: 'started' }, false)).toContain('4 cards')
  })
})
