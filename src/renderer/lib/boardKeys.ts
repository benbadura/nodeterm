/**
 * The seam between the window keydown dispatcher (Canvas — the ONE registry dispatcher) and the
 * board that is on screen. Canvas owns the `board.*` handlers because it owns the dispatcher; the
 * board owns the cards. Module state rather than React context because the handler runs inside a
 * window keydown listener and must answer "claimed?" synchronously.
 *
 * With no board registered (the Omni view, or no board at all) every action DECLINES, so the key
 * falls through to the platform exactly as an unbound one would.
 */
export type BoardKeyAction = 'open' | 'next' | 'prev' | 'left' | 'right'

type Handler = (action: BoardKeyAction) => boolean

let current: Handler | null = null

/** Register the mounted board's handler; returns an unregister that only clears ITS registration
 *  (a remount's new handler must survive the old one's cleanup, whatever order React runs them). */
export function registerBoardKeys(handler: Handler): () => void {
  current = handler
  return () => {
    if (current === handler) current = null
  }
}

/** Run a board action; true = the board claimed the key. */
export function runBoardKey(action: BoardKeyAction): boolean {
  return current ? current(action) : false
}
