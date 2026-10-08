import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WatchLinkView } from '@shared/watch-link-types'
import { formatClock } from './liveLink'
import {
  chatLinkOptionLabels,
  inLiveChatDrawer,
  LIVE_CHAT_LINK_KEY,
  LIVE_CHAT_PINNED_KEY,
  liveChatIsOpen,
  liveChatShown,
  nextLiveChat,
  pickChatLink,
  readLiveChatLink,
  readLiveChatPinned,
  writeLiveChatLink,
  writeLiveChatPinned,
  type LiveChatState
} from './liveChatPin'

const hidden: LiveChatState = { pinned: false, dismissed: false, open: false, linkId: null }
const modal: LiveChatState = { pinned: false, dismissed: false, open: true, linkId: 'A' }
const docked: LiveChatState = { pinned: true, dismissed: false, open: true, linkId: 'A' }
const dockedHidden: LiveChatState = { pinned: true, dismissed: true, open: false, linkId: 'A' }
/** Launch after a previous pin: shown, but `open` was never set this run. */
const launchPinned: LiveChatState = { pinned: true, dismissed: false, open: false, linkId: null }

const link = (linkId: string, createdAt: number): WatchLinkView => ({
  linkId,
  nodeId: 'n',
  role: 'commenter',
  label: 'A',
  title: 't',
  createdAt,
  expiresAt: null,
  url: 'u',
  status: 'live',
  viewers: [],
  control: null
})

afterEach(() => vi.unstubAllGlobals())

describe('liveChatIsOpen', () => {
  it('follows `open` unpinned and `!dismissed` pinned', () => {
    expect(liveChatIsOpen(hidden)).toBe(false)
    expect(liveChatIsOpen(modal)).toBe(true)
    expect(liveChatIsOpen(docked)).toBe(true)
    expect(liveChatIsOpen(dockedHidden)).toBe(false)
    expect(liveChatIsOpen(launchPinned)).toBe(true)
  })
})

describe('liveChatShown (ruling on concern 3)', () => {
  it('pinned: rendered only while at least one link is live — the pin is kept, the drawer comes back', () => {
    expect(liveChatShown(docked, 0)).toBe(false)
    expect(liveChatShown(launchPinned, 0)).toBe(false)
    expect(liveChatShown(docked, 1)).toBe(true)
    expect(liveChatShown(launchPinned, 3)).toBe(true)
    // Dismissed stays hidden whatever the links.
    expect(liveChatShown(dockedHidden, 2)).toBe(false)
  })
  it('unpinned: an explicit open shows even with no live link ("No live links.")', () => {
    expect(liveChatShown(modal, 0)).toBe(true)
    expect(liveChatShown(hidden, 0)).toBe(false)
    expect(liveChatShown(hidden, 2)).toBe(false)
  })
})

describe('nextLiveChat', () => {
  it('open shows the drawer, on the named link when there is one, and keeps the pin', () => {
    expect(nextLiveChat(hidden, { kind: 'open', linkId: 'B' })).toEqual({ pinned: false, dismissed: false, open: true, linkId: 'B' })
    // No link named (the palette): the last link stays.
    expect(nextLiveChat({ ...hidden, linkId: 'A' }, { kind: 'open' })).toEqual({ ...modal, linkId: 'A' })
    expect(nextLiveChat(dockedHidden, { kind: 'open', linkId: 'C' })).toEqual({ pinned: true, dismissed: false, open: true, linkId: 'C' })
  })

  it('close hides without touching the pin or the link', () => {
    expect(nextLiveChat(modal, { kind: 'close' })).toEqual({ pinned: false, dismissed: true, open: false, linkId: 'A' })
    expect(nextLiveChat(docked, { kind: 'close' })).toEqual({ pinned: true, dismissed: true, open: false, linkId: 'A' })
  })

  it('toggle flips what is on screen, the launch-pinned case included', () => {
    expect(liveChatIsOpen(nextLiveChat(hidden, { kind: 'toggle' }))).toBe(true)
    expect(liveChatIsOpen(nextLiveChat(modal, { kind: 'toggle' }))).toBe(false)
    expect(liveChatIsOpen(nextLiveChat(docked, { kind: 'toggle' }))).toBe(false)
    expect(liveChatIsOpen(nextLiveChat(dockedHidden, { kind: 'toggle' }))).toBe(true)
    expect(liveChatIsOpen(nextLiveChat(launchPinned, { kind: 'toggle' }))).toBe(false)
  })

  it('pin docks and shows; unpinning a visible drawer keeps it on screen as the modal', () => {
    expect(nextLiveChat(modal, { kind: 'pin' })).toEqual({ pinned: true, dismissed: false, open: true, linkId: 'A' })
    expect(nextLiveChat(hidden, { kind: 'pin' })).toEqual({ pinned: true, dismissed: false, open: true, linkId: null })
    // If unpinning only flipped `pinned`, the launch-pinned drawer (open never set) would vanish.
    expect(nextLiveChat(launchPinned, { kind: 'pin' })).toEqual({ pinned: false, dismissed: false, open: true, linkId: null })
    expect(nextLiveChat(docked, { kind: 'pin' })).toEqual({ pinned: false, dismissed: false, open: true, linkId: 'A' })
    expect(nextLiveChat(dockedHidden, { kind: 'pin' })).toEqual({ pinned: false, dismissed: false, open: false, linkId: 'A' })
  })
})

describe('pickChatLink', () => {
  it('the wanted link while it is live', () => {
    expect(pickChatLink([link('A', 1), link('B', 2)], 'A')).toBe('A')
  })
  it('else the most recent link (by creation), ties going to the later one in the list', () => {
    expect(pickChatLink([link('A', 1), link('B', 3), link('C', 2)], 'gone')).toBe('B')
    expect(pickChatLink([link('A', 1), link('B', 3), link('C', 2)], null)).toBe('B')
    expect(pickChatLink([link('A', 5), link('B', 5)], null)).toBe('B')
  })
  it('nothing when no link is live', () => {
    expect(pickChatLink([], 'A')).toBeNull()
    expect(pickChatLink([], null)).toBeNull()
  })
})

describe('chatLinkOptionLabels (ruling on concern 6: every option reads differently)', () => {
  const l = (linkId: string, over: Partial<WatchLinkView> = {}): WatchLinkView => ({ ...link(linkId, 0), ...over })

  it('a unique title and role reads "{title} · {role}"', () => {
    expect(
      chatLinkOptionLabels([
        l('A', { title: 'build', role: 'commenter' }),
        l('B', { title: 'build', role: 'controller' }),
        l('C', { title: 'api-\u202Eserver', role: 'viewer' }),
        l('D', { title: '  ', role: 'viewer' })
      ])
    ).toEqual(['build · Commenter', 'build · Control', 'api-server · Viewer', 'Terminal · Viewer'])
  })

  it('two that read the same are told apart by their own label, when that differs', () => {
    expect(
      chatLinkOptionLabels([
        l('A', { title: 'build', label: 'Ada' }),
        l('B', { title: 'build', label: 'Team \u202Edemo' })
      ])
    ).toEqual(['build · Commenter · shown as Ada', 'build · Commenter · shown as Team demo'])
  })

  it('still the same: the start time is appended ("· since 14:05")', () => {
    const t1 = Date.UTC(2026, 9, 3, 12, 5)
    const t2 = Date.UTC(2026, 9, 3, 13, 40)
    expect(
      chatLinkOptionLabels([
        l('A', { title: 'build', label: 'Ada', createdAt: t1 }),
        l('B', { title: 'build', label: 'Ada', createdAt: t2 }),
        l('C', { title: 'logs', label: 'Ada', createdAt: t2 })
      ])
    ).toEqual([
      // The same label tells nothing apart, so it is not added.
      `build · Commenter · since ${formatClock(t1)}`,
      `build · Commenter · since ${formatClock(t2)}`,
      'logs · Commenter'
    ])
    // A label that differs AND a start time, where only the time separates two of three.
    expect(
      chatLinkOptionLabels([
        l('A', { title: 'build', label: 'Ada', createdAt: t1 }),
        l('B', { title: 'build', label: 'Ada', createdAt: t2 }),
        l('C', { title: 'build', label: 'Team', createdAt: t2 })
      ])
    ).toEqual([
      `build · Commenter · shown as Ada · since ${formatClock(t1)}`,
      `build · Commenter · shown as Ada · since ${formatClock(t2)}`,
      'build · Commenter · shown as Team'
    ])
  })

  it('even started the same minute, every label is unique', () => {
    const t = Date.UTC(2026, 9, 3, 12, 5)
    const labels = chatLinkOptionLabels([l('A', { createdAt: t }), l('B', { createdAt: t }), l('C', { createdAt: t })])
    expect(new Set(labels).size).toBe(3)
    expect(labels).toEqual(['t · Commenter', 't · Commenter (2)', 't · Commenter (3)'])
  })
})

describe('inLiveChatDrawer', () => {
  it('anything inside the drawer, nothing outside; non-elements are outside', () => {
    expect(inLiveChatDrawer(null)).toBe(false)
    expect(inLiveChatDrawer({} as EventTarget)).toBe(false)
    const inside = { closest: (sel: string) => (sel === '[data-live-chat-drawer]' ? {} : null) }
    const outside = { closest: () => null }
    expect(inLiveChatDrawer(inside as unknown as EventTarget)).toBe(true)
    expect(inLiveChatDrawer(outside as unknown as EventTarget)).toBe(false)
  })
})

describe('storage', () => {
  it('pin: reads and writes its own key as 1/0, off by default', () => {
    const store: Record<string, string> = {}
    const get = (k: string): string | null => store[k] ?? null
    const set = (k: string, v: string): void => void (store[k] = v)
    expect(readLiveChatPinned(get)).toBe(false)
    writeLiveChatPinned(true, set)
    expect(store[LIVE_CHAT_PINNED_KEY]).toBe('1')
    expect(readLiveChatPinned(get)).toBe(true)
    writeLiveChatPinned(false, set)
    expect(store[LIVE_CHAT_PINNED_KEY]).toBe('0')
    expect(readLiveChatPinned(get)).toBe(false)
    expect(LIVE_CHAT_PINNED_KEY).toBe('nodeterm.liveChatPinned')
  })

  it('the last link: remembered under its own key; an empty or non-string value is no link', () => {
    const store: Record<string, string> = {}
    const get = (k: string): string | null => store[k] ?? null
    const set = (k: string, v: string): void => void (store[k] = v)
    expect(readLiveChatLink(get)).toBeNull()
    writeLiveChatLink('L1', set)
    expect(store[LIVE_CHAT_LINK_KEY]).toBe('L1')
    expect(readLiveChatLink(get)).toBe('L1')
    store[LIVE_CHAT_LINK_KEY] = ''
    expect(readLiveChatLink(get)).toBeNull()
    expect(LIVE_CHAT_LINK_KEY).toBe('nodeterm.liveChatLink')
  })

  it('a throwing localStorage (private window, blocked site data) reads as nothing and never throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      }
    }
    vi.stubGlobal('localStorage', throwing)
    expect(readLiveChatPinned()).toBe(false)
    expect(readLiveChatLink()).toBeNull()
    expect(() => writeLiveChatPinned(true)).not.toThrow()
    expect(() => writeLiveChatLink('L')).not.toThrow()
  })

  it('a missing localStorage (no DOM) reads as nothing too', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(readLiveChatPinned()).toBe(false)
    expect(readLiveChatLink()).toBeNull()
    expect(() => writeLiveChatPinned(true)).not.toThrow()
  })
})
