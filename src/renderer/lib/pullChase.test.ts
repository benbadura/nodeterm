import { describe, expect, it } from 'vitest'
import { PULL_CHASE_ASK_MS, startPullChase, type PullChaseDeps } from './pullChase'

function fake(initiallyVisible: boolean) {
  let visible = initiallyVisible
  let listener: (() => void) | undefined
  const timers = new Map<number, () => void>()
  let next = 0
  let asks = 0
  const deps: PullChaseDeps = {
    ask: () => { asks += 1 },
    visible: () => visible,
    onVisibilityChange: (fn) => { listener = fn; return () => { listener = undefined } },
    setInterval: (fn) => { next += 1; timers.set(next, fn); return next },
    clearInterval: (timer) => { timers.delete(timer as number) }
  }
  return {
    deps,
    tick: (count = 1) => { for (let i = 0; i < count; i++) for (const fn of [...timers.values()]) fn() },
    setVisible: (value: boolean) => { visible = value; listener?.() },
    /** The page hid but no visibilitychange arrived (it is not guaranteed on every platform). */
    hideSilently: () => { visible = false },
    asks: () => asks,
    timers: () => timers.size,
    subscribed: () => listener !== undefined
  }
}

describe('startPullChase', () => {
  it('asks every interval while the board is visible', () => {
    const f = fake(true)
    startPullChase(f.deps)
    f.tick(3)
    expect(f.asks()).toBe(3)
    expect(PULL_CHASE_ASK_MS).toBeLessThanOrEqual(30_000)
  })

  it('never asks while the page is hidden, and stops the moment it hides', () => {
    const f = fake(false)
    startPullChase(f.deps)
    f.tick(10)
    expect(f.asks()).toBe(0)
    expect(f.timers()).toBe(0)
    f.setVisible(true)
    f.tick(2)
    expect(f.asks()).toBe(2)
    f.setVisible(false)
    expect(f.timers()).toBe(0)
    f.tick(10)
    expect(f.asks()).toBe(2)
  })

  it('re-checks visibility on every tick, so a missed hide event still stops the asking', () => {
    const f = fake(true)
    startPullChase(f.deps)
    f.tick(1)
    f.hideSilently()
    f.tick(10)
    expect(f.asks()).toBe(1)
  })

  it('stops for good when the board closes', () => {
    const f = fake(true)
    const stop = startPullChase(f.deps)
    stop()
    expect(f.timers()).toBe(0)
    expect(f.subscribed()).toBe(false)
    f.setVisible(true)
    f.tick(5)
    expect(f.asks()).toBe(0)
  })
})
