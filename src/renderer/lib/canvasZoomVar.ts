// React Flow's zoom, published as the `--nt-zoom` custom property so CSS inside the zoomed
// viewport can size something in SCREEN px (`calc(8px / var(--nt-zoom))`) — the node resize grab
// zones, which must stay a comfortable target at every zoom. Read from the store subscription, not
// `onMove`, so a programmatic setViewport / fitView is covered too. Written on React Flow's own
// root (`domNode`), never the document, and only once the zoom SETTLES: a custom property change
// restyles every element under it, and a zoom gesture is a stream of frames — so mid-gesture the
// zones keep the previous zoom's size and are exact again `ZOOM_SETTLE_MS` after the last frame.
// The first value (and a new root element) is written at once. A pan writes nothing.

export const ZOOM_SETTLE_MS = 150

interface ZoomState {
  transform: readonly [number, number, number]
  domNode?: Element | null
}
interface ZoomSource {
  getState(): ZoomState
  subscribe(listener: (state: ZoomState) => void): () => void
}

export function publishCanvasZoom(store: ZoomSource): () => void {
  let lastZoom = NaN
  let lastEl: Element | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const write = (): void => {
    timer = null
    const s = store.getState()
    const zoom = s.transform[2]
    const el = s.domNode ?? null
    if (!el || !(zoom > 0) || (zoom === lastZoom && el === lastEl)) return
    lastZoom = zoom
    lastEl = el
    ;(el as HTMLElement).style.setProperty('--nt-zoom', String(zoom))
  }
  const onChange = (s: ZoomState): void => {
    const el = s.domNode ?? null
    if (el && el !== lastEl) {
      // first publish onto this root: no reason to wait
      if (timer) clearTimeout(timer)
      write()
      return
    }
    if (s.transform[2] === lastZoom) return // a pan, or a zoom that came back
    if (timer) clearTimeout(timer)
    timer = setTimeout(write, ZOOM_SETTLE_MS)
  }
  onChange(store.getState())
  const unsubscribe = store.subscribe(onChange)
  return () => {
    unsubscribe()
    if (timer) clearTimeout(timer)
  }
}
