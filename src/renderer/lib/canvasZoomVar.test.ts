import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishCanvasZoom, ZOOM_SETTLE_MS } from './canvasZoomVar'

type State = { transform: readonly [number, number, number]; domNode?: Element | null }

const fakeStore = (zoom: number, domNode: Element | null) => {
  let state: State = { transform: [0, 0, zoom], domNode }
  const listeners = new Set<(s: State) => void>()
  return {
    getState: () => state,
    subscribe: (fn: (s: State) => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    set: (patch: Partial<State>) => {
      state = { ...state, ...patch }
      listeners.forEach((fn) => fn(state))
    }
  }
}

const fakeEl = () => {
  const writes: string[] = []
  return { writes, el: { style: { setProperty: (_k: string, v: string) => writes.push(v) } } as unknown as Element }
}

describe('publishCanvasZoom', () => {
  afterEach(() => vi.useRealTimers())

  it("writes onto React Flow's root at once, then only once a zoom gesture settles", () => {
    vi.useFakeTimers()
    const store = fakeStore(1, null)
    const { el, writes } = fakeEl()
    const stop = publishCanvasZoom(store)
    expect(writes).toEqual([]) // no root yet — nothing written, nothing on <html>
    store.set({ domNode: el })
    expect(writes).toEqual(['1']) // the root's first value is immediate
    store.set({ transform: [50, 0, 1] }) // a pan writes nothing
    // a zoom gesture: many frames, one write after the last
    for (const z of [0.9, 0.8, 0.7, 0.6]) {
      store.set({ transform: [0, 0, z] })
      vi.advanceTimersByTime(ZOOM_SETTLE_MS / 3)
    }
    expect(writes).toEqual(['1'])
    vi.advanceTimersByTime(ZOOM_SETTLE_MS)
    expect(writes).toEqual(['1', '0.6'])
    // a programmatic fitView / setViewport is one change, settled the same way
    store.set({ transform: [10, 10, 1.25] })
    vi.advanceTimersByTime(ZOOM_SETTLE_MS)
    expect(writes).toEqual(['1', '0.6', '1.25'])
    store.set({ transform: [0, 0, 0] }) // a degenerate zoom is ignored
    vi.advanceTimersByTime(ZOOM_SETTLE_MS)
    stop()
    store.set({ transform: [0, 0, 2] })
    vi.advanceTimersByTime(ZOOM_SETTLE_MS)
    expect(writes).toEqual(['1', '0.6', '1.25'])
  })
})
