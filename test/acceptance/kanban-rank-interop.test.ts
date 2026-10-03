import { describe, expect, it } from 'vitest'
import type { ProjectKanban } from '../../src/shared/types'
import { columnOrder } from '../../src/shared/kanban-order'
import { AT_COLUMN_END, assignNode, deleteColumn, pruneAssignments } from '../../src/renderer/lib/kanban'
import { setProjectCardColumn } from '../../src/core/project-kanban-write'

/**
 * The old-build contract across every writer at once: this build's `assignNode` (renderer), the
 * relay's `setProjectCardColumn` (core, raw file text), a build that predates ranks (its
 * `assignNode`, reproduced below — it rebuilds the moved entry WITHOUT `rank`), and the prunes and
 * column deletions in between. After any interleaving, every column's array order must equal the
 * order this build shows — so a build that ignores `rank` shows the same board.
 *
 * Cross-layer (shared + renderer + core), which production layering forbids inside src/.
 */

/** A pre-rank build's assignNode, verbatim in behaviour: append at the end when unanchored. */
function preRankAssign(k: ProjectKanban, nodeId: string, columnId: string | null, before: string | null): ProjectKanban {
  if (nodeId === before) return k
  if (columnId === null) return { ...k, assignments: k.assignments.filter((a) => a.nodeId !== nodeId) }
  if (!k.columns.some((c) => c.id === columnId)) return k
  const moved = { nodeId, columnId }
  const without = k.assignments.filter((a) => a.nodeId !== nodeId)
  const b = before ? without.find((a) => a.nodeId === before && a.columnId === columnId) : undefined
  const idx = b ? without.indexOf(b) : -1
  const at = idx === -1 ? without.length : idx
  return { ...k, assignments: [...without.slice(0, at), moved, ...without.slice(at)] }
}

const arrayOrder = (k: ProjectKanban, c: string): string[] =>
  k.assignments.filter((a) => a && a.columnId === c).map((a) => a.nodeId)
const shownOrder = (k: ProjectKanban, c: string): string[] => columnOrder(k.assignments, c).map((a) => a.nodeId)

describe('rank order vs array order across old, new and relay writers', () => {
  it('holds after every step of a seeded random interleaving', () => {
    let seed = 12345
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`)
    let mismatches = 0
    for (let run = 0; run < 200; run++) {
      let k: ProjectKanban = { columns: ['c1', 'c2', 'c3'].map((id) => ({ id, title: id, color: '' })), assignments: [] }
      for (let step = 0; step < 60; step++) {
        const op = rnd(10)
        const node = ids[rnd(ids.length)]
        const col = k.columns.length ? k.columns[rnd(k.columns.length)].id : null
        const inCol = col ? arrayOrder(k, col) : []
        const before = inCol.length && rnd(2) ? inCol[rnd(inCol.length)] : null
        if (op < 4) k = assignNode(k, node, col, rnd(3) === 0 ? AT_COLUMN_END : before)
        else if (op < 6) k = preRankAssign(k, node, col, before)
        else if (op < 8) {
          const out = setProjectCardColumn(JSON.stringify({ version: 1, rev: 1, nodes: [], kanban: k }), node, col, new Date())
          if (out) k = JSON.parse(out).kanban
        } else if (op === 8) k = pruneAssignments(k, ids.filter(() => rnd(8) !== 0))
        else if (k.columns.length > 1 && rnd(4) === 0) {
          k = deleteColumn(k, k.columns[rnd(k.columns.length)].id)
          k = { ...k, columns: [...k.columns, { id: `c${run}-${step}`, title: 'x', color: '' }] }
        }
        for (const c of k.columns) if (arrayOrder(k, c.id).join() !== shownOrder(k, c.id).join()) mismatches++
      }
    }
    expect(mismatches).toBe(0)
  })
})
