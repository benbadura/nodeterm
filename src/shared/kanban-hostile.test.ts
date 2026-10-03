// Review round on #1004: shapes a hand-edited or git-merged `.nodeterm/project.json` can hold that
// the board must survive — a card's `assignees` that is not a list, and an assignment duplicated
// by a clean textual merge.
import { describe, expect, it } from 'vitest'
import type { KanbanCardMeta, ProjectKanban } from './types'
import { cardAssignees } from './kanban-labels'
import { columnOrder, placeAssignment } from './kanban-order'

describe('cardAssignees — the one tolerant reader of meta.assignees', () => {
  const meta = (assignees: unknown): KanbanCardMeta => ({ nodeId: 'n', assignees } as unknown as KanbanCardMeta)

  it('a non-list reads as nobody, never a throw', () => {
    for (const bad of [5, {}, true, 'enes', null, undefined]) expect(cardAssignees(meta(bad))).toEqual([])
    expect(cardAssignees(undefined)).toEqual([])
  })

  it('keeps only entries with a string name and colour', () => {
    const ok = { name: 'enes', color: '#0a84ff' }
    expect(cardAssignees(meta([ok, null, 3, { name: 7, color: '#fff' }, { name: 'sam' }, 'x']))).toEqual([ok])
  })
})

describe('an assignment duplicated by a git merge', () => {
  const dup = (): ProjectKanban['assignments'] => [
    { nodeId: 'X', columnId: 'c1', rank: 'a0' },
    { nodeId: 'Y', columnId: 'c2', rank: 'a0' },
    { nodeId: 'X', columnId: 'c1', rank: 'a1' }
  ]

  it('moving the card removes EVERY copy of it (as the pre-rank assignNode did)', () => {
    const out = placeAssignment(dup(), 'X', 'c2', 'top')
    expect(out.filter((a) => a.nodeId === 'X')).toHaveLength(1)
    expect(columnOrder(out, 'c1').map((a) => a.nodeId)).toEqual([])
    expect(columnOrder(out, 'c2').map((a) => a.nodeId)).toEqual(['X', 'Y'])
  })

  it('a column never lists one card twice (no duplicate React keys), first copy wins', () => {
    expect(columnOrder(dup(), 'c1').map((a) => a.nodeId)).toEqual(['X'])
  })
})
