// The Live chat drawer's visibility: the Explorer drawer's pin pattern (lib/explorerPin.ts), with its
// own keys. This machine only, in localStorage — never settings.json or project.json: which link the
// owner follows is one person's view state, and a live link is not canvas content.
//
//   pinned    — persisted preference: docked, does not block the canvas (default off)
//   dismissed — transient "hide for now" (the ×). Does NOT clear the pin.
//   open      — unpinned (modal) visibility
//   linkId    — the link the owner picked last (Open chat on a chip, the drawer's picker). The drawer
//               shows it while it is live, else the most recent link (`pickChatLink`).
import type { WatchLinkView } from '@shared/watch-link-types'
import { stripBidiControls } from '@shared/watch-link-types'
import { formatClock, ROLE_NAME } from './liveLink'

export const LIVE_CHAT_PINNED_KEY = 'nodeterm.liveChatPinned'
export const LIVE_CHAT_LINK_KEY = 'nodeterm.liveChatLink'

export interface LiveChatState {
  pinned: boolean
  dismissed: boolean
  open: boolean
  linkId: string | null
}

export type LiveChatAction = { kind: 'open'; linkId?: string } | { kind: 'toggle' } | { kind: 'close' } | { kind: 'pin' }

/** Pinned: shown unless dismissed. Unpinned: `open` is the modal flag. */
export function liveChatIsOpen(s: LiveChatState): boolean {
  return s.pinned ? !s.dismissed : s.open
}

/**
 * Whether the drawer is RENDERED. A pinned drawer is docked chrome: with no live link it would be an
 * empty card taking canvas width (and inset every maximize for nothing), so it shows only while at
 * least one link is live — the pin is kept and it comes back with the next link. An unpinned drawer
 * the owner explicitly opened shows even with none ("No live links.").
 */
export function liveChatShown(s: LiveChatState, liveLinks: number): boolean {
  return liveChatIsOpen(s) && (!s.pinned || liveLinks > 0)
}

export function nextLiveChat(s: LiveChatState, a: LiveChatAction): LiveChatState {
  switch (a.kind) {
    case 'open':
      return { ...s, dismissed: false, open: true, linkId: a.linkId ?? s.linkId }
    case 'close':
      return { ...s, dismissed: true, open: false }
    case 'toggle':
      return liveChatIsOpen(s) ? { ...s, dismissed: true, open: false } : { ...s, dismissed: false, open: true }
    case 'pin':
      // (Re)pinning shows the docked drawer. Unpinning a visible drawer keeps it on screen as the
      // modal even when `open` was never set — the launch-pinned case (`pinned && !dismissed`).
      return s.pinned
        ? { ...s, pinned: false, dismissed: false, open: liveChatIsOpen(s) }
        : { ...s, pinned: true, dismissed: false, open: true }
  }
}

/** The link to show: `wanted` while it is live, else the most recently created one (a tie goes to the
 *  later one in the list), else none. */
export function pickChatLink(links: readonly WatchLinkView[], wanted: string | null): string | null {
  if (wanted !== null && links.some((l) => l.linkId === wanted)) return wanted
  let best: WatchLinkView | null = null
  for (const l of links) if (!best || l.createdAt >= best.createdAt) best = l
  return best ? best.linkId : null
}

/**
 * The picker's option per link, in list order — every one reads differently. "{title} · {role}"; two
 * that read the same add the link's own label ("· shown as Ada" — the name viewers see for the
 * owner, so only where it differs between them); still the same, the start time ("· since 14:05");
 * still the same (started the same minute), a counter. Titles and labels are bidi-stripped.
 */
export function chatLinkOptionLabels(links: readonly WatchLinkView[]): string[] {
  /** Within each group of identical labels, append `extra` — unless it is the same for the whole
   *  group, where it would tell nothing apart. */
  const disambiguate = (labels: string[], extra: (l: WatchLinkView) => string): string[] => {
    const groups = new Map<string, Set<string>>()
    labels.forEach((t, i) => groups.set(t, (groups.get(t) ?? new Set()).add(extra(links[i]))))
    return labels.map((t, i) => {
      const extras = groups.get(t)!
      if (labels.filter((x) => x === t).length < 2 || extras.size < 2) return t
      const more = extra(links[i])
      return more ? `${t} · ${more}` : t
    })
  }
  let labels = links.map((l) => `${stripBidiControls(l.title).trim() || 'Terminal'} · ${ROLE_NAME[l.role]}`)
  labels = disambiguate(labels, (l) => {
    const label = stripBidiControls(l.label).trim()
    return label ? `shown as ${label}` : ''
  })
  labels = disambiguate(labels, (l) => `since ${formatClock(l.createdAt)}`)
  const seen = new Map<string, number>()
  return labels.map((t) => {
    const n = (seen.get(t) ?? 0) + 1
    seen.set(t, n)
    return n === 1 ? t : `${t} (${n})`
  })
}

/** The attribute that marks the drawer's root, so other surfaces can leave its keys alone. */
export const LIVE_CHAT_DRAWER_ATTR = 'data-live-chat-drawer'

/**
 * Is this event target inside the Live chat drawer? The kanban card modal's capture-phase Escape asks:
 * a raised, pinned drawer is not a dialog, so the card modal under it is the top dialog — and closed
 * itself on an Escape the owner typed in the drawer's reply box.
 */
export function inLiveChatDrawer(target: EventTarget | null): boolean {
  const el = target as { closest?: unknown } | null
  return !!el && typeof el.closest === 'function' && (el as Element).closest(`[${LIVE_CHAT_DRAWER_ATTR}]`) !== null
}

const getStored = (key: string): string | null => localStorage.getItem(key)
const setStored = (key: string, value: string): void => localStorage.setItem(key, value)

/** `'1'` is pinned; missing, `'0'`, unreadable storage or anything else is not. */
export function readLiveChatPinned(getItem: (key: string) => string | null = getStored): boolean {
  try {
    return getItem(LIVE_CHAT_PINNED_KEY) === '1'
  } catch {
    return false
  }
}

export function writeLiveChatPinned(v: boolean, setItem: (key: string, value: string) => void = setStored): void {
  try {
    setItem(LIVE_CHAT_PINNED_KEY, v ? '1' : '0')
  } catch {
    /* private window / blocked storage: the pin is a nicety, never fail the UI */
  }
}

/** The last picked link id, or null (none, empty, unreadable storage). */
export function readLiveChatLink(getItem: (key: string) => string | null = getStored): string | null {
  try {
    const v = getItem(LIVE_CHAT_LINK_KEY)
    return typeof v === 'string' && v !== '' ? v : null
  } catch {
    return null
  }
}

export function writeLiveChatLink(linkId: string, setItem: (key: string, value: string) => void = setStored): void {
  try {
    setItem(LIVE_CHAT_LINK_KEY, linkId)
  } catch {
    /* not remembered: the drawer falls back to the most recent link */
  }
}
