import { describe, it, expect } from 'vitest'
import { pinNeutralMachineNoun } from './testMachineNoun'
import type { LicenseDetail, LicenseStatus } from '@shared/types'
import {
  proStatusLine,
  licenseSentence,
  canReleaseDevices,
  canUseKeyElsewhere,
  isReleaseRefusal,
  releaseFailureSentence,
  activationErrorSentence
} from './licenseCopy'

// `detail.error` carries TWO families and only the code word separates them: a read that FAILED
// (its counts are placeholder zeros) and a release that was REFUSED (its counts are the last good
// read — real, current, worth showing). Most of what follows exists to pin that seam, because
// every wrong ordering of the checks still produces a plausible-looking sentence.

const keygen = (over: Partial<LicenseDetail> = {}): LicenseDetail => ({
  key: 'NT-KEY-1',
  used: 2,
  seats: 3,
  source: 'keygen',
  error: null,
  ...over
})


// The copy under test names the machine, and `machineNoun()` sniffs the host — pin it so the
// literals below hold on a Mac too (see testMachineNoun.ts).
pinNeutralMachineNoun()

describe('licenseSentence — a keygen license that read cleanly', () => {
  it('reports usage against the cap and names phones as devices', () => {
    const s = licenseSentence(keygen({ used: 2, seats: 3 }))
    expect(s).toBe('2 of 3 devices in use — this computer and each paired phone counts as a device.')
    // The numbers are the DATA's, not a template that happens to read well: a swapped pair or a
    // hardcoded cap would still match a looser assertion.
    expect(licenseSentence(keygen({ used: 1, seats: 5 }))).toBe(
      '1 of 5 devices in use — this computer and each paired phone counts as a device.'
    )
  })

  it('names the cap being full and points at the release action', () => {
    expect(licenseSentence(keygen({ used: 3, seats: 3 }))).toBe(
      'All 3 devices are in use. Release the others below to free them up.'
    )
  })

  it('does not claim "all N" when MORE than N are in use (a cap lowered after activation)', () => {
    // `used > seats` is reachable and must not be flattened into the full-cap sentence: "All 3
    // devices are in use" under a 4-device reality is a wrong number stated as a fact. A `>=`
    // that falls through to the full-cap branch passes every other test in this file.
    expect(licenseSentence(keygen({ used: 4, seats: 3 }))).toBe(
      '4 devices are in use, more than the 3 this license allows. Release the others below to free them up.'
    )
  })

  it('is honest when the read succeeded but no key is on file', () => {
    // Legitimate: a keygen policy that hides keys, or a license predating the key column. This is
    // the ONLY case this sentence may appear in — see the apple/free/error tests below.
    expect(licenseSentence(keygen({ key: null }))).toBe(
      'No key is on file for this license yet — get in touch and we will send yours.'
    )
  })
})

describe('licenseSentence — sources that have no key and no device count', () => {
  it('says an App Store subscription bridged Pro here, and prints no counts', () => {
    const s = licenseSentence({ key: null, used: 0, seats: 0, source: 'apple', error: null })
    expect(s).toBe(
      'Pro on this computer comes from the App Store subscription on your paired phone, so there is no license key or device count to show here. That subscription is managed by Apple, not by nodeterm: to see when it renews or to cancel it, open the App Store on that phone and go to Subscriptions in your account.'
    )
    // The zeros are "not applicable", not a measurement. Rendering them here is the exact
    // misdirection this branch exists to prevent.
    expect(s).not.toContain('0')
    // …and it must not borrow the keygen "no key on file" line, which would send an App Store
    // subscriber to support asking for a key that will never exist.
    expect(s).not.toContain('get in touch')
  })

  it('says a Google Play subscription bridged Pro here, mirroring the App Store sentence', () => {
    const s = licenseSentence({ key: null, used: 0, seats: 0, source: 'google', error: null })
    expect(s).toBe(
      'Pro on this computer comes from the Google Play subscription on your paired phone, so there is no license key or device count to show here. That subscription is managed by Google, not by nodeterm: to see when it renews or to cancel it, open the Play Store on that phone and go to Payments & subscriptions → Subscriptions.'
    )
    expect(s).not.toContain('0')
    expect(s).not.toContain('get in touch')
    expect(s).not.toContain('App Store')
  })

  it('says plainly that a `free` source is not backed by a key, inventing no origin story', () => {
    const s = licenseSentence({ key: null, used: 0, seats: 0, source: 'free', error: null })
    expect(s).toBe('Pro on this device is not backed by a license key.')
    expect(s).not.toContain('get in touch')
    expect(s).not.toContain('0')
  })

  it('says nothing when a clean read stated no source at all', () => {
    // Only reachable through a release merge over an empty detail (counts real, source unknown).
    // With no stated source there is no sentence the data supports — so, none.
    expect(licenseSentence({ key: null, used: 1, seats: 3, source: null, error: null })).toBe('')
  })
})

describe('licenseSentence — a read that FAILED', () => {
  // Every code in this family arrives with placeholder zeros and a null key.
  const couldNotLook = ['offline', 'disabled', 'network'] as const
  const FAILED = 'Could not read this license right now, so the key and device count are unknown. Your Pro access is unaffected.'

  for (const error of couldNotLook) {
    it(`renders "${error}" as a failed read, never as a device count`, () => {
      const s = licenseSentence({ key: null, used: 0, seats: 0, source: null, error })
      expect(s).toBe(FAILED)
      // A failed read is not "0 of 0 devices" and not "no key on file".
      expect(s).not.toContain('0 of 0')
      expect(s).not.toContain('get in touch')
    })
  }

  // "Your Pro access is unaffected." is a PROMISE ABOUT THE FUTURE, and only these three codes back
  // it: we never got to look, so nothing about the license changed. The two below are answers.
  it('does not promise Pro is unaffected when the server said the license is inactive', () => {
    const s = licenseSentence({ key: null, used: 0, seats: 0, source: null, error: 'inactive' })
    expect(s).toBe(
      'This license is not active, so there is no key or device count to show — and Pro on this computer will stop when its current entitlement expires.'
    )
    // A suspended/refunded license DOES drop Pro at the next refresh — the old shared sentence
    // told that user the opposite, in the one place they came to find out.
    expect(s).not.toContain('unaffected')
    expect(s).not.toContain('0 of 0')
  })

  it('does not promise Pro is unaffected when this machine was refused', () => {
    const s = licenseSentence({ key: null, used: 0, seats: 0, source: null, error: 'unauthorized' })
    expect(s).toBe(
      'This computer is not authorized on this license, so the key and device count are unavailable — and Pro here may stop when its current entitlement expires.'
    )
    expect(s).not.toContain('unaffected')
    // "may", not "will": a later refresh can re-mint. Overstating is the other half of the lie.
    expect(s).toContain('may stop')
  })

  it('makes no promise at all for a code it does not recognize', () => {
    // A reason word the server grew after this build shipped. Saying "unaffected" would be a
    // guess about a state we cannot read; saying nothing more than what happened is not.
    const s = licenseSentence({ key: null, used: 0, seats: 0, source: null, error: 'teapot' })
    expect(s).toBe('Could not read this license right now, so the key and device count are unknown.')
    expect(s).not.toContain('unaffected')
  })

  it('still renders the failure when the failed read carried a source and stale-looking counts', () => {
    // ORDERING PIN: if the `source` check ran before the `error` check, this would render the
    // keygen usage sentence over a read that never came back — a fabricated device count.
    const s = licenseSentence({ key: 'NT-KEY-1', used: 2, seats: 3, source: 'keygen', error: 'offline' })
    expect(s).toBe(FAILED)
    expect(s).not.toContain('2 of 3')
  })
})

describe('licenseSentence — a release that was REFUSED', () => {
  it('says when releasing is possible again, in days', () => {
    // ORDERING PIN, the other direction: this detail is a clean keygen read with a refusal code on
    // top. Falling through to the read-failure sentence would tell the user their license could
    // not be read, when in fact it was read fine and only the ACTION was refused.
    const s = licenseSentence(keygen({ error: 'too_soon', retryAfterDays: 12 }))
    expect(s).toBe('You can release devices again in 12 days.')
    expect(s).not.toContain('Could not read')
  })

  it('says "1 day", not "1 days"', () => {
    expect(licenseSentence(keygen({ error: 'too_soon', retryAfterDays: 1 }))).toBe(
      'You can release devices again in 1 day.'
    )
  })

  it('invents no window when the server stated no retryAfterDays', () => {
    // A default like `?? 30` is a number the server never sent, printed as a date the user will
    // plan around. Degrade to nothing, never to something wrong.
    expect(licenseSentence(keygen({ error: 'too_soon' }))).toBe(
      'You cannot release devices again yet.'
    )
    expect(licenseSentence(keygen({ error: 'too_soon', retryAfterDays: 0 }))).toBe(
      'You cannot release devices again yet.'
    )
  })

  it('renders not_applicable as a refused action, not as a failed read', () => {
    // Unreachable through the UI (the release action is shown only for a STATED 'keygen' source,
    // and that is the one source the route never answers 400 for), but a route contract is not a
    // render-time guarantee — so it gets a sentence rather than the failed-read one.
    const s = licenseSentence({ key: null, used: 0, seats: 0, source: 'apple', error: 'not_applicable' })
    expect(s).toBe('Releasing devices does not apply to this license.')
    expect(s).not.toContain('Could not read')
  })
})

describe('licenseSentence — before the first read', () => {
  it('says nothing', () => {
    expect(licenseSentence(null)).toBe('')
  })
})

describe('canReleaseDevices', () => {
  it('is true only for a STATED keygen source', () => {
    expect(canReleaseDevices(keygen())).toBe(true)
  })

  it('is false for every other stated source', () => {
    expect(canReleaseDevices({ key: null, used: 0, seats: 0, source: 'apple', error: null })).toBe(
      false
    )
    expect(canReleaseDevices({ key: null, used: 0, seats: 0, source: 'free', error: null })).toBe(
      false
    )
    expect(canReleaseDevices({ key: null, used: 0, seats: 0, source: 'google', error: null })).toBe(
      false
    )
  })

  it('is false when no source was stated — an unknown source HIDES the action', () => {
    // The gate must be `=== 'keygen'`, never `!== 'apple'`: a null source (every error reply, and
    // the release route's own 200) would then SHOW a release the server can only refuse, and a
    // future source word would inherit the button by default. Both of these pass a `!== 'apple'`.
    expect(canReleaseDevices({ key: null, used: 0, seats: 0, source: null, error: 'offline' })).toBe(
      false
    )
    expect(
      canReleaseDevices({
        key: null,
        used: 0,
        seats: 0,
        source: 'ios' as unknown as LicenseDetail['source'],
        error: null
      })
    ).toBe(false)
  })

  it('is false before the first read', () => {
    expect(canReleaseDevices(null)).toBe(false)
  })

  it('stays true while a release is throttled — the action is refused, not inapplicable', () => {
    // The user must still see the button (and the "in N days" sentence beside it); hiding it here
    // would read as "this license cannot release devices at all".
    expect(canReleaseDevices(keygen({ error: 'too_soon', retryAfterDays: 12 }))).toBe(true)
  })
})

describe('canUseKeyElsewhere', () => {
  it('is true while the license still has room', () => {
    expect(canUseKeyElsewhere(keygen({ used: 2, seats: 3 }))).toBe(true)
  })

  it('is false AT the cap — the activation it invites would be refused', () => {
    // This line used to render under "All 3 devices are in use": we told the user to go and paste
    // the key on another machine, where the server answers seat_limit. Advice that cannot work.
    expect(canUseKeyElsewhere(keygen({ used: 3, seats: 3 }))).toBe(false)
  })

  it('is false OVER the cap (a cap lowered after activation)', () => {
    // `used > seats` is further from having room, not closer. A `!==` or a `used === seats` check
    // reads it as "not at the cap" and shows the line again.
    expect(canUseKeyElsewhere(keygen({ used: 4, seats: 3 }))).toBe(false)
  })

  it('is false with no key to paste, whatever the counts say', () => {
    expect(canUseKeyElsewhere(keygen({ key: null, used: 0, seats: 3 }))).toBe(false)
    expect(canUseKeyElsewhere(null)).toBe(false)
  })
})

describe('isReleaseRefusal — which codes are about the LICENSE', () => {
  it('is true for exactly the two the release route answers about the license itself', () => {
    expect(isReleaseRefusal('too_soon')).toBe(true)
    expect(isReleaseRefusal('not_applicable')).toBe(true)
  })

  it('is false for every transport / standing code', () => {
    // These are the codes the release route ALSO produces (core/license.ts). Treating them as
    // refusals is what merged an offline release onto `detail` and rendered it as a failed READ,
    // with a real key sitting in the box above it.
    for (const code of ['unauthorized', 'inactive', 'offline', 'disabled', 'network', 'teapot']) {
      expect(isReleaseRefusal(code), code).toBe(false)
    }
  })

  it('is false for "no error at all"', () => {
    expect(isReleaseRefusal(null)).toBe(false)
    expect(isReleaseRefusal(undefined)).toBe(false)
    expect(isReleaseRefusal('')).toBe(false)
  })
})

describe('releaseFailureSentence', () => {
  it('says nothing when the release did not fail', () => {
    expect(releaseFailureSentence(null)).toBe('')
    expect(releaseFailureSentence(undefined)).toBe('')
  })

  it('says nothing for a refusal — those ride the detail and licenseSentence owns them', () => {
    // Two owners for one message would print the throttle twice, in two different wordings.
    expect(releaseFailureSentence('too_soon')).toBe('')
    expect(releaseFailureSentence('not_applicable')).toBe('')
  })

  it('states that nothing was released when the server ANSWERED and refused', () => {
    expect(releaseFailureSentence('unauthorized')).toBe(
      'Could not release the other devices — this computer is not authorized on this license. Nothing was released.'
    )
    expect(releaseFailureSentence('inactive')).toBe(
      'Could not release the other devices — this license is not active. Nothing was released.'
    )
    expect(releaseFailureSentence('disabled')).toBe(
      'Could not release the other devices — license requests are switched off in this build. Nothing was released.'
    )
  })

  it('does NOT claim nothing happened when the reply was merely lost', () => {
    // The request may have landed and only the answer gone missing. "Nothing was changed" sends
    // the user to a retry that hits the 30-day throttle, having already spent their one release.
    for (const code of ['offline', 'network', 'teapot']) {
      const s = releaseFailureSentence(code)
      expect(s, code).not.toContain('Nothing was released')
      expect(s, code).toContain('may or may not')
      // …and it must say what to do next, including the cost of the ambiguity.
      expect(s, code).toContain('30 days')
    }
  })

  it('never renders the bare code', () => {
    for (const code of ['unauthorized', 'inactive', 'disabled', 'offline', 'network', 'teapot']) {
      // Same rule as the activation copy: what would read as machine output is the snake_case
      // shape, and none of these sentences may carry one.
      expect(releaseFailureSentence(code), code).not.toMatch(/[a-z]+_[a-z]+/)
    }
  })
})

describe('activationErrorSentence', () => {
  it('says nothing when the activation did not fail', () => {
    expect(activationErrorSentence(null)).toBe('')
    expect(activationErrorSentence('')).toBe('')
  })

  it('turns seat_limit into the remedy, and points it at a machine that HAS Pro', () => {
    // The flow this whole feature exists for. It used to dead-end in `Could not activate
    // (seat_limit).` — a word the buyer cannot look up, on the screen where they are stuck.
    const s = activationErrorSentence('seat_limit')
    expect(s).toBe(
      'This license already has all its devices in use. On a computer (or phone) where Pro is active, open Settings → License and choose “Release other devices”, then activate here again.'
    )
    // The release action does not exist on THIS machine (it has no Pro yet), so the sentence must
    // send the user elsewhere — advice to "release below" would point at a button that isn't there.
    expect(s).toContain('where Pro is active')
  })

  it('gives every other named code its own sentence, none of them a code', () => {
    const codes = ['suspended', 'expired', 'not_found', 'invalid', 'offline', 'network', 'disabled']
    const seen = new Set<string>()
    for (const code of codes) {
      const s = activationErrorSentence(code)
      expect(s, code).not.toBe('')
      // A raw reason code is snake_case; English is not. `not.toContain(code)` cannot be used for
      // codes that are also ordinary words ("suspended", "expired"), and this catches the ones
      // that would actually read as machine output.
      expect(s, code).not.toMatch(/[a-z]+_[a-z]+/)
      // Not one apology reused for everything: a shared string would tell an expired license and
      // an offline laptop the same untrue thing.
      seen.add(s)
    }
    // offline and network are deliberately ONE sentence (both mean "we could not check"), so six.
    expect(seen.size).toBe(codes.length - 1)
  })

  it('falls back to an actionable sentence for a code it does not know, printing no code', () => {
    const s = activationErrorSentence('gremlins')
    expect(s).toBe(
      'Could not activate this key. Check it was pasted in full and try again — get in touch if it keeps failing.'
    )
    expect(s).not.toContain('gremlins')
  })
})

describe('proStatusLine — the date is the subscription term or nothing (issue #800)', () => {
  const NOW = Date.UTC(2026, 8, 15, 12) // the day the reporter opened the page
  const WEEK_S = 7 * 24 * 60 * 60
  const pro = (over: Partial<LicenseStatus>): LicenseStatus => ({
    tier: 'pro',
    active: true,
    expiresAt: Math.floor(NOW / 1000) + WEEK_S,
    termEndsAt: null,
    seats: 3,
    error: null,
    ...over
  })

  it('prints no date from the token TTL', () => {
    // The reported screen: a 7-day token beside no stated term used to read "active until 9/22/2026".
    expect(proStatusLine(pro({}), NOW)).toBe('Pro — active.')
  })

  it('prints the term when the server stated one', () => {
    const term = Date.UTC(2027, 8, 13) / 1000
    expect(proStatusLine(pro({ termEndsAt: term }), NOW)).toBe(
      `Pro — active. Current term runs through ${new Date(term * 1000).toLocaleDateString()}.`
    )
  })

  it.each([
    ['null', null],
    ['zero', 0],
    ['NaN', Number.NaN],
    ['in the past', Math.floor(NOW / 1000) - 60]
  ])('a term that is %s prints no date — never an epoch', (_label, termEndsAt) => {
    const line = proStatusLine(pro({ termEndsAt }), NOW)
    expect(line).toBe('Pro — active.')
    expect(line).not.toContain(new Date(0).toLocaleDateString())
  })
})
