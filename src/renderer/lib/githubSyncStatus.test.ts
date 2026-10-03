import { describe, expect, it } from 'vitest'
import { githubRateSentence, githubThrottleSentence, githubUnreachableSentence } from './githubSyncStatus'

const clock = (ms: number): string => `T+${ms}`

describe('githubThrottleSentence', () => {
  it('says nothing when sync is not held', () => {
    expect(githubThrottleSentence(undefined, clock)).toBeNull()
  })

  it('names the time a rate limit lifts', () => {
    expect(githubThrottleSentence({ until: 90, kind: 'rate-limited' }, clock))
      .toBe('GitHub rate limit reached. Sync resumes at T+90.')
  })

  it('says a low budget pauses only background sync, and until when', () => {
    expect(githubThrottleSentence({ until: 90, kind: 'low-budget' }, clock))
      .toBe('Background sync paused until T+90 to leave the rest of this hour’s GitHub requests to you.')
  })
})

describe('githubRateSentence', () => {
  it('reports the remaining budget and when it resets', () => {
    expect(githubRateSentence({
      resource: 'core', limit: 5_000, remaining: 4_968, resetAt: 90, observedAt: 1
    }, clock)).toBe('4,968 of 5,000 GitHub requests left until T+90.')
  })
})

describe('githubUnreachableSentence', () => {
  it('names a rate limit and when the check can run again', () => {
    expect(githubUnreachableSentence({ reason: 'rate-limited', retryAt: 90 }, clock))
      .toBe('GitHub’s rate limit was reached, so the sign-in could not be checked until T+90.')
  })

  it('names an unreachable GitHub without claiming a cause it did not see', () => {
    expect(githubUnreachableSentence({ reason: 'unreachable' }, clock))
      .toBe('GitHub could not be reached to check the sign-in.')
  })
})
