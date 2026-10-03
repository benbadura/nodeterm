import { describe, expect, it } from 'vitest'
import type { KanbanAssignment } from './types'
import { columnOrder, placeAssignment } from './kanban-order'
import { isValidRank, rankBetween } from './kanban-rank'

type A = KanbanAssignment
const a = (nodeId: string, columnId: string, rank?: string): A => (rank === undefined ? { nodeId, columnId } : { nodeId, columnId, rank })
const ids = (list: readonly A[]): string[] => list.map((x) => x.nodeId)
const order = (list: readonly A[], col: string): string[] => ids(columnOrder(list, col))
/** What a build that ignores `rank` shows: the column's entries in ARRAY order. */
const arrayOrder = (list: readonly A[], col: string): string[] => ids(list.filter((x) => x.columnId === col))

const r1 = rankBetween(null, null)
const r2 = rankBetween(r1, null)
const r3 = rankBetween(r2, null)

describe('columnOrder — rank first, array order for what has none', () => {
  it('sorts ranked entries by rank whatever their array order', () => {
    expect(order([a('c', 'x', r3), a('a', 'x', r1), a('b', 'x', r2)], 'x')).toEqual(['a', 'b', 'c'])
  })

  it('an unranked board (every pre-rank file) is array order', () => {
    expect(order([a('b', 'x'), a('y1', 'y'), a('a', 'x')], 'x')).toEqual(['b', 'a'])
  })

  it('an unranked entry sits right after the entry before it in the array (an old build’s move)', () => {
    // An old build moved `u` to just above `c`: it sits after `b` in the array, with no rank.
    expect(order([a('a', 'x', r1), a('b', 'x', r2), a('u', 'x'), a('c', 'x', r3)], 'x')).toEqual(['a', 'b', 'u', 'c'])
    // At the very front of the column it stays first.
    expect(order([a('u', 'x'), a('a', 'x', r1)], 'x')).toEqual(['u', 'a'])
  })

  it('an invalid rank reads as absent', () => {
    expect(order([a('a', 'x', r1), a('bad', 'x', 'not a rank!'), a('b', 'x', r2)], 'x')).toEqual(['a', 'bad', 'b'])
  })

  it('equal ranks (two machines minted the same key) keep array order, deterministically', () => {
    expect(order([a('q', 'x', r1), a('p', 'x', r1)], 'x')).toEqual(['q', 'p'])
  })
})

describe('placeAssignment', () => {
  it('top / end / before, each with a valid rank', () => {
    const base = [a('a', 'x', r1), a('b', 'x', r2)]
    const top = placeAssignment(base, 'n', 'x', 'top')
    expect(order(top, 'x')).toEqual(['n', 'a', 'b'])
    const end = placeAssignment(base, 'n', 'x', 'end')
    expect(order(end, 'x')).toEqual(['a', 'b', 'n'])
    const mid = placeAssignment(base, 'n', 'x', { before: 'b' })
    expect(order(mid, 'x')).toEqual(['a', 'n', 'b'])
    for (const list of [top, end, mid]) expect(list.every((e) => isValidRank(e.rank))).toBe(true)
  })

  it('a `before` outside the column is no anchor: top', () => {
    const base = [a('a', 'x', r1), a('z', 'y', r1)]
    expect(order(placeAssignment(base, 'n', 'x', { before: 'z' }), 'x')).toEqual(['n', 'a'])
  })

  it('WRITES the array in rank order — a build that ignores rank shows the same column', () => {
    const base = [a('a', 'x', r1), a('b', 'x', r2), a('c', 'x', r3)]
    for (const anchor of ['top', 'end', { before: 'b' }, { before: 'a' }] as const) {
      for (const moving of ['a', 'b', 'c', 'new']) {
        const out = placeAssignment(base, moving, 'x', anchor)
        expect(arrayOrder(out, 'x'), `${moving} → ${JSON.stringify(anchor)}`).toEqual(order(out, 'x'))
      }
    }
  })

  it('a cross-column move whose slot already fits changes ONE entry, in place (a two-line diff)', () => {
    // The card sits BEFORE the destination's first card in the array, so the top of that column
    // needs no array move — only its columnId and rank change.
    // An entry of a THIRD column sits between the card and the destination's first card, so the
    // naive "insert before the successor" would move the card's block past it.
    const base = [a('m', 'x', r1), a('o', 'z', r1), a('d1', 'y', r1), a('d2', 'y', r2), a('k', 'x', r2)]
    const out = placeAssignment(base, 'm', 'y', 'top')
    expect(out).toHaveLength(5)
    expect(out[0]).toMatchObject({ nodeId: 'm', columnId: 'y' })
    for (const i of [1, 2, 3, 4]) expect(out[i]).toBe(base[i])
    expect(order(out, 'y')).toEqual(['m', 'd1', 'd2'])
  })

  it('touches no entry of another column', () => {
    const base = [a('o1', 'z'), a('a', 'x', r1), a('o2', 'z'), a('b', 'x', r2)]
    const out = placeAssignment(base, 'b', 'x', 'top')
    expect(out.filter((e) => e.columnId === 'z')).toEqual([base[0], base[2]])
    expect(out.find((e) => e.nodeId === 'o1')).toBe(base[0])
  })

  it('a move that lands where the card already is returns the SAME array (nothing to write)', () => {
    const base = [a('a', 'x', r1), a('b', 'x', r2)]
    expect(placeAssignment(base, 'a', 'x', 'top')).toBe(base)
    expect(placeAssignment(base, 'b', 'x', 'end')).toBe(base)
    expect(placeAssignment(base, 'a', 'x', { before: 'b' })).toBe(base)
  })

  it('ranks an UNRANKED column on its first write, in the order it was already showing', () => {
    const base = [a('a', 'x'), a('b', 'x'), a('c', 'x')]
    const out = placeAssignment(base, 'n', 'x', 'top')
    expect(order(out, 'x')).toEqual(['n', 'a', 'b', 'c'])
    expect(arrayOrder(out, 'x')).toEqual(['n', 'a', 'b', 'c'])
    expect(out.every((e) => isValidRank(e.rank))).toBe(true)
  })

  it('re-keys only the colliding entries after two machines minted the same rank', () => {
    const base = [a('p', 'x', r1), a('q', 'x', r1), a('s', 'x', r3)]
    const out = placeAssignment(base, 'n', 'x', { before: 'q' })
    expect(order(out, 'x')).toEqual(['p', 'n', 'q', 's'])
    expect(out.find((e) => e.nodeId === 'p')).toBe(base[0])
    expect(out.find((e) => e.nodeId === 's')).toBe(base[2])
    const ranks = columnOrder(out, 'x').map((e) => e.rank!)
    for (let i = 1; i < ranks.length; i++) expect(ranks[i - 1] < ranks[i]).toBe(true)
  })

  it('repairs a column whose array disagrees with its ranks (after a textual merge)', () => {
    const base = [a('c', 'x', r3), a('a', 'x', r1), a('b', 'x', r2)]
    const out = placeAssignment(base, 'n', 'x', 'end')
    expect(order(out, 'x')).toEqual(['a', 'b', 'c', 'n'])
    expect(arrayOrder(out, 'x')).toEqual(['a', 'b', 'c', 'n'])
  })

  it('an old build’s rank-less move is respected, then ranked by our next write', () => {
    // Ours: a, b, c ranked. An old build moved `c` to the top: it dropped c's rank and spliced it
    // before `a` in the array (its assignNode rebuilds the moved entry without the field).
    const afterOld = [a('c', 'x'), a('a', 'x', r1), a('b', 'x', r2)]
    expect(order(afterOld, 'x')).toEqual(['c', 'a', 'b'])
    const out = placeAssignment(afterOld, 'n', 'x', 'end')
    expect(order(out, 'x')).toEqual(['c', 'a', 'b', 'n'])
    expect(arrayOrder(out, 'x')).toEqual(order(out, 'x'))
    expect(out.every((e) => isValidRank(e.rank))).toBe(true)
  })

  it('keeps fields it does not know on the moved entry', () => {
    const base = [{ ...a('a', 'x', r1), future: 1 } as A, a('b', 'y', r1)]
    const out = placeAssignment(base, 'a', 'y', 'end')
    expect(out.find((e) => e.nodeId === 'a')).toMatchObject({ future: 1, columnId: 'y' })
  })

  // The contract across ANY sequence of writes: array order == rank order in every column (so a
  // build that ignores rank shows the same board), and every column written to is fully ranked.
  it('holds the old-build contract across a seeded random walk of moves', () => {
    let seed = 7
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return Math.floor((seed / 2147483648) * n)
    }
    const cols = ['x', 'y', 'z']
    const nodes = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']
    // Start from a MIXED board: some ranked, some not, one duplicate — what the field will hold.
    let list: A[] = [a('n0', 'x'), a('n1', 'y', r1), a('n2', 'x', r2), a('n3', 'y', r1), a('n4', 'z')]
    for (let i = 0; i < 400; i++) {
      const node = nodes[rand(nodes.length)]
      const col = cols[rand(cols.length)]
      const pick = rand(3)
      const colIds = order(list, col)
      const anchor = pick === 0 ? 'top' : pick === 1 ? 'end' : { before: colIds[rand(colIds.length + 1)] ?? 'nobody' }
      list = placeAssignment(list, node, col, anchor as Parameters<typeof placeAssignment>[3])
      for (const c of cols) expect(arrayOrder(list, c), `step ${i} col ${c}`).toEqual(order(list, c))
      const dest = columnOrder(list, col).map((e) => e.rank)
      expect(dest.every(isValidRank), `step ${i}`).toBe(true)
      for (let j = 1; j < dest.length; j++) expect(dest[j - 1]! < dest[j]!).toBe(true)
      expect(new Set(ids(list)).size).toBe(list.length)
    }
  })
})

// ~1.3k inserts into ONE gap grow a key past RANK_MAX_LENGTH; the placement used to hand that key
// back to rankBetween on the next move and throw inside the move handler. A move must never throw:
// past that point the column is re-keyed (the one rebalance this scheme ever does).
describe('placeAssignment — never throws, even when one gap is exhausted', () => {
  // 1700 crosses the point (~1525 inserts into one gap) where the next key would pass
  // RANK_MAX_LENGTH; the moved card's neighbour is always the same top card.
  it('1700 inserts just below the top card stay ordered, valid and in array order', { timeout: 30_000 }, () => {
    let list: A[] = []
    list = placeAssignment(list, 'first', 'c', 'top')
    list = placeAssignment(list, 'second', 'c', 'end')
    let second = 'second'
    for (let i = 0; i < 1700; i++) {
      list = placeAssignment(list, `x${i}`, 'c', { before: second })
      second = `x${i}`
      if (i % 200 === 0 || (i > 1500 && i < 1560)) {
        const ranks = columnOrder(list, 'c').map((e) => e.rank)
        expect(ranks.every(isValidRank), `step ${i}`).toBe(true)
      }
    }
    const order = columnOrder(list, 'c').map((e) => e.nodeId)
    expect(order[0]).toBe('first')
    expect(order[1]).toBe('x1699')
    expect(order.at(-1)).toBe('second')
    expect(order).toHaveLength(1702)
    expect(arrayOrder(list, 'c')).toEqual(order)
  })
})
