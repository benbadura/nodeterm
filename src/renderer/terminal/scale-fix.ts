import type { Terminal } from '@xterm/xterm'

/**
 * Fixes mouse selection drift when a terminal lives under a CSS `transform: scale()`
 * (React Flow zoom).
 *
 * xterm computes cell coordinates as `(clientX - rect.left) / cssCellWidth`. `rect.left`
 * comes from `getBoundingClientRect()` which IS scale-aware, so `clientX - rect.left` is in
 * scaled screen pixels — but `cssCellWidth` is the UNSCALED cell size. The result is off by
 * the zoom factor, so the selection lands away from the cursor at any zoom != 1.
 *
 * We wrap the internal MouseService and convert the event's client coords back into the
 * terminal's own (unscaled) pixel space before xterm runs its math:
 *   fakeClientX = rect.left + (clientX - rect.left) / scale
 * which makes `fakeClientX - rect.left = (clientX - rect.left) / scale` — the correct
 * unscaled offset. No-ops at scale 1.
 */
export function patchTerminalScale(
  term: Terminal,
  getScale: () => number,
  raf: (cb: () => void) => unknown = (cb) => requestAnimationFrame(cb)
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ms: any = (term as unknown as { _core?: { _mouseService?: unknown } })._core?._mouseService
  if (!ms || ms.__scalePatched) return
  ms.__scalePatched = true

  // One rect read per animation frame: a mouse move runs getCoords AND getMouseReportCoords (and
  // the link providers call getCoords again), and each fresh getBoundingClientRect() forced a
  // style/layout read. The rect only changes when the canvas moves, which happens on a frame
  // boundary, so a frame-scoped cache is exact.
  let rectCache = new WeakMap<HTMLElement, DOMRect>()
  let clearQueued = false
  const rectOf = (el: HTMLElement): DOMRect => {
    let r = rectCache.get(el)
    if (!r) {
      r = el.getBoundingClientRect()
      rectCache.set(el, r)
      if (!clearQueued) {
        clearQueued = true
        raf(() => {
          clearQueued = false
          rectCache = new WeakMap()
        })
      }
    }
    return r
  }

  const adjust = (event: MouseEvent, element: HTMLElement): MouseEvent => {
    const s = getScale() || 1
    if (Math.abs(s - 1) < 0.001) return event
    const rect = rectOf(element)
    return new Proxy(event, {
      get(target, prop) {
        if (prop === 'clientX') return rect.left + (event.clientX - rect.left) / s
        if (prop === 'clientY') return rect.top + (event.clientY - rect.top) / s
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const value = (target as any)[prop]
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as MouseEvent
  }

  const origGetCoords = typeof ms.getCoords === 'function' ? ms.getCoords.bind(ms) : null
  if (origGetCoords) {
    ms.getCoords = (
      event: MouseEvent,
      element: HTMLElement,
      cols: number,
      rows: number,
      isSelection?: boolean
    ) => origGetCoords(adjust(event, element), element, cols, rows, isSelection)
  }

  const origReport =
    typeof ms.getMouseReportCoords === 'function' ? ms.getMouseReportCoords.bind(ms) : null
  if (origReport) {
    ms.getMouseReportCoords = (event: MouseEvent, element: HTMLElement) =>
      origReport(adjust(event, element), element)
  }
}
