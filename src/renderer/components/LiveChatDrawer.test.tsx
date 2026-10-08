// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatchChatMessage, WatchLinkView } from '@shared/watch-link-types'
import { CHAT_TEXT_MAX } from '@shared/watch-link/protocol'
import { LiveChatDrawer } from './LiveChatDrawer'
import { liveChipSig, useWatchLinks } from '../state/watchLinks'
import { openDialogCount, popDialog, pushDialog, resetDialogStack } from './dialog-stack'
import {
  CHAT_NOT_SENT_MESSAGE,
  CONTROL_CHANGE_UNSAVED_MESSAGE,
  CONTROL_LOCKED_TEXT,
  KICK_CONTROLLER_NOTE,
  KICK_NOT_DONE_MESSAGE,
  KICK_NOTE
} from '../lib/liveLink'
import { chatNameColor } from '../lib/liveChatLook'

// Spied, with the real implementation: how often the message list was RENDERED (one call per line).
vi.mock('../lib/liveChatLook', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/liveChatLook')>()
  return { ...real, chatNameColor: vi.fn(real.chatNameColor) }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const link = (over: Partial<WatchLinkView> = {}): WatchLinkView => ({
  linkId: 'L',
  nodeId: 'n1',
  role: 'commenter',
  label: 'Ada',
  title: 'build',
  createdAt: 0,
  expiresAt: null,
  url: 'https://nodeterm.dev/s/L#1.secret',
  status: 'live',
  viewers: [],
  control: null,
  ...over
})
const msg = (id: string, over: Partial<WatchChatMessage> = {}): WatchChatMessage => ({
  id,
  name: 'Bob',
  text: 'hello',
  at: Number(id),
  from: 'viewer',
  ...over
})

const api = {
  revoke: vi.fn(async (_id: string) => {}),
  kick: vi.fn(async (_l: string, _v: string) => true),
  sendChat: vi.fn(async (_l: string, t: string): Promise<WatchChatMessage | null> => ({
    id: 's',
    name: 'Ada',
    text: t,
    at: 0,
    from: 'sharer'
  })),
  chatHistory: vi.fn(async (_l: string): Promise<WatchChatMessage[]> => []),
  setControl: vi.fn(async (_l: string, _on: boolean): Promise<boolean | 'unsaved'> => true),
  setPassword: vi.fn(async (_l: string, _pw: string): Promise<boolean | 'unsaved'> => true),
  allowControl: vi.fn(async (_l: string) => true)
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  resetDialogStack()
  useWatchLinks.setState({ links: [], byNode: {}, chats: {}, unread: {}, hydrated: false })
  for (const f of Object.values(api)) f.mockClear()
  api.kick.mockImplementation(async () => true)
  api.sendChat.mockImplementation(async (_l: string, t: string) => ({ id: 's', name: 'Ada', text: t, at: 0, from: 'sharer' }))
  api.setPassword.mockImplementation(async () => true)
  // A focused, visible window: someone can see the drawer (the read-state rule, useLinkThread).
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { watchLink: api, clipboard: { writeText: vi.fn() } }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  resetDialogStack()
  vi.restoreAllMocks()
  delete (document as { visibilityState?: unknown }).visibilityState
})

const noop = (): void => {}
const props = (over: Partial<Parameters<typeof LiveChatDrawer>[0]> = {}): Parameters<typeof LiveChatDrawer>[0] => ({
  linkId: 'L',
  pinned: false,
  raised: false,
  onPickLink: noop,
  onClose: noop,
  onTogglePin: noop,
  onGoToNode: noop,
  ...over
})
const render = (p: Parameters<typeof LiveChatDrawer>[0]): void => act(() => root.render(<LiveChatDrawer {...p} />))
const setLinks = (links: WatchLinkView[]): void => act(() => useWatchLinks.getState().setLinks(links))
const addChat = (linkId: string, m: WatchChatMessage): void => act(() => useWatchLinks.getState().addChat(linkId, m))
const drawer = (): HTMLElement => document.querySelector<HTMLElement>('.live-chat')!
const overlay = (): HTMLElement => document.querySelector<HTMLElement>('.drawer-overlay')!
const click = (el: Element): void => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const button = (label: string): HTMLButtonElement =>
  [...drawer().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!
const flush = (): Promise<void> => act(async () => {})
const type = (input: HTMLInputElement, value: string): void =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
/** A key with nothing focused: its target is the body. */
const keydown = (key: string): void =>
  act(() => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))

describe('LiveChatDrawer', () => {
  it('is the Explorer drawer: titled Live chat, a pin button with aria-pressed, and a close', () => {
    setLinks([link()])
    const onClose = vi.fn()
    const onTogglePin = vi.fn()
    render(props({ onClose, onTogglePin }))
    expect(drawer().classList.contains('drawer')).toBe(true)
    expect(drawer().querySelector('.drawer__head h2')?.textContent).toBe('Live chat')
    const pin = drawer().querySelector<HTMLButtonElement>('button[aria-label="Pin"]')!
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    click(pin)
    expect(onTogglePin).toHaveBeenCalledTimes(1)
    click(drawer().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('unpinned: a modal with a scrim that closes it; a click inside does not', () => {
    setLinks([link()])
    const onClose = vi.fn()
    render(props({ onClose }))
    expect(overlay().className).toBe('drawer-overlay live-chat-overlay')
    expect(drawer().classList.contains('drawer--pinned')).toBe(false)
    click(drawer())
    expect(onClose).not.toHaveBeenCalled()
    click(overlay())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('pinned: docked (drawer--pinned, overlay --pinned), no scrim close, the pin pressed', () => {
    setLinks([link()])
    const onClose = vi.fn()
    render(props({ onClose, pinned: true }))
    expect(overlay().classList.contains('drawer-overlay--pinned')).toBe(true)
    expect(drawer().classList.contains('drawer--pinned')).toBe(true)
    expect(drawer().querySelector('button[aria-label="Unpin"]')?.getAttribute('aria-pressed')).toBe('true')
    click(overlay())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('raised (a card modal is open) and beside (the pinned Explorer is open) are class names on the overlay', () => {
    setLinks([link()])
    render(props({ raised: true }))
    expect(overlay().classList.contains('drawer-overlay--raised')).toBe(true)
    expect(overlay().classList.contains('drawer-overlay--beside')).toBe(false)
    render(props({ raised: true, pinned: true, beside: true }))
    expect(overlay().classList.contains('drawer-overlay--raised')).toBe(true)
    expect(overlay().classList.contains('drawer-overlay--pinned')).toBe(true)
    expect(overlay().classList.contains('drawer-overlay--beside')).toBe(true)
    // `beside` is a docked arrangement: an unpinned modal is never moved for the Explorer.
    render(props({ pinned: false, beside: true }))
    expect(overlay().classList.contains('drawer-overlay--beside')).toBe(false)
  })

  it('shows "No live links." when none is live, and still closes', () => {
    const onClose = vi.fn()
    render(props({ onClose, linkId: null }))
    expect(drawer().textContent).toContain('No live links.')
    click(drawer().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('messages: time, name, text, a Sharer badge on the owner\'s lines; names are TEXT, coloured like the viewer page', () => {
    setLinks([link()])
    useWatchLinks.getState().setChat('L', [
      msg('1', { name: '<b>Mallory</b>', text: '<i>hi</i>' }),
      msg('2', { name: 'Ada', text: 'welcome', from: 'sharer' }),
      msg('3', { name: 'Ev‮e', text: 'x' })
    ])
    render(props())
    const lines = [...drawer().querySelectorAll<HTMLElement>('.live-chat__msg')]
    expect(lines).toHaveLength(3)
    // A name is a claim, shown as written — never parsed as markup.
    expect(lines[0].querySelector('b')).toBeNull()
    expect(lines[0].querySelector('i')).toBeNull()
    expect(lines[0].querySelector('.live-chat__name')?.textContent).toBe('<b>Mallory</b>')
    expect(lines[0].querySelector('.live-chat__text')?.textContent).toBe('<i>hi</i>')
    expect(lines[0].querySelector('.live-chat__badge')).toBeNull()
    expect(lines[0].querySelector<HTMLElement>('.live-chat__name')!.style.getPropertyValue('--live-name')).toBe(chatNameColor('<b>Mallory</b>'))
    expect(lines[0].querySelector('time')).not.toBeNull()
    // The owner's own line: the badge, and no viewer colour (the sharer's look is the HOST's word).
    expect(lines[1].classList.contains('live-chat__msg--sharer')).toBe(true)
    expect(lines[1].querySelector('.live-chat__badge')?.textContent).toBe('Sharer')
    expect(lines[1].querySelector<HTMLElement>('.live-chat__name')!.style.getPropertyValue('--live-name')).toBe('')
    // Bidi controls never reach the screen.
    expect(lines[2].querySelector('.live-chat__name')?.textContent).toBe('Eve')
  })

  it('stays at the newest message; scrolled up, a "N new messages ↓" pill appears and takes you down', () => {
    setLinks([link()])
    useWatchLinks.getState().setChat('L', [msg('1')])
    render(props())
    const list = drawer().querySelector<HTMLElement>('.live-chat__list')!
    // jsdom has no layout: give the list one, scrolled up.
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 })
    list.scrollTop = 100
    act(() => void list.dispatchEvent(new Event('scroll')))
    expect(drawer().querySelector('.live-chat__more')).toBeNull()
    addChat('L', msg('2'))
    addChat('L', msg('3'))
    const pill = drawer().querySelector<HTMLButtonElement>('.live-chat__more')!
    expect(pill.textContent).toBe('2 new messages ↓')
    expect(list.scrollTop).toBe(100)
    click(pill)
    expect(list.scrollTop).toBe(1000)
    expect(drawer().querySelector('.live-chat__more')).toBeNull()
  })

  it('at the bottom, a new message keeps it at the bottom and raises no pill', () => {
    setLinks([link()])
    render(props())
    const list = drawer().querySelector<HTMLElement>('.live-chat__list')!
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 })
    list.scrollTop = 800
    act(() => void list.dispatchEvent(new Event('scroll')))
    addChat('L', msg('5'))
    expect(drawer().querySelector('.live-chat__more')).toBeNull()
    expect(list.scrollTop).toBe(1000)
  })

  it('the composer posts as the sharer with api.sendChat, capped at CHAT_TEXT_MAX; a refused send says so', async () => {
    setLinks([link()])
    render(props())
    const input = drawer().querySelector<HTMLInputElement>('.live-chat__reply input')!
    expect(input.maxLength).toBe(CHAT_TEXT_MAX)
    type(input, ' hello there ')
    act(() => void drawer().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
    expect(api.sendChat).toHaveBeenCalledWith('L', 'hello there')
    expect(input.value).toBe('')
    api.sendChat.mockImplementation(async () => null)
    type(input, 'again')
    act(() => void drawer().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
    expect(drawer().querySelector('[role="alert"]')?.textContent).toBe(CHAT_NOT_SENT_MESSAGE)
    expect(input.value).toBe('again')
  })

  it('a link picker only when more than one link is live: "{title} · {role}", and a pick is reported', () => {
    setLinks([link()])
    const onPickLink = vi.fn()
    render(props({ onPickLink }))
    expect(drawer().querySelector('select')).toBeNull()
    setLinks([
      link(),
      link({ linkId: 'M', nodeId: 'n2', title: 'api-‮server', role: 'controller', control: { enabled: true, locked: false }, createdAt: 5 }),
      link({ linkId: 'V', nodeId: 'n3', title: 'logs', role: 'viewer', createdAt: 1 })
    ])
    const select = drawer().querySelector<HTMLSelectElement>('select')!
    expect([...select.options].map((o) => o.textContent)).toEqual(['build · Commenter', 'api-server · Control', 'logs · Viewer'])
    expect(select.value).toBe('L')
    act(() => {
      select.value = 'M'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onPickLink).toHaveBeenCalledWith('M')
  })

  it('two links that would read the same are told apart in the picker (label, then start time)', () => {
    setLinks([
      link({ linkId: 'A', label: 'Ada', createdAt: Date.UTC(2026, 9, 3, 12, 5) }),
      link({ linkId: 'B', label: 'Ada', createdAt: Date.UTC(2026, 9, 3, 13, 40) }),
      link({ linkId: 'C', label: 'Team', createdAt: 9 })
    ])
    render(props({ linkId: 'A' }))
    const texts = [...drawer().querySelectorAll('option')].map((o) => o.textContent)
    expect(new Set(texts).size).toBe(3)
    expect(texts[2]).toBe('build · Commenter · shown as Team')
    expect(texts[0]).toMatch(/^build · Commenter · shown as Ada · since /)
  })

  it('marks itself as the Live chat drawer (the card modal leaves Escape typed inside it alone)', () => {
    setLinks([link()])
    render(props())
    expect(drawer().hasAttribute('data-live-chat-drawer')).toBe(true)
  })

  it('a link that is not live any more falls back to the most recent one', () => {
    setLinks([link({ linkId: 'A', createdAt: 1, title: 'old' }), link({ linkId: 'B', createdAt: 9, title: 'new' })])
    render(props({ linkId: 'gone' }))
    expect(drawer().querySelector<HTMLSelectElement>('select')!.value).toBe('B')
  })

  it('a Viewer link shows People only — no thread, no composer', () => {
    setLinks([link({ role: 'viewer', viewers: [{ viewerId: 'v1', name: null, joinedAt: 1, waiting: false, controlling: false, typing: false }] })])
    render(props())
    expect(drawer().querySelector('.live-chat__list')).toBeNull()
    expect(drawer().querySelector('.live-chat__reply')).toBeNull()
    expect(drawer().querySelector('.live-chat__people')?.textContent).toContain('Viewer 1')
    expect(api.chatHistory).not.toHaveBeenCalled()
  })

  it('People: each viewer watching or able to type, a typing dot, and Kick', async () => {
    setLinks([
      link({
        role: 'controller',
        control: { enabled: true, locked: false },
        viewers: [
          { viewerId: 'v1', name: 'Mert', joinedAt: 1, waiting: false, controlling: true, typing: true },
          { viewerId: 'v2', name: null, joinedAt: 2, waiting: false, controlling: false, typing: false }
        ]
      })
    ])
    render(props())
    const rows = [...drawer().querySelectorAll<HTMLElement>('.live-chat__people li')]
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Mert')
    expect(rows[0].textContent).toContain('can type')
    expect(rows[0].querySelector('.live-pop__typing')).not.toBeNull()
    expect(rows[1].textContent).toContain('Viewer 2')
    expect(rows[1].textContent).toContain('watching')
    expect(rows[1].querySelector('.live-pop__typing')).toBeNull()
    click(rows[1].querySelector('button')!)
    await flush()
    expect(api.kick).toHaveBeenCalledWith('L', 'v2')
    api.kick.mockImplementation(async () => false)
    click(rows[0].querySelector('button')!)
    await flush()
    expect(drawer().textContent).toContain(KICK_NOT_DONE_MESSAGE)
  })

  it("a Control link: the popover's owner controls — Typing calls setControl, Allow again only while locked", async () => {
    setLinks([link({ role: 'controller', control: { enabled: true, locked: true } })])
    render(props())
    const sw = drawer().querySelector<HTMLButtonElement>('[role="switch"]')!
    click(sw)
    await flush()
    expect(api.setControl).toHaveBeenCalledWith('L', false)
    expect(drawer().textContent).toContain(CONTROL_LOCKED_TEXT)
    click(button('Allow control again'))
    await flush()
    expect(api.allowControl).toHaveBeenCalledWith('L')
    expect(button('Change password…')).toBeTruthy()
  })

  // Final review, Important 1: the drawer carries the same owner controls, so the same notice — and,
  // since the drawer has no Stop of its own, the notice brings Stop sharing with it.
  it("typing OFF answered 'unsaved': the drawer says it applied but will undo at a restart, with Stop sharing at hand", async () => {
    setLinks([link({ role: 'controller', control: { enabled: true, locked: false } })])
    render(props())
    api.setControl.mockImplementationOnce(async () => 'unsaved')
    click(drawer().querySelector<HTMLButtonElement>('[role="switch"]')!)
    await flush()
    const notice = drawer().querySelector<HTMLElement>('.live-pop__unsaved')!
    expect(notice.getAttribute('role')).toBe('alert')
    expect(notice.textContent).toContain(CONTROL_CHANGE_UNSAVED_MESSAGE)
    click([...notice.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Stop sharing')!)
    await flush()
    expect(api.revoke).toHaveBeenCalledWith('L')
  })

  it('the Kick of a viewer who is controlling says they can unlock again', () => {
    setLinks([
      link({
        role: 'controller',
        control: { enabled: true, locked: false },
        viewers: [
          { viewerId: 'v1', name: 'Mert', joinedAt: 1, waiting: false, controlling: true, typing: false },
          { viewerId: 'v2', name: null, joinedAt: 2, waiting: false, controlling: false, typing: false }
        ]
      })
    ])
    render(props())
    const kicks = [...drawer().querySelectorAll<HTMLButtonElement>('.live-chat__people li button')]
    expect(kicks[0].title).toBe(`${KICK_NOTE} ${KICK_CONTROLLER_NOTE}`)
    expect(kicks[1].title).toBe(KICK_NOTE)
  })

  it('mounting on a link reads it: markRead, so the chip\'s unread count clears; what lands while shown is read too', async () => {
    setLinks([link()])
    addChat('L', msg('1'))
    addChat('L', msg('2'))
    expect(useWatchLinks.getState().unread.L).toBe(2)
    expect(liveChipSig(useWatchLinks.getState(), 'n1').endsWith('\u00012')).toBe(true)
    render(props())
    expect(useWatchLinks.getState().unread.L).toBe(0)
    expect(liveChipSig(useWatchLinks.getState(), 'n1').endsWith('\u00010')).toBe(true)
    addChat('L', msg('3'))
    expect(useWatchLinks.getState().unread.L).toBe(0)
    // Core's history is asked once for the thread on screen.
    await flush()
    expect(api.chatHistory).toHaveBeenCalledWith('L')
    // Closed: a new message counts again.
    act(() => root.render(<></>))
    addChat('L', msg('4'))
    expect(useWatchLinks.getState().unread.L).toBe(1)
  })

  it('Go to terminal hands the link\'s node to the caller', () => {
    setLinks([link({ nodeId: 'node-7' })])
    const onGoToNode = vi.fn()
    render(props({ onGoToNode }))
    click(button('Go to terminal'))
    expect(onGoToNode).toHaveBeenCalledWith('node-7')
  })

  it('Escape closes the unpinned drawer only while it is the top dialog; pinned, Escape does nothing', () => {
    setLinks([link()])
    const onClose = vi.fn()
    render(props({ onClose }))
    pushDialog('other')
    keydown('Escape')
    expect(onClose).not.toHaveBeenCalled()
    popDialog('other')
    keydown('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    onClose.mockClear()
    render(props({ onClose, pinned: true }))
    keydown('Escape')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('pinned, it is not a modal: it takes no place in the dialog stack (the board keeps its keys)', () => {
    setLinks([link()])
    render(props({ pinned: true }))
    expect(openDialogCount()).toBe(0)
    render(props({ pinned: false }))
    expect(openDialogCount()).toBe(1)
    render(props({ pinned: true }))
    expect(openDialogCount()).toBe(0)
  })

  it('a new password on its way is not lost: × and Escape wait while the save is in flight', async () => {
    setLinks([link({ role: 'controller', control: { enabled: true, locked: false } })])
    let answer: (ok: boolean) => void = () => {}
    api.setPassword.mockImplementation(() => new Promise<boolean>((r) => (answer = r)))
    const onClose = vi.fn()
    render(props({ onClose }))
    click(button('Change password…'))
    click(button('Generate'))
    click(button('Save'))
    await flush()
    expect(button('Saving…')).toBeTruthy()
    click(drawer().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!)
    keydown('Escape')
    click(overlay())
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => answer(true))
    expect(button('Copy password')).toBeTruthy()
    click(drawer().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // ── Hardening round ──
  it('Escape typed OUTSIDE the drawer (the palette, Settings — not on the dialog stack) is not the drawer\'s', () => {
    setLinks([link()])
    const onClose = vi.fn()
    render(props({ onClose }))
    const palette = document.createElement('input')
    document.body.append(palette)
    palette.focus()
    act(() => void palette.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(onClose).not.toHaveBeenCalled()
    // …and the palette keeps the keyboard (no focus restore pulled out from under it).
    expect(document.activeElement).toBe(palette)
    // On the body (nothing focused) with the drawer as the top dialog: it is the drawer's.
    keydown('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape inside the drawer closes it when it is the top dialog', () => {
    setLinks([link()])
    const onClose = vi.fn()
    render(props({ onClose }))
    const input = drawer().querySelector<HTMLInputElement>('.live-chat__reply input')!
    input.focus()
    act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  const controlLinks = (): WatchLinkView[] => [
    link({ role: 'controller', control: { enabled: true, locked: false } }),
    link({ linkId: 'M', nodeId: 'n2', title: 'other', createdAt: 5 })
  ]
  const startSave = async (): Promise<(ok: boolean) => void> => {
    let answer: (ok: boolean) => void = () => {}
    api.setPassword.mockImplementation(() => new Promise<boolean>((r) => (answer = r)))
    click(button('Change password…'))
    click(button('Generate'))
    click(button('Save'))
    await flush()
    expect(button('Saving…')).toBeTruthy()
    return (ok) => answer(ok)
  }
  const shown = (): string => drawer().querySelector<HTMLSelectElement>('select')!.value

  it('a password save in flight keeps the drawer on its link: an open on another link waits (refused save → then it moves)', async () => {
    setLinks(controlLinks())
    const onPickLink = vi.fn()
    render(props({ linkId: 'L', onPickLink }))
    const answer = await startSave()
    // Canvas's `nodeterm:live-chat` listener opens the drawer on M meanwhile.
    render(props({ linkId: 'M', onPickLink }))
    expect(shown()).toBe('L')
    expect(button('Saving…')).toBeTruthy()
    expect(drawer().querySelector('select')!.disabled).toBe(true)
    await act(async () => answer(false))
    expect(shown()).toBe('M')
    // The drawer followed Canvas's link; it never asked Canvas to change it back.
    expect(onPickLink).not.toHaveBeenCalled()
  })

  it('a password that took stays on screen (its plaintext exists nowhere else) until Done, then the drawer moves', async () => {
    setLinks(controlLinks())
    render(props({ linkId: 'L' }))
    const answer = await startSave()
    render(props({ linkId: 'M' }))
    await act(async () => answer(true))
    expect(shown()).toBe('L')
    expect(button('Copy password')).toBeTruthy()
    click(button('Done'))
    expect(shown()).toBe('M')
  })

  it('when the remembered link is gone, the drawer adopts what it shows (Canvas state and the pick agree)', () => {
    setLinks([link({ linkId: 'A', createdAt: 1 }), link({ linkId: 'B', createdAt: 9 })])
    const onPickLink = vi.fn()
    render(props({ linkId: 'gone', onPickLink }))
    expect(onPickLink).toHaveBeenCalledWith('B')
    onPickLink.mockClear()
    render(props({ linkId: 'B', onPickLink }))
    expect(onPickLink).not.toHaveBeenCalled()
  })

  it('a message counts as read only while someone can see it: hidden or unfocused, the chip\'s count grows', () => {
    setLinks([link()])
    addChat('L', msg('1'))
    vi.mocked(document.hasFocus).mockReturnValue(false)
    render(props({ pinned: true }))
    expect(useWatchLinks.getState().unread.L).toBe(1)
    addChat('L', msg('2'))
    expect(useWatchLinks.getState().unread.L).toBe(2)
    // The window gains focus: what is on screen is read.
    vi.mocked(document.hasFocus).mockReturnValue(true)
    act(() => void window.dispatchEvent(new Event('focus')))
    expect(useWatchLinks.getState().unread.L).toBe(0)
    addChat('L', msg('3'))
    expect(useWatchLinks.getState().unread.L).toBe(0)
    // Blurred: it counts again.
    vi.mocked(document.hasFocus).mockReturnValue(false)
    act(() => void window.dispatchEvent(new Event('blur')))
    addChat('L', msg('4'))
    expect(useWatchLinks.getState().unread.L).toBe(1)
    // Focused but HIDDEN (minimized, another Space): still counts.
    vi.mocked(document.hasFocus).mockReturnValue(true)
    act(() => void window.dispatchEvent(new Event('focus')))
    expect(useWatchLinks.getState().unread.L).toBe(0)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    act(() => void document.dispatchEvent(new Event('visibilitychange')))
    addChat('L', msg('5'))
    expect(useWatchLinks.getState().unread.L).toBe(1)
  })

  it('a viewer typing push does not re-render the message list', () => {
    setLinks([link({ viewers: [{ viewerId: 'v1', name: 'Mert', joinedAt: 1, waiting: false, controlling: false, typing: false }] })])
    useWatchLinks.getState().setChat('L', [msg('1'), msg('2'), msg('3')])
    render(props())
    const color = vi.mocked(chatNameColor)
    color.mockClear()
    setLinks([link({ viewers: [{ viewerId: 'v1', name: 'Mert', joinedAt: 1, waiting: false, controlling: false, typing: true }] })])
    expect(drawer().querySelector('.live-pop__typing')).not.toBeNull()
    expect(color).not.toHaveBeenCalled()
    addChat('L', msg('4'))
    expect(color).toHaveBeenCalled()
  })
})
