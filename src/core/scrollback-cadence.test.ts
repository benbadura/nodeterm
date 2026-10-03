import { describe, it, expect } from 'vitest'
import { snapshotDue, BUSY_AFTER_TICKS, BUSY_EVERY_TICKS } from './scrollback-cadence'

describe('snapshotDue', () => {
  it('captures on each of the first BUSY_AFTER_TICKS consecutive dirty ticks', () => {
    for (let t = 1; t <= BUSY_AFTER_TICKS; t++) expect(snapshotDue(t)).toBe(true)
  })
  it('then only every BUSY_EVERY_TICKS-th tick (60 s at the 15 s tick)', () => {
    const due = Array.from({ length: 12 }, (_, i) => i + BUSY_AFTER_TICKS + 1).filter(snapshotDue)
    expect(due).toEqual([8, 12, 16])
    expect(BUSY_EVERY_TICKS).toBe(4)
  })
})
