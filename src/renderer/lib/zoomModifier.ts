// Tracks whether a zoom modifier (Cmd/Ctrl) is currently held, via a single set of
// capture-phase window listeners. Used by the terminal hover-guard so Cmd+wheel zooming over
// a terminal doesn't dwell-focus (enter) the terminal — the canvas keeps zooming instead.
//
// A key latch is only as good as its keyup, and keyups get lost: switch macOS Spaces (a
// four-finger swipe) and the modifier's release can land in another app with no window blur to
// clear the latch here. A stuck `true` is not harmless — the hover guard's dwell waits for as long
// as the modifier is held, so every terminal stays behind its guard (scroll pans the canvas, a
// click never focuses) until some unrelated key is released. So every pointer and wheel event
// re-reads the modifier state the OS attached to it: the first mouse movement after coming back
// corrects the latch, and nothing that was really held is ever dropped.
let held = false
let inited = false

function ensure(): void {
  if (inited) return
  inited = true
  const down = (e: KeyboardEvent) => {
    if (e.key === 'Meta' || e.key === 'Control' || e.metaKey || e.ctrlKey) held = true
  }
  const up = (e: KeyboardEvent) => {
    if (e.key === 'Meta' || e.key === 'Control') held = false
    else if (!e.metaKey && !e.ctrlKey) held = false
  }
  const live = (e: MouseEvent) => {
    held = e.metaKey || e.ctrlKey
  }
  const reset = () => (held = false)
  window.addEventListener('keydown', down, true)
  window.addEventListener('keyup', up, true)
  // WheelEvent is a MouseEvent, so all three carry the live modifier flags.
  window.addEventListener('mousemove', live, true)
  window.addEventListener('mousedown', live, true)
  window.addEventListener('wheel', live, { capture: true, passive: true })
  window.addEventListener('blur', reset)
  window.addEventListener('focus', reset)
}

/** True while Cmd or Ctrl is currently pressed. */
export function isZoomModifierHeld(): boolean {
  ensure()
  return held
}
