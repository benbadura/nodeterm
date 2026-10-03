// A visible board keeps asking the host whether an undecided PR is due for another read. The host
// owns the schedule (30 s, 1 min, 2 min, then 5 min) and the cap of 12; this side owns only
// VISIBILITY — it asks while the board is on screen and stops the moment the page is hidden, so a
// board left open behind other windows spends nothing. Asking is free when nothing is due: the host
// answers from a map before it resolves any credential.
export const PULL_CHASE_ASK_MS = 15_000

export interface PullChaseDeps {
  ask: () => void
  visible: () => boolean
  /** Subscribes to visibility changes; returns the unsubscribe. */
  onVisibilityChange: (listener: () => void) => () => void
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (timer: unknown) => void
}

/** Starts asking; returns the stop. Asks only while visible, and resumes when the page is shown. */
export function startPullChase(deps: PullChaseDeps): () => void {
  let timer: unknown
  const arm = (): void => {
    if (timer !== undefined || !deps.visible()) return
    timer = deps.setInterval(() => {
      if (deps.visible()) deps.ask()
    }, PULL_CHASE_ASK_MS)
  }
  const disarm = (): void => {
    if (timer === undefined) return
    deps.clearInterval(timer)
    timer = undefined
  }
  const unsubscribe = deps.onVisibilityChange(() => {
    if (deps.visible()) arm()
    else disarm()
  })
  arm()
  return () => {
    disarm()
    unsubscribe()
  }
}

/** The browser/Electron document as the chase's visibility source. */
export function documentChaseDeps(ask: () => void): PullChaseDeps {
  return {
    ask,
    visible: () => document.visibilityState === 'visible',
    onVisibilityChange: (listener) => {
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (timer) => window.clearInterval(timer as number)
  }
}
