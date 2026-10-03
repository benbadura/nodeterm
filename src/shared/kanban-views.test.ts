import { describe, expect, it } from 'vitest'
import type { ProjectKanban } from './types'
import {
  KANBAN_VIEWS_MAX,
  VIEW_NAME_MAX,
  deleteView,
  renameView,
  sameViewQuery,
  sanitizeViews,
  saveView,
  updateView,
  viewQuery
} from './kanban-views'

const board = (): ProjectKanban => ({ columns: [{ id: 'c', title: 'C', color: '#fff' }], assignments: [] })

describe('viewQuery — what a view may carry', () => {
  it('captures source, labels, assignees and columns — and nothing else', () => {
    const q = viewQuery({
      source: 'sessions',
      labels: ['local:l1', 'github:bug'],
      assignees: ['enes'],
      columns: ['c'],
      // The live-state chips reach the builder in real life (it is fed the board's filter state);
      // they must not come out the other side.
      statusChips: ['running']
    } as Parameters<typeof viewQuery>[0])
    expect(q).toEqual({ source: 'sessions', labels: ['local:l1', 'github:bug'], assignees: ['enes'], columns: ['c'] })
    expect(JSON.stringify(q)).not.toContain('running')
  })

  it('omits what is at its default (an empty view is an empty query)', () => {
    expect(viewQuery({ source: 'all', labels: [], assignees: [], columns: [] })).toEqual({})
  })
})

describe('sameViewQuery', () => {
  it('ignores list order and absent-vs-empty', () => {
    expect(sameViewQuery({ labels: ['a', 'b'] }, { labels: ['b', 'a'], assignees: [] })).toBe(true)
    expect(sameViewQuery({ source: 'all' }, {})).toBe(true)
    expect(sameViewQuery({ labels: ['a'] }, { labels: ['b'] })).toBe(false)
    expect(sameViewQuery({ source: 'github' }, {})).toBe(false)
  })
})

describe('transforms', () => {
  it('save → rename → update → delete', () => {
    const saved = saveView(board(), 'Mine', { assignees: ['enes'] })
    expect(saved.k.views).toEqual([{ id: saved.id, name: 'Mine', query: { assignees: ['enes'] } }])
    const id = saved.id!
    const renamed = renameView(saved.k, id, 'Only mine')
    expect(renamed.views?.[0].name).toBe('Only mine')
    const updated = updateView(renamed, id, { source: 'sessions' })
    expect(updated.views?.[0].query).toEqual({ source: 'sessions' })
    const deleted = deleteView(updated, id)
    expect('views' in deleted).toBe(false)
  })

  it('trims and bounds names; an empty name is refused (the board is unchanged)', () => {
    const k = board()
    expect(saveView(k, '   ', {}).k).toBe(k)
    expect(saveView(k, 'x'.repeat(200), {}).k.views?.[0].name).toHaveLength(VIEW_NAME_MAX)
    expect(saveView(k, '  Mine \n', {}).k.views?.[0].name).toBe('Mine')
  })

  it('unknown ids are no-ops returning the same board', () => {
    const k = saveView(board(), 'A', {}).k
    expect(renameView(k, 'nope', 'B')).toBe(k)
    expect(updateView(k, 'nope', {})).toBe(k)
    expect(deleteView(k, 'nope')).toBe(k)
  })

  it('refuses a view past the cap rather than growing the shared file without bound', () => {
    let k = board()
    for (let i = 0; i < KANBAN_VIEWS_MAX; i++) k = saveView(k, `v${i}`, {}).k
    const over = saveView(k, 'one more', {})
    expect(over.k).toBe(k)
    expect(over.id).toBeNull()
  })
})

describe('sanitizeViews — hostile, git-shared input', () => {
  it('returns a clean list BY IDENTITY', () => {
    const views = [{ id: 'kview-1', name: 'A', query: { source: 'sessions' as const } }]
    expect(sanitizeViews(views)).toBe(views)
  })

  it('absent stays absent; a non-array is dropped', () => {
    expect(sanitizeViews(undefined)).toBeUndefined()
    expect(sanitizeViews('nope')).toBeUndefined()
    expect(sanitizeViews({})).toBeUndefined()
  })

  it('drops entries a renderer would trip on, never throwing', () => {
    const out = sanitizeViews([
      null,
      7,
      { id: 3, name: 'x', query: {} },
      { id: 'a', name: { x: 1 }, query: {} },
      { id: 'b', name: '', query: {} },
      { id: 'c', name: 'ok', query: 'nope' },
      { id: 'd', name: 'kept', query: {} }
    ])
    expect(out).toEqual([{ id: 'd', name: 'kept', query: {} }])
  })

  it('repairs a query field-by-field: unknown source dropped, non-string list items dropped', () => {
    const out = sanitizeViews([
      { id: 'a', name: 'A', query: { source: 'everything', labels: ['ok', 3, null], assignees: 'enes', columns: ['c'] } }
    ])
    expect(out).toEqual([{ id: 'a', name: 'A', query: { labels: ['ok'], columns: ['c'] } }])
  })

  it('keeps query fields it does not know (a newer build’s filter survives an older save)', () => {
    const out = sanitizeViews([{ id: 'a', name: 'A', query: { priority: ['high'] } }])
    expect(out?.[0].query).toEqual({ priority: ['high'] })
  })

  it('drops a duplicate id and caps the list', () => {
    const many = Array.from({ length: KANBAN_VIEWS_MAX + 5 }, (_, i) => ({ id: `v${i}`, name: `V${i}`, query: {} }))
    expect(sanitizeViews([...many.slice(0, 1), ...many])?.length).toBe(KANBAN_VIEWS_MAX)
  })
})
