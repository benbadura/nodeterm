// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The module keeps one window-level latch, so every test loads a fresh copy of it.
let isZoomModifierHeld: () => boolean
beforeEach(async () => {
  vi.resetModules()
  ;({ isZoomModifierHeld } = await import('./zoomModifier'))
  isZoomModifierHeld() // installs the listeners
})

const key = (type: 'keydown' | 'keyup', init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent(type, init))

describe('zoom modifier latch', () => {
  it('is held from the modifier keydown to its keyup', () => {
    key('keydown', { key: 'Meta', metaKey: true })
    expect(isZoomModifierHeld()).toBe(true)
    key('keyup', { key: 'Meta' })
    expect(isZoomModifierHeld()).toBe(false)
  })

  // The stuck "pan mode" after a macOS Space switch: the modifier's keyup went to another app and
  // no window blur arrived to clear it, so every terminal's hover guard stayed up (the dwell waits
  // while the modifier is held) until an unrelated key — Escape — was released.
  it('a pointer event without the modifier clears a latch whose keyup was lost', () => {
    key('keydown', { key: 'Meta', metaKey: true })
    window.dispatchEvent(new MouseEvent('mousemove', { metaKey: false, ctrlKey: false }))
    expect(isZoomModifierHeld()).toBe(false)
  })

  it('a wheel event reports the live state too', () => {
    key('keydown', { key: 'Control', ctrlKey: true })
    window.dispatchEvent(new WheelEvent('wheel', { ctrlKey: false }))
    expect(isZoomModifierHeld()).toBe(false)
  })

  it('a pointer event WITH the modifier keeps (or sets) it held — Cmd+wheel over a terminal still zooms', () => {
    window.dispatchEvent(new WheelEvent('wheel', { metaKey: true }))
    expect(isZoomModifierHeld()).toBe(true)
    window.dispatchEvent(new MouseEvent('mousemove', { ctrlKey: true }))
    expect(isZoomModifierHeld()).toBe(true)
  })

  it('window blur and focus both clear it', () => {
    key('keydown', { key: 'Meta', metaKey: true })
    window.dispatchEvent(new Event('blur'))
    expect(isZoomModifierHeld()).toBe(false)
    key('keydown', { key: 'Meta', metaKey: true })
    window.dispatchEvent(new Event('focus'))
    expect(isZoomModifierHeld()).toBe(false)
  })
})
