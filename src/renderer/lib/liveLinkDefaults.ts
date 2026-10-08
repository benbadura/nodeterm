// The live-link dialog's remembered choices: the role and the expiry of the last link this person
// CREATED, so a person who shares the same way every time (a Control link for pairing, say) is one
// click from it. Same storage family as the explorer pin (`nodeterm.explorerPinned`): this machine
// only, never settings.json or project.json.
//
// Only the two choices are kept. Never the password (a Control link's plaintext lives in the
// dialog's state alone) and never the label (it comes from the presence name). A first-ever dialog,
// and every value that does not parse, falls back to `can watch` for an hour: remembering may bring
// back a Control link, never invent one.
import type { WatchLinkRole } from '@shared/watch-link/protocol'
import { DEFAULT_WATCH_LINK_TTL, WATCH_LINK_TTLS, type WatchLinkTtl } from '@shared/watch-link-types'

export const LIVE_LINK_DEFAULTS_KEY = 'nodeterm.liveLinkDefaults'

export interface LiveLinkDefaults {
  role: WatchLinkRole
  ttl: WatchLinkTtl
}

export const FIRST_LIVE_LINK_DEFAULTS: LiveLinkDefaults = { role: 'viewer', ttl: DEFAULT_WATCH_LINK_TTL }

const ROLES: readonly WatchLinkRole[] = ['viewer', 'commenter', 'controller']

/** Each field on its own: a role this build does not know keeps a good expiry, and the reverse. */
export function parseLiveLinkDefaults(raw: string | null): LiveLinkDefaults {
  if (!raw) return FIRST_LIVE_LINK_DEFAULTS
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return FIRST_LIVE_LINK_DEFAULTS
  }
  const o = v && typeof v === 'object' ? (v as { role?: unknown; ttl?: unknown }) : {}
  const role = ROLES.find((r) => r === o.role) ?? FIRST_LIVE_LINK_DEFAULTS.role
  const ttl = WATCH_LINK_TTLS.find((t) => t === o.ttl) ?? FIRST_LIVE_LINK_DEFAULTS.ttl
  return { role, ttl }
}

export function loadLiveLinkDefaults(
  getItem: (key: string) => string | null = (key) => localStorage.getItem(key)
): LiveLinkDefaults {
  try {
    return parseLiveLinkDefaults(getItem(LIVE_LINK_DEFAULTS_KEY))
  } catch {
    // Private mode, blocked site data: the first-ever defaults, never a broken dialog.
    return FIRST_LIVE_LINK_DEFAULTS
  }
}

export function saveLiveLinkDefaults(
  d: LiveLinkDefaults,
  setItem: (key: string, value: string) => void = (key, value) => localStorage.setItem(key, value)
): void {
  try {
    setItem(LIVE_LINK_DEFAULTS_KEY, JSON.stringify({ role: d.role, ttl: d.ttl }))
  } catch {
    /* a convenience: a failed write only means the next dialog opens on the first-ever defaults */
  }
}
