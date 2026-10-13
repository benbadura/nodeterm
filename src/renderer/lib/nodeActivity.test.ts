import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasNode } from '../state/workspace'
import { flushNodeActivities, nodeActivityChanged, recordNodeActivity, stampNodeActivities, subscribeNodeActivityBatch } from './nodeActivity'

const node = (id = 'term-1'): CanvasNode => ({
  id, type: 'terminal', position: { x: 0, y: 0 }, width: 320, height: 240,
  data: { title: 'Terminal', color: '#888', group: null, createdAt: 1000, lastActivityAt: 2000 }
})

describe('node activity', () => {
  let off: (() => void) | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { off?.(); off = undefined; vi.useRealTimers() })

  it('batches busy streams, keeps the newest actual event date and flushes during continuous output', () => {
    const batches: Map<string, number>[] = []
    off = subscribeNodeActivityBatch((batch) => batches.push(new Map(batch)))
    recordNodeActivity('a', 3000)
    vi.advanceTimersByTime(500)
    recordNodeActivity('a', 3500)
    recordNodeActivity('a', 2500) // delayed older event
    recordNodeActivity('b', 3200)
    expect(batches).toHaveLength(0)
    vi.advanceTimersByTime(500)
    expect(batches).toEqual([new Map([['a', 3500], ['b', 3200]])])
    recordNodeActivity('a', 4000)
    vi.advanceTimersByTime(1000)
    expect(batches[1].get('a')).toBe(4000)
  })

  it('persists the final event before a save/switch and cancels the pending timer', () => {
    const receive = vi.fn()
    off = subscribeNodeActivityBatch(receive)
    recordNodeActivity('a', 3000)
    flushNodeActivities()
    expect(receive).toHaveBeenCalledWith(new Map([['a', 3000]]))
    vi.advanceTimersByTime(2000)
    expect(receive).toHaveBeenCalledTimes(1)
    recordNodeActivity('a', 4000)
    off()
    off = undefined
    recordNodeActivity('a', 5000)
    vi.advanceTimersByTime(2000)
    expect(receive).toHaveBeenCalledTimes(2)
  })

  it('updates only active nodes, keeps creation dates and never moves activity backwards', () => {
    const nodes = [node('a'), node('b')]
    const next = stampNodeActivities(nodes, new Map([['a', 3000], ['b', 1500], ['deleted', 4000]]))
    expect(next[0].data).toMatchObject({ createdAt: 1000, lastActivityAt: 3000 })
    expect(next[1]).toBe(nodes[1])
    expect(stampNodeActivities(next, new Map([['a', 2500]]))).toBe(next)
  })

  it('ignores selection, measurements and clock updates while detecting content and geometry edits', () => {
    const before = node()
    expect(nodeActivityChanged(before, { ...before, selected: true, measured: { width: 320, height: 240 } })).toBe(false)
    expect(nodeActivityChanged(before, { ...before, data: { ...before.data, lastActivityAt: 3000 } })).toBe(false)
    expect(nodeActivityChanged(before, { ...before, data: { ...before.data, text: 'Edited note' } })).toBe(true)
    expect(nodeActivityChanged(before, { ...before, position: { x: 10, y: 0 } })).toBe(true)
    expect(nodeActivityChanged(before, { ...before, width: 400 })).toBe(true)
    expect(nodeActivityChanged(before, { ...before, data: { ...before.data } })).toBe(false)
  })
})
