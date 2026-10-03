import { describe, expect, it } from 'vitest'
import { backgroundFloor, GitHubRequestCoordinator, MAX_RATE_WAIT_MS } from './request-coordinator'

describe('GitHubRequestCoordinator', () => {
  it('allows at most four reads for one identity across repositories', async () => {
    const coordinator = new GitHubRequestCoordinator()
    let active = 0
    let maximum = 0
    const releases: Array<() => void> = []
    const operation = () => coordinator.runRead('user-1', () => new Promise<number>((resolve) => {
      active += 1
      maximum = Math.max(maximum, active)
      releases.push(() => { active -= 1; resolve(active) })
    }))
    const results = [operation(), operation(), operation(), operation(), operation(), operation()]
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(active).toBe(4)
    while (releases.length) {
      releases.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await Promise.all(results)
    expect(maximum).toBe(4)
  })

  it('applies a rate limit from one repository to every repository for the identity', () => {
    const coordinator = new GitHubRequestCoordinator({ now: () => 1_000 })
    coordinator.noteRateLimit('user-1', { kind: 'secondary', retryAt: 5_000 })
    expect(coordinator.canStart('user-1', 4_999)).toBe(false)
    expect(coordinator.canStart('user-1', 5_000)).toBe(true)
    expect(coordinator.canStart('user-2', 1_000)).toBe(true)
  })

  it('learns an identity-wide backoff directly from a failed GitHub operation', async () => {
    const coordinator = new GitHubRequestCoordinator({ now: () => 1_000 })
    await expect(coordinator.runRead('user-1', async () => {
      throw Object.assign(new Error('rate-limited'), { code: 'rate-limited', retryAt: 5_000 })
    })).rejects.toMatchObject({ code: 'rate-limited' })
    expect(coordinator.canStart('user-1', 4_999)).toBe(false)
  })

  it('rechecks an identity deadline that is extended while a request is sleeping', async () => {
    let now = 1_000
    const sleeps: number[] = []
    const coordinator = new GitHubRequestCoordinator({
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        now += milliseconds
        if (sleeps.length === 1) {
          coordinator.noteRateLimit('user-1', { kind: 'secondary', retryAt: 8_000 })
        }
      }
    })
    coordinator.noteRateLimit('user-1', { kind: 'secondary', retryAt: 5_000 })

    await coordinator.runRead('user-1', async () => 'ok')

    expect(sleeps).toEqual([4_000, 3_000])
    expect(now).toBe(8_000)
  })

  it('serialises mutations and spaces their start times by one second', async () => {
    let now = 0
    const sleeps: number[] = []
    const coordinator = new GitHubRequestCoordinator({
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms }
    })
    const starts: number[] = []
    await Promise.all([
      coordinator.runMutation('user-1', async () => { starts.push(now); return 1 }),
      coordinator.runMutation('user-1', async () => { starts.push(now); return 2 }),
      coordinator.runMutation('user-1', async () => { starts.push(now); return 3 })
    ])
    expect(starts).toEqual([0, 1_000, 2_000])
    expect(sleeps).toEqual([1_000, 1_000])
  })

  it('cancels queued work when an identity changes', async () => {
    const coordinator = new GitHubRequestCoordinator()
    let release: () => void = () => undefined
    const first = coordinator.runMutation('user-1', () => new Promise<void>((resolve) => { release = resolve }))
    const queued = coordinator.runMutation('user-1', async () => 'must-not-run')
    await new Promise((resolve) => setTimeout(resolve, 0))
    coordinator.cancelIdentity('user-1')
    release()
    await first
    await expect(queued).rejects.toMatchObject({ code: 'configuration-changed' })
  })

  it('cancels queued work for every known identity at an authentication boundary', async () => {
    const coordinator = new GitHubRequestCoordinator()
    let releaseA: () => void = () => undefined
    let releaseB: () => void = () => undefined
    const activeA = coordinator.runMutation('user-a', () =>
      new Promise<void>((resolve) => { releaseA = resolve }))
    const activeB = coordinator.runMutation('user-b', () =>
      new Promise<void>((resolve) => { releaseB = resolve }))
    const queuedA = coordinator.runMutation('user-a', async () => 'must-not-run')
    const queuedB = coordinator.runMutation('user-b', async () => 'must-not-run')
    await new Promise((resolve) => setTimeout(resolve, 0))
    coordinator.cancelAll()
    releaseA()
    releaseB()
    await Promise.all([activeA, activeB])
    await expect(queuedA).rejects.toMatchObject({ code: 'configuration-changed' })
    await expect(queuedB).rejects.toMatchObject({ code: 'configuration-changed' })
  })
})

describe('GitHubRequestCoordinator rate budget', () => {
  const sample = (remaining: number, resetAt = 3_600_000, limit = 5_000) =>
    ({ resource: 'core', limit, remaining, resetAt })

  it('records the budget each response reports, per identity', () => {
    const coordinator = new GitHubRequestCoordinator({ now: () => 1_000 })
    coordinator.noteRateSample('user-1', sample(4_968))
    expect(coordinator.rateStatus('user-1')).toEqual({
      resource: 'core', limit: 5_000, remaining: 4_968, resetAt: 3_600_000, observedAt: 1_000
    })
    expect(coordinator.rateStatus('user-2')).toBeUndefined()
  })

  it('keeps the lowest reading of a window and adopts a newer window', () => {
    const coordinator = new GitHubRequestCoordinator({ now: () => 1_000 })
    coordinator.noteRateSample('user-1', sample(4_000))
    // A response that left GitHub earlier can arrive later; it must not raise the budget back.
    coordinator.noteRateSample('user-1', sample(4_500))
    expect(coordinator.rateStatus('user-1')?.remaining).toBe(4_000)
    coordinator.noteRateSample('user-1', sample(4_999, 7_200_000))
    expect(coordinator.rateStatus('user-1')?.remaining).toBe(4_999)
  })

  it('blocks new requests the moment a response says the budget is spent, before any refusal', () => {
    const coordinator = new GitHubRequestCoordinator({ now: () => 1_000 })
    coordinator.noteRateSample('user-1', sample(0, 90_000))
    expect(coordinator.canStart('user-1', 89_999)).toBe(false)
    expect(coordinator.canStart('user-1', 90_000)).toBe(true)
    expect(coordinator.throttle('user-1')).toEqual({ until: 90_000, kind: 'rate-limited' })
  })

  it('pauses background work below the floor and resumes it when the window resets', () => {
    let now = 1_000
    const coordinator = new GitHubRequestCoordinator({ now: () => now })
    coordinator.noteRateSample('user-1', sample(backgroundFloor(5_000), 90_000))
    expect(coordinator.throttle('user-1')).toBeUndefined()
    coordinator.noteRateSample('user-1', sample(backgroundFloor(5_000) - 1, 90_000))
    expect(coordinator.throttle('user-1')).toEqual({ until: 90_000, kind: 'low-budget' })
    // Low budget pauses only BACKGROUND work: a request the user asked for may still start.
    expect(coordinator.canStart('user-1')).toBe(true)
    now = 90_000
    expect(coordinator.throttle('user-1')).toBeUndefined()
  })

  it('reports an error-learned backoff as the throttle too', () => {
    const coordinator = new GitHubRequestCoordinator({ now: () => 1_000 })
    coordinator.noteRateLimit('user-1', { kind: 'secondary', retryAt: 61_000 })
    expect(coordinator.throttle('user-1')).toEqual({ until: 61_000, kind: 'rate-limited' })
  })

  it('refuses a read at once instead of sleeping past the cap', async () => {
    const sleeps: number[] = []
    const coordinator = new GitHubRequestCoordinator({
      now: () => 1_000,
      sleep: async (milliseconds) => { sleeps.push(milliseconds) }
    })
    coordinator.noteRateSample('user-1', sample(0, 1_000 + 60 * 60_000))
    let ran = false
    await expect(coordinator.runRead('user-1', async () => { ran = true }))
      .rejects.toMatchObject({ code: 'rate-limited', retryAt: 1_000 + 60 * 60_000 })
    expect(ran).toBe(false)
    expect(sleeps).toEqual([])
  })

  it('refuses a mutation at once instead of sleeping past the cap', async () => {
    const sleeps: number[] = []
    const coordinator = new GitHubRequestCoordinator({
      now: () => 1_000,
      sleep: async (milliseconds) => { sleeps.push(milliseconds) }
    })
    coordinator.noteRateLimit('user-1', { kind: 'primary', retryAt: 1_000 + MAX_RATE_WAIT_MS + 1 })
    await expect(coordinator.runMutation('user-1', async () => 'written'))
      .rejects.toMatchObject({ code: 'rate-limited' })
    expect(sleeps).toEqual([])
  })

  it('bounds the TOTAL wait when the deadline keeps moving during the sleep', async () => {
    let now = 1_000
    const sleeps: number[] = []
    const coordinator = new GitHubRequestCoordinator({
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        now += milliseconds
        coordinator.noteRateLimit('user-1', { kind: 'secondary', retryAt: now + MAX_RATE_WAIT_MS - 1 })
      }
    })
    coordinator.noteRateLimit('user-1', { kind: 'secondary', retryAt: 1_000 + MAX_RATE_WAIT_MS - 1 })
    await expect(coordinator.runRead('user-1', async () => 'ok')).rejects.toMatchObject({ code: 'rate-limited' })
    expect(sleeps.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(MAX_RATE_WAIT_MS)
  })

  describe('the graphql budget', () => {
    it('a graphql primary limit holds GraphQL reads but not REST issue sync', async () => {
      const coordinator = new GitHubRequestCoordinator({ now: () => 1_000 })
      await expect(coordinator.runRead('user-1', async () => {
        throw Object.assign(new Error('rate-limited'), {
          code: 'rate-limited', retryAt: 3_600_000, resource: 'graphql'
        })
      })).rejects.toMatchObject({ code: 'rate-limited' })
      expect(coordinator.throttle('user-1', 1_000, 'graphql')).toEqual({ until: 3_600_000, kind: 'rate-limited' })
      expect(coordinator.throttle('user-1', 1_000)).toBeUndefined()
      expect(coordinator.canStart('user-1', 1_000)).toBe(true)
    })

    it('an untagged (secondary) limit still holds the whole identity, graphql included', async () => {
      const coordinator = new GitHubRequestCoordinator({ now: () => 1_000 })
      await expect(coordinator.runRead('user-1', async () => {
        throw Object.assign(new Error('rate-limited'), { code: 'rate-limited', retryAt: 9_000 })
      })).rejects.toMatchObject({ code: 'rate-limited' })
      expect(coordinator.throttle('user-1', 1_000, 'graphql')).toEqual({ until: 9_000, kind: 'rate-limited' })
      expect(coordinator.throttle('user-1', 1_000)).toEqual({ until: 9_000, kind: 'rate-limited' })
    })

    it('meters the graphql budget on its own floor', () => {
      const coordinator = new GitHubRequestCoordinator({ now: () => 1_000 })
      coordinator.noteRateSample('user-1', { resource: 'graphql', limit: 5_000, remaining: 99, resetAt: 60_000 })
      expect(coordinator.throttle('user-1', 1_000, 'graphql')).toEqual({ until: 60_000, kind: 'low-budget' })
      expect(coordinator.throttle('user-1', 1_000)).toBeUndefined()
      coordinator.noteRateSample('user-1', { resource: 'graphql', limit: 5_000, remaining: 0, resetAt: 60_000 })
      expect(coordinator.throttle('user-1', 1_000, 'graphql')).toEqual({ until: 60_000, kind: 'rate-limited' })
      expect(coordinator.canStart('user-1', 1_000)).toBe(true)
    })
  })
})
