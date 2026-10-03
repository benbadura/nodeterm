// Which of a hosted team's shared projects this desktop shows as tabs, and how a share change moves
// them. Pure.
//
// `shown` is the team's open tabs in the host's order; `dismissed` is what the user closed by hand
// while it stayed shared. A dismissed project is never reopened by a later share event (the user
// said no to that tab), but the moment the host stops sharing it the dismissal is forgotten, so a
// re-share opens it again like any newly shared project.
//
// The host's list arrives off the wire, so it is cleaned before it is trusted: only non-empty
// strings of a sane length, de-duplicated, capped.

export interface HostedTabSet {
  shown: string[]
  dismissed: string[]
}

export const EMPTY_TAB_SET: HostedTabSet = Object.freeze({ shown: [], dismissed: [] }) as HostedTabSet

const MAX = 256

/** The host's project ids, made safe to act on: non-empty strings of at most 128 characters,
 *  first occurrence kept, at most 256. */
export const cleanSharedIds = (ids: readonly unknown[]): string[] =>
  [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 128))].slice(0, MAX)

/** The host now shares `shared`: which tabs to open (new and not dismissed), which to close (shown
 *  but no longer shared), and the set after both. */
export function planSharedChange(
  set: HostedTabSet,
  shared: readonly string[]
): { open: string[]; close: string[]; next: HostedTabSet } {
  const ids = cleanSharedIds(shared)
  const open = ids.filter((id) => !set.shown.includes(id) && !set.dismissed.includes(id))
  const close = set.shown.filter((id) => !ids.includes(id))
  return {
    open,
    close,
    next: {
      shown: ids.filter((id) => set.shown.includes(id) || open.includes(id)),
      dismissed: set.dismissed.filter((id) => ids.includes(id))
    }
  }
}

/** The user closed one of the team's tabs: stop showing it and remember not to reopen it. */
export function dismissTab(set: HostedTabSet, projectId: string): HostedTabSet {
  return {
    shown: set.shown.filter((id) => id !== projectId),
    dismissed: set.dismissed.includes(projectId) ? set.dismissed : [...set.dismissed, projectId]
  }
}
