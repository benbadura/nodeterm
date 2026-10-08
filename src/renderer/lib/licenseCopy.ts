import type { LicenseDetail, LicenseStatus } from '@shared/types'
import { machineNoun, thisMachine, thisMachineCap } from './machineName'

/**
 * Settings → License wording, derived from the data in ONE place so a sentence cannot promise
 * something the numbers do not say.
 *
 * Three facts shape the branches below:
 *
 * 1. **A reason code is either about the LICENSE or about the CALL, and both arrive in the same
 *    `error` field.** A refused RELEASE (`too_soon` | `not_applicable`) is about the license: it
 *    rides on top of the LAST GOOD read, so its key, source and counts are real, and it belongs
 *    beside them. Everything else — `unauthorized` | `inactive` | `offline` | `disabled` |
 *    `network` — is about a call that did not deliver, and the route it failed on decides what to
 *    say: on a READ it means the key and counts are unknown, on a RELEASE it means the action did
 *    not happen (and, offline, may or may not have). The store therefore never merges a release's
 *    transport failure onto `detail` (it hands the code back instead), and `releaseFailureSentence`
 *    is the one place that speaks for it. `isReleaseRefusal` is the shared split so the store and
 *    the panel cannot disagree about which family a code is in.
 * 2. **"Your Pro access is unaffected" is a forward-looking promise, so only codes that back it may
 *    say it.** `offline`/`network`/`disabled` mean we could not look — the entitlement is verified
 *    locally and nothing changed. `inactive`/`unauthorized` are ANSWERS that this license is not in
 *    good standing, and the very next refresh may drop Pro; telling that user they are unaffected
 *    is the same class of lie as rendering a placeholder zero as a device count.
 * 3. **Seats and devices are the same thing by design**, so the copy says "devices" and names
 *    phones explicitly — a paired phone holds a seat too, and a user who does not know that reads
 *    the cap as broken.
 */
export function licenseSentence(detail: LicenseDetail | null): string {
  if (!detail) return '' // Before the first read there is nothing to say.

  if (detail.error) {
    // --- The read was FINE, the release was refused on terms about the license itself. ----------
    if (detail.error === 'too_soon') {
      const days = detail.retryAfterDays
      // No `?? 30` fallback: a window the server never stated is a date the user would plan
      // around. Degrade to the shape of the fact we do have ("not yet"), never to a made-up number.
      if (typeof days === 'number' && Number.isFinite(days) && days > 0) {
        return `You can release devices again in ${days} ${days === 1 ? 'day' : 'days'}.`
      }
      return 'You cannot release devices again yet.'
    }
    if (detail.error === 'not_applicable') {
      // The panel only offers the release for a stated 'keygen' source, and that is the one source
      // the route never refuses this way — so this should be unreachable. It still gets its own
      // sentence rather than falling into the failed-read one, because a route contract is not a
      // render-time guarantee and "we could not read your license" would be a false alarm.
      return 'Releasing devices does not apply to this license.'
    }

    // --- The READ failed. The counts beside this are placeholders, not a measurement. -----------
    // A RELEASE failure never reaches here: the store keeps those off `detail` (see the module doc
    // and `isReleaseRefusal`), because "could not read this license" printed over a real key and
    // real counts is false in both halves.
    if (detail.error === 'inactive') {
      // A server ANSWER, not a failure to look. Pro is verified locally so it still works right
      // now, and saying "unaffected" would promise it keeps working — which it will not.
      return `This license is not active, so there is no key or device count to show — and Pro on ${thisMachine()} will stop when its current entitlement expires.`
    }
    if (detail.error === 'unauthorized') {
      // Also an answer: the server refused this machine's entitlement. It may recover on the next
      // refresh, hence "may" — but it is not the "nothing changed" story the codes below tell.
      return `${thisMachineCap()} is not authorized on this license, so the key and device count are unavailable — and Pro here may stop when its current entitlement expires.`
    }
    if (detail.error === 'offline' || detail.error === 'network' || detail.error === 'disabled') {
      // Deliberately not "could not reach the server": `disabled` is a build that never asked.
      // What is true across these three is that we did not get to LOOK — and that Pro keeps
      // working either way, because the entitlement is verified locally.
      return 'Could not read this license right now, so the key and device count are unknown. Your Pro access is unaffected.'
    }
    // An unrecognized code. Say the part that is certainly true and make no promise we cannot back.
    return 'Could not read this license right now, so the key and device count are unknown.'
  }

  // --- A clean read. What can be said depends entirely on the source the SERVER stated. ---------
  if (detail.source === 'apple') {
    // No keygen call was made for this license, so `used`/`seats` are zeros meaning "not
    // applicable". Printing them would read as a cap that is somehow both empty and full.
    // Say where the term actually lives. We can neither renew, extend nor cancel an App Store
    // subscription, and a user who wants to know when it renews has only one place to look.
    return `Pro on ${thisMachine()} comes from the App Store subscription on your paired phone, so there is no license key or device count to show here. That subscription is managed by Apple, not by nodeterm: to see when it renews or to cancel it, open the App Store on that phone and go to Subscriptions in your account.`
  }
  if (detail.source === 'google') {
    // The Play twin of the App Store branch above, for the same reasons: the zeros are "not
    // applicable", and the term is managed by Google — we cannot renew, extend or cancel it.
    return `Pro on ${thisMachine()} comes from the Google Play subscription on your paired phone, so there is no license key or device count to show here. That subscription is managed by Google, not by nodeterm: to see when it renews or to cancel it, open the Play Store on that phone and go to Payments & subscriptions → Subscriptions.`
  }
  if (detail.source === 'free') {
    // A defensive value. Say only what is certain — where it came from is not.
    return 'Pro on this device is not backed by a license key.'
  }
  if (detail.source === 'keygen') {
    if (!detail.key) {
      // Legitimate on a 200: a keygen policy that hides keys, or a license predating the column.
      // This is the only case in which this sentence is true.
      return 'No key is on file for this license yet — get in touch and we will send yours.'
    }
    if (detail.used > detail.seats) {
      // Reachable: a cap lowered after activation. "All N devices are in use" would understate it.
      return `${detail.used} devices are in use, more than the ${detail.seats} this license allows. Release the others below to free them up.`
    }
    if (detail.used === detail.seats) {
      return `All ${detail.seats} devices are in use. Release the others below to free them up.`
    }
    return `${detail.used} of ${detail.seats} devices in use — ${thisMachine()} and each paired phone counts as a device.`
  }

  // A clean read that stated no source (only reachable by merging a release reply over an empty
  // detail). The counts may be real, but with no source there is no sentence they support.
  return ''
}

/**
 * The one-line Pro status at the top of Settings → License.
 *
 * It prints a date ONLY from `termEndsAt` — the subscription term the server stated — and never from
 * `expiresAt`. That field is the entitlement token's expiry: a 7-day offline grace window re-minted
 * every 6 h. Rendered as "active until", it told a customer on a yearly App Store subscription that
 * Pro ended a week later (issue #800). No other date may stand in for a missing term: not the token's,
 * not one computed from the tier, not the grace window under another label.
 *
 * No term ⇒ no date. That covers null (a lifetime entitlement, a license without an expiry, a server
 * that predates the field) and a term already in the past (a stored term from before an offline
 * stretch; the renewal it missed is real, the date it would print is not).
 */
export function proStatusLine(status: LicenseStatus, now: number = Date.now()): string {
  const term = status.termEndsAt
  if (typeof term !== 'number' || !Number.isFinite(term) || term <= 0 || term * 1000 <= now) {
    return 'Pro — active.'
  }
  return `Pro — active. Current term runs through ${new Date(term * 1000).toLocaleDateString()}.`
}

/**
 * Whether to offer "Release other devices".
 *
 * Gated on a STATED `'keygen'` — never on `!== 'apple'`. A null source is what every error reply
 * and the release route's own 200 carry, and a source word added later would inherit the button by
 * default; both would offer an action the server can only refuse. A refused release (`too_soon`)
 * still returns true: the action exists, it is merely throttled, and the sentence beside it says so.
 */
export function canReleaseDevices(detail: LicenseDetail | null): boolean {
  return detail?.source === 'keygen'
}

/**
 * Whether to tell the user they can paste this key on another Mac.
 *
 * A key with no free device is an invitation to an activation that CANNOT succeed — the server
 * answers `seat_limit` and the user is left holding a key and an error. So the line appears only
 * while the license has room. `used > seats` (a cap lowered after activation) is over the cap, not
 * under it, and is excluded by the same comparison.
 */
export function canUseKeyElsewhere(detail: LicenseDetail | null): boolean {
  return !!detail?.key && detail.used < detail.seats
}

/**
 * Is this reason code a REFUSAL of the release (about the license), rather than a failure of the
 * call (about the network / this machine's standing)?
 *
 * The store asks this to decide what may be merged onto `detail`, and the panel's release note is
 * the complement of it. One definition, because two copies of "which codes are refusals" is
 * exactly how a transport failure ended up rendered as "could not read this license".
 */
export function isReleaseRefusal(code: string | null | undefined): boolean {
  return code === 'too_soon' || code === 'not_applicable'
}

/**
 * What to tell the user when "Release other devices" did not deliver.
 *
 * Two families, and conflating them is the whole point of this function existing:
 *  - the server ANSWERED and refused (`unauthorized` | `inactive`) or we never asked (`disabled`)
 *    ⇒ nothing was released, and we can say so.
 *  - the reply never arrived (`offline` | `network`, and any code we do not recognize) ⇒ the
 *    request may well have LANDED. Claiming "nothing was changed" there sends the user to a retry
 *    that hits the 30-day throttle, having already spent their release.
 *
 * A refusal code returns '' — those ride `detail` and `licenseSentence` speaks for them. One owner
 * per message; two would print the throttle twice.
 */
export function releaseFailureSentence(code: string | null | undefined): string {
  if (!code || isReleaseRefusal(code)) return ''
  if (code === 'unauthorized') {
    return `Could not release the other devices — ${thisMachine()} is not authorized on this license. Nothing was released.`
  }
  if (code === 'inactive') {
    return 'Could not release the other devices — this license is not active. Nothing was released.'
  }
  if (code === 'disabled') {
    return 'Could not release the other devices — license requests are switched off in this build. Nothing was released.'
  }
  return 'Could not confirm the release — the server could not be reached, so the other devices may or may not have been released. Close and reopen Settings to see the current device count; if the release did land, the next one is only possible after 30 days.'
}

/**
 * What to tell someone whose key would not activate.
 *
 * The codes come from the server verbatim (`core/license.ts` keeps them), and rendering them
 * verbatim is what left the flow this whole feature exists for — a buyer at the device cap —
 * dead-ended in `Could not activate (seat_limit).` Every branch below names an ACTION; the
 * fallback names one too, and never prints the code, because a word the user cannot look up is
 * worse than a plain apology.
 */
export function activationErrorSentence(code: string | null | undefined): string {
  if (!code) return ''
  if (code === 'seat_limit') {
    // The one code this feature was built around. The remedy lives on a machine that HAS Pro —
    // this one does not, so "release devices here" would be advice the user cannot follow.
    return `This license already has all its devices in use. On a ${machineNoun()} (or phone) where Pro is active, open Settings → License and choose “Release other devices”, then activate here again.`
  }
  if (code === 'suspended') {
    return 'This license has been suspended, so it cannot be activated. Get in touch and we will sort it out.'
  }
  if (code === 'expired') {
    return 'This license has expired. Renew it and then activate again.'
  }
  if (code === 'not_found') {
    return 'No license was found for that key. Check it was pasted in full, or copy it again from your purchase email.'
  }
  if (code === 'invalid') {
    return 'That is not a valid license key. Check it was pasted in full, or copy it again from your purchase email.'
  }
  if (code === 'offline' || code === 'network') {
    return 'Could not reach the server, so the key could not be checked. Check your connection and try again.'
  }
  if (code === 'disabled') {
    return 'License activation is switched off in this build.'
  }
  return 'Could not activate this key. Check it was pasted in full and try again — get in touch if it keeps failing.'
}
