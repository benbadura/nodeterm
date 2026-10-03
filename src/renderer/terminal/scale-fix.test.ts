import { describe, it, expect } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { patchTerminalScale } from './scale-fix'

function fixture() {
  const seen: number[] = []
  const ms = {
    getCoords: (e: MouseEvent, ..._rest: unknown[]) => (seen.push(e.clientX), [0, 0]),
    getMouseReportCoords: (e: MouseEvent, ..._rest: unknown[]) => (seen.push(e.clientX), undefined)
  }
  const term = { _core: { _mouseService: ms } } as unknown as Terminal
  let rectReads = 0
  const el = { getBoundingClientRect: () => (rectReads++, { left: 100, top: 50 }) } as unknown as HTMLElement
  const frames: Array<() => void> = []
  patchTerminalScale(term, () => 0.5, (cb) => frames.push(cb))
  return { ms, el, seen, reads: () => rectReads, flushFrame: () => frames.splice(0).forEach((f) => f()) }
}

const ev = (x: number) => ({ clientX: x, clientY: 60 }) as MouseEvent

describe('patchTerminalScale', () => {
  it('still converts coordinates by the zoom', () => {
    const f = fixture()
    f.ms.getCoords(ev(120), f.el, 80, 24, false)
    expect(f.seen[0]).toBe(140) // 100 + (120-100)/0.5
  })

  it('reads the rect once per frame across calls', () => {
    const f = fixture()
    f.ms.getCoords(ev(120), f.el, 80, 24, false)
    f.ms.getMouseReportCoords(ev(130), f.el)
    f.ms.getCoords(ev(140), f.el, 80, 24, false)
    expect(f.reads()).toBe(1)
    f.flushFrame()
    f.ms.getCoords(ev(150), f.el, 80, 24, false)
    expect(f.reads()).toBe(2) // the next frame re-reads (the canvas may have moved)
  })

  it('does not read the rect at scale 1', () => {
    const seen: number[] = []
    const ms = { getCoords: (e: MouseEvent, ..._rest: unknown[]) => (seen.push(e.clientX), [0, 0]) }
    const term = { _core: { _mouseService: ms } } as unknown as Terminal
    let reads = 0
    const el = { getBoundingClientRect: () => (reads++, { left: 0, top: 0 }) } as unknown as HTMLElement
    patchTerminalScale(term, () => 1, () => 0)
    ms.getCoords(ev(10), el, 80, 24, false)
    expect(reads).toBe(0)
  })
})
