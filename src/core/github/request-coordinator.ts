import type { GitHubRateStatus, GitHubThrottle } from '../../shared/github-issues'
import type { GitHubRateSample } from './client'

export class GitHubCoordinatorError extends Error {
  constructor(
    readonly code: 'configuration-changed' | 'rate-limited',
    readonly retryAt?: number
  ) {
    super(code)
  }
}

/** The longest any queued request waits out a rate limit. A primary limit resets up to an hour
 *  away; sleeping that long held a read slot (four per identity) and left the caller's IPC call
 *  hanging for the hour. Past this, the request is refused at once with the time it may retry. */
export const MAX_RATE_WAIT_MS = 10_000

/** Below this many requests left in the window, BACKGROUND polls stop until the window resets.
 *  The budget belongs to the whole GitHub account — the user's `gh`, their browser session and
 *  every other tool spend it too — so a board that polls must hand the last tenth back rather
 *  than race everything else to zero. A user-initiated refresh still runs (within its own floors). */
export function backgroundFloor(limit: number): number {
  return Math.max(100, Math.ceil(limit * 0.1))
}

type RateLimit = { kind: 'primary' | 'secondary'; retryAt: number }
type ReadJob = {
  generation: number
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}
type IdentityState = {
  activeReads: number
  readQueue: ReadJob[]
  mutationTail: Promise<void>
  lastMutationAt: number
  generation: number
  retryAt: number
  /** Primary-limit holds for a non-`core` budget (see `noteOperationRateLimit`). */
  resourceRetryAt: Map<string, number>
  /** Latest budget per resource (`core`, `search`, …), from response headers. */
  budget: Map<string, GitHubRateStatus>
}

type CoordinatorOptions = {
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

function noteOperationRateLimit(state: IdentityState, error: unknown): void {
  if (!error || typeof error !== 'object') return
  const value = error as { code?: unknown; retryAt?: unknown; resource?: unknown }
  if (value.code === 'rate-limited' && typeof value.retryAt === 'number' &&
      Number.isFinite(value.retryAt)) {
    // A PRIMARY limit belongs to one budget. `graphql` and `core` are separate, so a spent `graphql`
    // budget (the user's own `gh pr list` spends it too) holds only GraphQL reads — it must not
    // stall REST issue sync for up to an hour. Untagged (secondary) limits hold the identity.
    if (typeof value.resource === 'string' && value.resource !== 'core') {
      const previous = state.resourceRetryAt.get(value.resource) ?? 0
      state.resourceRetryAt.set(value.resource, Math.max(previous, value.retryAt))
      return
    }
    state.retryAt = Math.max(state.retryAt, value.retryAt)
  }
}

export class GitHubRequestCoordinator {
  private readonly states = new Map<string, IdentityState>()
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>

  constructor(options: CoordinatorOptions = {}) {
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  runRead<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const state = this.state(identity)
    return new Promise<T>((resolve, reject) => {
      state.readQueue.push({
        generation: state.generation,
        run: operation,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.drainReads(identity, state)
    })
  }

  runMutation<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const state = this.state(identity)
    const generation = state.generation
    let resolveResult: (value: T) => void
    let rejectResult: (error: unknown) => void
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    state.mutationTail = state.mutationTail.then(async () => {
      try {
        if (generation !== state.generation) throw new GitHubCoordinatorError('configuration-changed')
        await this.waitForRate(state)
        const spacing = state.lastMutationAt + 1_000 - this.now()
        if (spacing > 0) await this.sleep(spacing)
        if (generation !== state.generation) throw new GitHubCoordinatorError('configuration-changed')
        state.lastMutationAt = this.now()
        resolveResult(await operation())
      } catch (error) {
        noteOperationRateLimit(state, error)
        rejectResult(error)
      }
    })
    return result
  }

  noteRateLimit(identity: string, limit: RateLimit): void {
    const state = this.state(identity)
    if (Number.isFinite(limit.retryAt)) state.retryAt = Math.max(state.retryAt, limit.retryAt)
  }

  /** Records the budget a response carried. Responses can land out of order, so within one window
   *  the LOWEST reading wins; a later window replaces an earlier one. A spent `core` budget blocks
   *  new requests right away, instead of waiting for GitHub to refuse one. */
  noteRateSample(identity: string, sample: GitHubRateSample): void {
    const state = this.state(identity)
    const previous = state.budget.get(sample.resource)
    if (previous && sample.resetAt < previous.resetAt) return
    if (previous && sample.resetAt === previous.resetAt && sample.remaining >= previous.remaining) return
    state.budget.set(sample.resource, { ...sample, observedAt: this.now() })
    if (sample.resource === 'core' && sample.remaining === 0) {
      state.retryAt = Math.max(state.retryAt, sample.resetAt)
    }
  }

  /** The budget last seen for this identity (`core` unless another resource is named), while its
   *  window is still current. */
  rateStatus(identity: string, at = this.now(), resource = 'core'): GitHubRateStatus | undefined {
    const status = this.states.get(identity)?.budget.get(resource)
    return status && status.resetAt > at ? { ...status } : undefined
  }

  /** Why background work for this identity must wait, and until when — or undefined when it may
   *  run. `rate-limited` also holds user-initiated requests (they wait up to MAX_RATE_WAIT_MS, then
   *  are refused); `low-budget` holds only background polls. `resource` names the budget the work
   *  would spend: GraphQL reads spend `graphql`, which GitHub meters separately from `core`. */
  throttle(identity: string, at = this.now(), resource = 'core'): GitHubThrottle | undefined {
    const state = this.states.get(identity)
    if (!state) return undefined
    if (state.retryAt > at) return { until: state.retryAt, kind: 'rate-limited' }
    const resourceRetryAt = state.resourceRetryAt.get(resource) ?? 0
    if (resourceRetryAt > at) return { until: resourceRetryAt, kind: 'rate-limited' }
    const status = this.rateStatus(identity, at, resource)
    if (status && status.remaining === 0) return { until: status.resetAt, kind: 'rate-limited' }
    if (status && status.remaining < backgroundFloor(status.limit)) {
      return { until: status.resetAt, kind: 'low-budget' }
    }
    return undefined
  }

  canStart(identity: string, at = this.now()): boolean {
    return at >= this.state(identity).retryAt
  }

  cancelIdentity(identity: string): void {
    const state = this.state(identity)
    state.generation += 1
    const error = new GitHubCoordinatorError('configuration-changed')
    for (const job of state.readQueue.splice(0)) job.reject(error)
  }

  cancelAll(): void {
    for (const identity of this.states.keys()) this.cancelIdentity(identity)
  }

  private state(identity: string): IdentityState {
    let state = this.states.get(identity)
    if (!state) {
      state = {
        activeReads: 0,
        readQueue: [],
        mutationTail: Promise.resolve(),
        lastMutationAt: Number.NEGATIVE_INFINITY,
        generation: 0,
        retryAt: 0,
        resourceRetryAt: new Map(),
        budget: new Map()
      }
      this.states.set(identity, state)
    }
    return state
  }

  private drainReads(identity: string, state: IdentityState): void {
    while (state.activeReads < 4 && state.readQueue.length) {
      const job = state.readQueue.shift()!
      state.activeReads += 1
      void (async () => {
        try {
          if (job.generation !== state.generation) throw new GitHubCoordinatorError('configuration-changed')
          await this.waitForRate(state)
          if (job.generation !== state.generation) throw new GitHubCoordinatorError('configuration-changed')
          job.resolve(await job.run())
        } catch (error) {
          noteOperationRateLimit(state, error)
          job.reject(error)
        } finally {
          state.activeReads -= 1
          this.drainReads(identity, state)
        }
      })()
    }
  }

  private async waitForRate(state: IdentityState): Promise<void> {
    // The cap bounds the TOTAL wait, not each sleep: a deadline that keeps moving while we sleep
    // (a secondary limit re-armed by a concurrent request) must not chain waits without end.
    const deadline = this.now() + MAX_RATE_WAIT_MS
    while (true) {
      const wait = state.retryAt - this.now()
      if (wait <= 0) return
      if (state.retryAt > deadline) throw new GitHubCoordinatorError('rate-limited', state.retryAt)
      await this.sleep(wait)
    }
  }
}
