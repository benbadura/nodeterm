// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlSupport, CreateWatchLinkRequest, CreateWatchLinkResult } from '@shared/watch-link-types'
import { LiveLinkDialog, LiveLinkDialogBody } from './LiveLinkDialog'
import {
  CONTROL_UNSUPPORTED_REASON,
  controlWarningText,
  formatClock,
  LIVE_LINK_EXPOSURE,
  PASSWORD_SEPARATE_NOTE,
  PASSWORD_SHOWN_ONCE,
  SAVE_FIRST_MESSAGE,
  STOP_FAILED_MESSAGE,
  UNLIMITED_NOTE
} from '../lib/liveLink'
import { LIVE_LINK_DEFAULTS_KEY } from '../lib/liveLinkDefaults'
import { resetDialogStack } from './dialog-stack'
import { pinNeutralMachineNoun } from '../lib/testMachineNoun'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
pinNeutralMachineNoun()

const noop = (): void => {}
const body = (state: Parameters<typeof LiveLinkDialogBody>[0]['state'], extra: Partial<Parameters<typeof LiveLinkDialogBody>[0]> = {}) =>
  renderToStaticMarkup(
    <LiveLinkDialogBody title="build" state={state} onChange={noop} onSubmit={noop} onClose={noop} onStop={noop} {...extra} />
  )
const FORM = { phase: 'form', role: 'viewer', ttl: 3600, label: 'Ada', password: '', busy: false, error: null } as const

describe('LiveLinkDialogBody', () => {
  it('reads as rows: who can use the link, when it expires, the name — and the exposure always', () => {
    const html = body(FORM)
    expect(html).toContain('Share “build”')
    expect(html).toContain('Anyone with the link')
    expect(html).toContain('can watch')
    expect(html).toContain('Expires')
    expect(html).toContain('in 1 hour')
    expect(html).toContain('Viewers see you as')
    // The menus are closed: their choices are not on the page until one is opened.
    expect(html).not.toContain('menu-select__menu')
    // Neither Control's password row nor its warning until Control is picked.
    expect(html).not.toContain('live-dialog__password')
    expect(html).not.toContain('live-dialog__warning')
    expect(html).toContain(LIVE_LINK_EXPOSURE)
    expect(html).toContain('Create live link')
  })

  it('shows the URL with Copy and Stop, and until when anyone with it can watch (H25)', () => {
    const expiresAt = new Date(2026, 9, 1, 15, 42, 0).getTime()
    const now = new Date(2026, 9, 1, 14, 42, 0).getTime()
    const html = body({ phase: 'done', role: 'viewer', url: 'https://nodeterm.dev/s/x#1.y', linkId: 'x', expiresAt }, { now })
    expect(html).toContain('https://nodeterm.dev/s/x#1.y')
    expect(html).toContain('Copy link')
    expect(html).toContain('Stop sharing')
    expect(html).toContain(`Anyone with this link can watch until ${formatClock(expiresAt)}.`)
  })

  // R64/M1: a 24 h link made at 15:43 read "until 15:43" — it looks like it ends now.
  it('names the day when the link ends on another day', () => {
    const now = new Date(2026, 9, 1, 15, 43, 0).getTime()
    const expiresAt = now + 24 * 3_600_000
    const html = body({ phase: 'done', role: 'viewer', url: 'https://nodeterm.dev/s/x#1.y', linkId: 'x', expiresAt }, { now })
    expect(html).toContain(`Anyone with this link can watch until tomorrow ${formatClock(expiresAt)}.`)
  })

  it('Control: the "and" of the typing warning is bold, and the machine is the one the caller names', () => {
    const html = body({ ...FORM, role: 'controller' }, { controlMachine: 'ada@build.example' })
    expect(html).toContain('<strong>and</strong>')
    expect(html).toContain('run any command on ada@build.example,')
    // The exposure stays under it: anyone with the link alone still watches a Control link.
    expect(html).toContain(LIVE_LINK_EXPOSURE)
  })

  it('R63: the "only while open" note shows in the form when the caller has one', () => {
    expect(body(FORM, { whileOpenNote: 'NOTE-X' })).toContain('NOTE-X')
    expect(body(FORM)).not.toContain('live-dialog__note')
  })

  it('the header title loses its bidi controls (H26)', () => {
    const html = renderToStaticMarkup(
      <LiveLinkDialogBody title={'bu\u202eild'} state={FORM} onChange={noop} onSubmit={noop} onClose={noop} onStop={noop} />
    )
    expect(html).toContain('Share “build”')
  })

  it('offers Upgrade only for a not-entitled error AND only when the caller can upgrade (H12, R43)', () => {
    const err = { ...FORM, error: 'Live links need an active Pro plan.', offerUpgrade: true }
    expect(body(err, { onUpgrade: noop })).toContain('Upgrade to Pro')
    // The Server Edition passes no onUpgrade: never an Upgrade button there.
    expect(body(err)).not.toContain('Upgrade to Pro')
    expect(body({ ...err, offerUpgrade: false }, { onUpgrade: noop })).not.toContain('Upgrade to Pro')
  })

  it('while busy, Cancel cannot close and Create says so (H24)', () => {
    const html = body({ ...FORM, busy: true })
    expect(html).toMatch(/<button class="confirm__btn" disabled="">Cancel<\/button>/)
    expect(html).toContain('Creating…')
  })
})

// ---- the mounted dialog ----------------------------------------------------------------------

const created = (url = 'https://nodeterm.dev/s/abc#1.k'): CreateWatchLinkResult => ({
  ok: true,
  link: {
    linkId: 'abc',
    nodeId: 'n1',
    role: 'viewer',
    label: 'Ada',
    title: 'build',
    createdAt: 0,
    expiresAt: Date.now() + 3_600_000,
    url,
    status: 'live',
    viewers: [],
    control: null
  }
})

let api: {
  create: ReturnType<typeof vi.fn<(r: CreateWatchLinkRequest) => Promise<CreateWatchLinkResult>>>
  revoke: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>
  controlSupport: ReturnType<typeof vi.fn<(nodeId: string) => Promise<ControlSupport>>>
}
/** What the local core's `tmuxStatus` reports (R63); `undefined` = the read rejects. */
let persistence: { enabled: boolean; backend: string | null } | undefined
const readPersistence = async () => {
  if (!persistence) throw new Error('no core')
  return { persistence }
}
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  resetDialogStack()
  api = {
    create: vi.fn(async () => created()),
    revoke: vi.fn(async () => {}),
    controlSupport: vi.fn(async () => 'ok' as const)
  }
  persistence = { enabled: true, backend: 'tmux' }
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    watchLink: api,
    clipboard: { writeText: vi.fn() }
  }
  localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  resetDialogStack()
})

const flush = (): Promise<void> => act(async () => {})
const btn = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('.live-dialog button')].find((b) => b.textContent === label)!
const click = (el: Element): void => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const escape = (): void => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
const setLabel = (v: string): void => {
  const input = document.querySelector<HTMLInputElement>('.live-dialog__label input')!
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** A row's menu trigger, by the row's label ("Anyone with the link", "Expires"). */
const trigger = (row: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`.menu-select__trigger[aria-label^="${row}:"]`)!
/** An option of the OPEN menu, by its label. */
const option = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('.menu-select__item')].find(
    (b) => b.querySelector('.menu-select__label')?.textContent === label
  )
/** Open a row's menu and pick an option, the way a person does. */
const choose = (row: string, label: string): void => {
  click(trigger(row))
  click(option(label)!)
}
const pickRole = (label: 'can watch' | 'can chat' | 'can type'): void => choose('Anyone with the link', label)
const roleValue = (): string => trigger('Anyone with the link').querySelector('.menu-select__value')!.textContent!

function mount(o: {
  prepare?: () => Promise<string | null>
  onUpgrade?: () => void
  onClose?: () => void
  surface?: 'desktop' | 'server' | 'relay'
  remoteNode?: boolean
  sshTarget?: { user: string; host: string } | null
} = {}): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn(o.onClose ?? (() => {}))
  act(() =>
    root.render(
      <LiveLinkDialog
        nodeId="n1"
        title="build"
        surface={o.surface ?? 'desktop'}
        remoteNode={o.remoteNode}
        sshTarget={o.sshTarget}
        readPersistence={readPersistence}
        prepare={o.prepare ?? (async () => null)}
        onUpgrade={o.onUpgrade}
        onClose={onClose}
      />
    )
  )
  return { onClose }
}

describe('LiveLinkDialog', () => {
  it('prefills "Shown to viewers as" with the presence name, capped to the label limit', () => {
    localStorage.setItem('nodeterm.presence.me', JSON.stringify({ name: 'Ada Lovelace', color: '#fff' }))
    mount()
    const input = document.querySelector<HTMLInputElement>('.live-dialog__label input')!
    expect(input.value).toBe('Ada Lovelace')
    expect(input.maxLength).toBe(40)
    act(() => root.unmount())
    root = createRoot(host)
    localStorage.setItem('nodeterm.presence.me', JSON.stringify({ name: 'x'.repeat(60), color: '#fff' }))
    mount()
    expect(document.querySelector<HTMLInputElement>('.live-dialog__label input')!.value).toBe('x'.repeat(40))
  })

  it('D2/M3: the prefill never splits an emoji at the label limit', () => {
    localStorage.setItem('nodeterm.presence.me', JSON.stringify({ name: 'x'.repeat(39) + '\u{1F600}', color: '#fff' }))
    mount()
    expect(document.querySelector<HTMLInputElement>('.live-dialog__label input')!.value).toBe('x'.repeat(39))
  })

  it('D2/M3: focus lands in the dialog — the role menu on open, Copy link once created', async () => {
    mount()
    expect(document.activeElement).toBe(trigger('Anyone with the link'))
    setLabel('Ada')
    click(btn('Create live link'))
    await flush()
    expect(document.activeElement).toBe(btn('Copy link'))
  })

  // R63: on a machine with no watcher client for a local node (Windows' session host, tmux off or
  // missing, Zellij), a link works only while the terminal is open here — said before it is created.
  it('R63: says "only while open" where this machine has no watcher client, and nowhere else', async () => {
    const note = (): string | null =>
      [...document.querySelectorAll('.live-dialog__note')].map((e) => e.textContent).join('|') || null
    for (const [p, remote, shown] of [
      [{ enabled: true, backend: 'session-host' }, false, true],
      [{ enabled: true, backend: 'zellij' }, false, true],
      [{ enabled: false, backend: 'tmux' }, false, true],
      [{ enabled: true, backend: null }, false, true],
      [{ enabled: true, backend: 'tmux' }, false, false],
      [{ enabled: true, backend: 'session-host' }, true, false], // an SSH node: the host's tmux
      [undefined, false, false] // unknown claims nothing
    ] as const) {
      persistence = p
      act(() => root.unmount())
      root = createRoot(host)
      mount({ remoteNode: remote })
      await flush()
      if (shown) expect(note(), JSON.stringify(p)).toMatch(/only while it is open in nodeterm/)
      else expect(note(), JSON.stringify(p)).toBeNull()
    }
  })

  it('R47: prepares BEFORE create, then creates this node with the chosen options', async () => {
    const order: string[] = []
    const prepare = vi.fn(async () => {
      order.push('prepare')
      return null
    })
    api.create.mockImplementation(async (r) => {
      order.push('create')
      return created()
    })
    mount({ prepare })
    setLabel('  Ada  ')
    click(btn('Create live link'))
    await flush()
    expect(order).toEqual(['prepare', 'create'])
    expect(api.create).toHaveBeenCalledWith({ nodeId: 'n1', role: 'viewer', ttlSeconds: 3600, label: 'Ada', title: 'build' })
    // The URL appears in the dialog, and only once created.
    expect(document.querySelector<HTMLInputElement>('.live-dialog__url input')!.value).toBe('https://nodeterm.dev/s/abc#1.k')
  })

  it('R47: a refused prepare (unsaved canvas, or a conflict) shows the sentence and NEVER calls create', async () => {
    mount({ prepare: async () => SAVE_FIRST_MESSAGE })
    setLabel('Ada')
    click(btn('Create live link'))
    await flush()
    expect(api.create).not.toHaveBeenCalled()
    expect(document.querySelector('.live-dialog__error')!.textContent).toBe(SAVE_FIRST_MESSAGE)
    // Not stuck busy: Create works again.
    expect(btn('Create live link').disabled).toBe(false)
  })

  it('H24: cannot be dismissed while busy — not by Escape, the scrim or Cancel — and can once it is done', async () => {
    let release!: (v: string | null) => void
    const { onClose } = mount({ prepare: () => new Promise((r) => (release = r)) })
    setLabel('Ada')
    click(btn('Create live link'))
    escape()
    click(document.querySelector('.confirm-overlay')!)
    click(btn('Cancel'))
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => release(null))
    await flush()
    // Done now: Escape closes.
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the error for a refused create, with Upgrade for not-entitled when offered', async () => {
    const onUpgrade = vi.fn()
    api.create.mockResolvedValue({ ok: false, error: 'not-entitled' })
    mount({ onUpgrade })
    setLabel('Ada')
    click(btn('Create live link'))
    await flush()
    expect(document.querySelector('.live-dialog__error')!.textContent).toBe('Live links need an active Pro plan.')
    click(btn('Upgrade to Pro'))
    expect(onUpgrade).toHaveBeenCalledTimes(1)
  })

  it('words `unsupported` for the surface it was opened on, and a rejected create as the network sentence', async () => {
    api.create.mockResolvedValue({ ok: false, error: 'unsupported' })
    mount({ surface: 'relay' })
    setLabel('Ada')
    click(btn('Create live link'))
    await flush()
    expect(document.querySelector('.live-dialog__error')!.textContent).toBe(
      'Live links are created on the machine that runs this terminal.'
    )
    api.create.mockRejectedValue(new Error('socket'))
    click(btn('Create live link'))
    await flush()
    expect(document.querySelector('.live-dialog__error')!.textContent).toBe(
      "Couldn't reach nodeterm's service. Nothing was shared."
    )
  })

  it('Stop sharing revokes this link and closes; a rejected stop says so and stays open (H23)', async () => {
    const { onClose } = mount()
    setLabel('Ada')
    click(btn('Create live link'))
    await flush()
    api.revoke.mockRejectedValueOnce(new Error('down'))
    click(btn('Stop sharing'))
    await flush()
    expect(api.revoke).toHaveBeenCalledWith('abc')
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('.live-dialog__error')!.textContent).toBe(STOP_FAILED_MESSAGE)
    click(btn('Stop sharing'))
    await flush()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Copy puts the URL on the clipboard', async () => {
    mount()
    setLabel('Ada')
    click(btn('Create live link'))
    await flush()
    click(btn('Copy link'))
    expect(window.nodeTerminal.clipboard.writeText).toHaveBeenCalledWith('https://nodeterm.dev/s/abc#1.k')
  })
})

// ---- Control and Unlimited (spec 2026-10-03 §2.7, §3) -------------------------------------------

const pwInput = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>('.live-dialog__password input')
const typeInto = (input: HTMLInputElement, v: string): void =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
const warnings = (): string[] => [...document.querySelectorAll('.live-dialog__warning')].map((e) => e.textContent ?? '')
const exposure = (): string | null => document.querySelector('.live-dialog__exposure')?.textContent ?? null
const GENERATED = /^[0-9abcdefghjkmnpqrstvwxyz]{16}$/
const createWith = (over: Partial<CreateWatchLinkRequest> = {}): CreateWatchLinkResult => ({
  ok: true,
  link: {
    ...(created() as { ok: true; link: import('@shared/watch-link-types').WatchLinkView }).link,
    role: over.role ?? 'viewer',
    expiresAt: over.ttlSeconds === 0 ? null : Date.now() + 3_600_000,
    control: over.role === 'controller' ? { enabled: true, locked: false } : null
  }
})

describe('LiveLinkDialog — the menus', () => {
  it('the role menu lists the three roles, each with what it grants, the current one checked', async () => {
    mount()
    await flush()
    click(trigger('Anyone with the link'))
    const items = [...document.querySelectorAll<HTMLButtonElement>('.menu-select__item')]
    expect(items.map((b) => b.querySelector('.menu-select__label')!.textContent)).toEqual(['can watch', 'can chat', 'can type'])
    expect(items.map((b) => b.querySelector('.menu-select__hint')!.textContent)).toEqual([
      'Sees the terminal',
      'Watches and chats with you',
      'Also types, with a password'
    ])
    expect(items.map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
  })

  it('the expiry menu ends on "never", whose hint says it works until stopped', async () => {
    mount()
    await flush()
    click(trigger('Expires'))
    const labels = [...document.querySelectorAll('.menu-select__item .menu-select__label')].map((e) => e.textContent)
    expect(labels).toEqual(['in 15 minutes', 'in 1 hour', 'in 8 hours', 'in 24 hours', 'never'])
    expect(option('never')!.querySelector('.menu-select__hint')!.textContent).toBe(UNLIMITED_NOTE)
  })

  it("Escape in an open menu closes the menu, not the dialog", async () => {
    const { onClose } = mount()
    await flush()
    click(trigger('Expires'))
    const focused = document.activeElement!
    expect(focused.className).toContain('menu-select__item')
    act(() => void focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('.menu-select__menu')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger('Expires'))
  })
})

describe('LiveLinkDialog — Control', () => {
  it('picking "can type" fills a generated password and shows the typing warning above the exposure', async () => {
    mount()
    await flush()
    expect(pwInput()).toBeNull()
    expect(warnings()).toEqual([])
    expect(exposure()).toBe(LIVE_LINK_EXPOSURE)
    pickRole('can type')
    expect(roleValue()).toBe('can type')
    const input = pwInput()!
    expect(input.value).toMatch(GENERATED)
    expect(input.type).toBe('text')
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(input.getAttribute('spellcheck')).toBe('false')
    expect(input.maxLength).toBe(128)
    // Anyone with the link alone still WATCHES a Control link: the exposure stays, the typing
    // warning comes first.
    expect(warnings()).toEqual([controlWarningText('this computer')])
    expect(document.querySelector('.live-dialog__warning strong')!.textContent).toBe('and')
    expect(exposure()).toBe(LIVE_LINK_EXPOSURE)
    const order = [...document.querySelectorAll('.live-dialog__warning, .live-dialog__exposure')].map((e) => e.className)
    expect(order).toEqual(['live-dialog__warning', 'live-dialog__exposure'])
    // Ready to create at once: the generated password passes the rule.
    setLabel('Ada')
    expect(btn('Create live link').disabled).toBe(false)
    // Back to watching: no password row, no typing warning.
    pickRole('can watch')
    expect(pwInput()).toBeNull()
    expect(warnings()).toEqual([])
  })

  it('a password already there is kept when "can type" is picked again', async () => {
    mount()
    await flush()
    pickRole('can type')
    typeInto(pwInput()!, 'longenough1')
    pickRole('can chat')
    pickRole('can type')
    expect(pwInput()!.value).toBe('longenough1')
  })

  it('"New password" replaces it with 16 symbols from crypto.getRandomValues', async () => {
    mount()
    await flush()
    pickRole('can type')
    typeInto(pwInput()!, 'longenough1')
    const spy = vi.spyOn(crypto, 'getRandomValues')
    click(document.querySelector<HTMLButtonElement>('button[aria-label="New password"]')!)
    expect(spy).toHaveBeenCalled()
    expect(pwInput()!.value).toMatch(GENERATED)
    spy.mockRestore()
  })

  it('the validation line is tied to the password field (aria-describedby)', async () => {
    mount()
    await flush()
    setLabel('Ada')
    pickRole('can type')
    expect(pwInput()!.hasAttribute('aria-describedby')).toBe(false)
    typeInto(pwInput()!, 'short')
    const id = pwInput()!.getAttribute('aria-describedby')!
    expect(document.getElementById(id)!.textContent).toBe('Use at least 8 characters.')
    expect(document.getElementById(id)!.className).toContain('live-dialog__invalid')
    typeInto(pwInput()!, 'longenough1')
    expect(pwInput()!.hasAttribute('aria-describedby')).toBe(false)
  })

  it('Create stays disabled until the password is acceptable, and says why', async () => {
    mount()
    await flush()
    setLabel('Ada')
    pickRole('can type')
    const create = (): HTMLButtonElement => btn('Create live link')
    const problem = (): string | null => document.querySelector('.live-dialog__invalid')?.textContent ?? null
    // Cleared: disabled, nothing nagging yet.
    typeInto(pwInput()!, '')
    expect(create().disabled).toBe(true)
    expect(problem()).toBeNull()
    typeInto(pwInput()!, 'short')
    expect(create().disabled).toBe(true)
    expect(problem()).toBe('Use at least 8 characters.')
    typeInto(pwInput()!, 'long\tenough')
    expect(create().disabled).toBe(true)
    expect(problem()).toBe('Line breaks and control characters are not allowed.')
    typeInto(pwInput()!, 'longenough1')
    expect(create().disabled).toBe(false)
    expect(problem()).toBeNull()
  })

  it("an SSH project's node: the typing warning names the host its shell runs on", async () => {
    mount({ remoteNode: true, sshTarget: { user: 'ada', host: 'build.example' } })
    await flush()
    pickRole('can type')
    expect(warnings()).toEqual([controlWarningText('ada@build.example')])
    expect(warnings()[0]).toContain('run any command on ada@build.example,')
    expect(warnings()[0]).not.toContain('this computer')
  })

  it('sends the password only for Control', async () => {
    api.create.mockImplementation(async (r) => createWith(r))
    mount()
    await flush()
    setLabel('Ada')
    pickRole('can type')
    typeInto(pwInput()!, 'longenough1')
    // A password typed, then the owner switched to "can chat": nothing of it leaves the dialog.
    pickRole('can chat')
    click(btn('Create live link'))
    await flush()
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.create.mock.calls[0][0]).toEqual({ nodeId: 'n1', role: 'commenter', ttlSeconds: 3600, label: 'Ada', title: 'build' })
    expect('password' in api.create.mock.calls[0][0]).toBe(false)

    act(() => root.unmount())
    root = createRoot(host)
    api.create.mockClear()
    localStorage.removeItem(LIVE_LINK_DEFAULTS_KEY)
    mount()
    await flush()
    setLabel('Ada')
    pickRole('can type')
    typeInto(pwInput()!, 'longenough1')
    click(btn('Create live link'))
    await flush()
    expect(api.create).toHaveBeenCalledWith({
      nodeId: 'n1',
      role: 'controller',
      ttlSeconds: 3600,
      label: 'Ada',
      title: 'build',
      password: 'longenough1'
    })
  })

  it("\"can type\" is shown disabled, with the reason as its hint, when the terminal can't take input — asked once", async () => {
    api.controlSupport.mockResolvedValue('unsupported')
    mount()
    await flush()
    expect(api.controlSupport).toHaveBeenCalledTimes(1)
    expect(api.controlSupport).toHaveBeenCalledWith('n1')
    click(trigger('Anyone with the link'))
    const off = option('can type')!
    expect(off.getAttribute('aria-disabled')).toBe('true')
    expect(off.querySelector('.menu-select__hint')!.textContent).toBe(CONTROL_UNSUPPORTED_REASON)
    expect(option('can watch')!.hasAttribute('aria-disabled')).toBe(false)
    // Clicking it changes nothing.
    click(off)
    expect(roleValue()).toBe('can watch')
    expect(pwInput()).toBeNull()
  })

  it("'unknown' (and a rejected or missing answer) keeps Control offered: the create decides", async () => {
    for (const answer of ['unknown', 'reject', 'missing'] as const) {
      act(() => root.unmount())
      root = createRoot(host)
      if (answer === 'unknown') api.controlSupport.mockResolvedValue('unknown')
      else if (answer === 'reject') api.controlSupport.mockRejectedValue(new Error('socket'))
      else (api as { controlSupport?: unknown }).controlSupport = undefined
      mount()
      await flush()
      click(trigger('Anyone with the link'))
      expect(option('can type')!.hasAttribute('aria-disabled'), answer).toBe(false)
      expect(option('can type')!.querySelector('.menu-select__hint')!.textContent, answer).not.toBe(CONTROL_UNSUPPORTED_REASON)
    }
  })

  it('an answer that lands after Control was picked moves the choice off it', async () => {
    let answer!: (s: ControlSupport) => void
    api.controlSupport.mockImplementation(() => new Promise((r) => (answer = r)))
    mount()
    await flush()
    pickRole('can type')
    typeInto(pwInput()!, 'longenough1')
    await act(async () => answer('unsupported'))
    expect(roleValue()).toBe('can watch')
    expect(pwInput()).toBeNull()
    click(trigger('Anyone with the link'))
    expect(option('can type')!.getAttribute('aria-disabled')).toBe('true')
  })

  it('the done step shows the password once, with Copy password and the separate-send note', async () => {
    api.create.mockImplementation(async (r) => createWith(r))
    mount()
    await flush()
    setLabel('Ada')
    pickRole('can type')
    typeInto(pwInput()!, 'longenough1')
    choose('Expires', 'never')
    click(btn('Create live link'))
    await flush()
    const field = document.querySelector<HTMLInputElement>('.live-dialog__password input')!
    expect(field.readOnly).toBe(true)
    expect(field.value).toBe('longenough1')
    const text = document.querySelector('.live-dialog')!.textContent!
    expect(text).toContain(PASSWORD_SHOWN_ONCE)
    expect(text).toContain(PASSWORD_SEPARATE_NOTE)
    expect(text).toContain('Anyone with this link and the password can type until you stop it.')
    click(btn('Copy password'))
    expect(window.nodeTerminal.clipboard.writeText).toHaveBeenCalledWith('longenough1')
    expect(btn('Copied!')).toBeTruthy()
    // The link keeps its own Copy.
    expect(document.querySelector<HTMLInputElement>('.live-dialog__url input')!.value).toBe('https://nodeterm.dev/s/abc#1.k')
  })

  // Final review, Minor 6: a stray click beside the done step must not throw away the only copy of a
  // Control link's password. The scrim does nothing until Copy password was pressed; Escape, Done and
  // the head's close button still close (deliberate gestures).
  it('the done step of a Control link ignores the scrim until Copy password is pressed', async () => {
    api.create.mockImplementation(async (r) => createWith(r))
    const { onClose } = mount()
    await flush()
    setLabel('Ada')
    pickRole('can type')
    typeInto(pwInput()!, 'longenough1')
    click(btn('Create live link'))
    await flush()
    click(document.querySelector('.confirm-overlay')!)
    expect(onClose).not.toHaveBeenCalled()
    expect(pwInput()!.value).toBe('longenough1')
    click(btn('Copy password'))
    click(document.querySelector('.confirm-overlay')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the done step of a Control link: Escape and the close button still close before the password was copied', async () => {
    api.create.mockImplementation(async (r) => createWith(r))
    const { onClose } = mount()
    await flush()
    setLabel('Ada')
    pickRole('can type')
    click(btn('Create live link'))
    await flush()
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the head close button closes the form, and is disabled while a create is in flight', async () => {
    let release!: (v: string | null) => void
    const { onClose } = mount({ prepare: () => new Promise((r) => (release = r)) })
    await flush()
    setLabel('Ada')
    click(btn('Create live link'))
    const close = document.querySelector<HTMLButtonElement>('.live-dialog__close')!
    expect(close.disabled).toBe(true)
    await act(async () => release('refused'))
    await flush()
    click(document.querySelector<HTMLButtonElement>('.live-dialog__close')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the done step of a watch link closes on the scrim as before', async () => {
    const { onClose } = mount()
    await flush()
    setLabel('Ada')
    click(btn('Create live link'))
    await flush()
    click(document.querySelector('.confirm-overlay')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closing drops the password: nothing on screen keeps it, nothing stored it', async () => {
    api.create.mockImplementation(async (r) => createWith(r))
    const { onClose } = mount()
    await flush()
    setLabel('Ada')
    pickRole('can type')
    typeInto(pwInput()!, 'longenough1')
    click(btn('Create live link'))
    await flush()
    expect(pwInput()!.value).toBe('longenough1')
    click(btn('Done'))
    expect(onClose).toHaveBeenCalledTimes(1)
    const values = [...document.querySelectorAll('input')].map((i) => i.value)
    expect(values).not.toContain('longenough1')
    expect(document.body.textContent).not.toContain('longenough1')
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) expect(store.getItem(store.key(i)!)).not.toContain('longenough1')
    }
  })

  it('a form closed before creating drops the typed password too', async () => {
    const { onClose } = mount()
    await flush()
    pickRole('can type')
    typeInto(pwInput()!, 'longenough1')
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect([...document.querySelectorAll('input')].map((i) => i.value)).not.toContain('longenough1')
  })
})

describe('LiveLinkDialog — Unlimited', () => {
  it('"never" sends ttlSeconds 0', async () => {
    mount()
    await flush()
    setLabel('Ada')
    choose('Expires', 'never')
    expect(trigger('Expires').textContent).toBe('never')
    click(btn('Create live link'))
    await flush()
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ ttlSeconds: 0 }))
  })

  it('an older server refusing Unlimited says to pick an end time', async () => {
    api.create.mockResolvedValue({ ok: false, error: 'ttl-unsupported' })
    mount()
    await flush()
    setLabel('Ada')
    choose('Expires', 'never')
    click(btn('Create live link'))
    await flush()
    expect(document.querySelector('.live-dialog__error')!.textContent).toBe(
      'Unlimited links need a newer server. Pick an end time.'
    )
  })

  it('the done step tells Control apart by its ROLE', () => {
    const done = { phase: 'done', url: 'https://nodeterm.dev/s/x#1.y', linkId: 'x', expiresAt: null } as const
    const control = body({ ...done, role: 'controller', password: 'longenough1' })
    expect(control).toContain('Anyone with this link and the password can type until you stop it.')
    expect(control).toContain('live-dialog__password')
    // A password on a non-Control state (none is ever built) shows nothing of it.
    const watch = body({ ...done, role: 'viewer', password: 'longenough1' })
    expect(watch).toContain('Anyone with this link can watch until you stop it.')
    expect(watch).not.toContain('longenough1')
  })

  it('the done step of an Unlimited watch link says until it is stopped', () => {
    const html = body({ phase: 'done', role: 'viewer', url: 'https://nodeterm.dev/s/x#1.y', linkId: 'x', expiresAt: null })
    expect(html).toContain('Anyone with this link can watch until you stop it.')
    expect(html).not.toContain('live-dialog__password')
  })
})

// ---- the remembered role and expiry (lib/liveLinkDefaults) ---------------------------------------

describe('LiveLinkDialog — remembered choices', () => {
  it('the first dialog opens on "can watch" for an hour', async () => {
    mount()
    await flush()
    expect(roleValue()).toBe('can watch')
    expect(trigger('Expires').textContent).toBe('in 1 hour')
  })

  it('a created link remembers its role and expiry; the next dialog opens on them, Control with a fresh password', async () => {
    api.create.mockImplementation(async (r) => createWith(r))
    mount()
    await flush()
    setLabel('Ada')
    pickRole('can type')
    const first = pwInput()!.value
    choose('Expires', 'in 8 hours')
    click(btn('Create live link'))
    await flush()
    expect(JSON.parse(localStorage.getItem(LIVE_LINK_DEFAULTS_KEY)!)).toEqual({ role: 'controller', ttl: 28800 })

    act(() => root.unmount())
    root = createRoot(host)
    mount()
    await flush()
    expect(roleValue()).toBe('can type')
    expect(trigger('Expires').textContent).toBe('in 8 hours')
    // A fresh password, never the last one, and the typing warning is on screen from the start.
    expect(pwInput()!.value).toMatch(GENERATED)
    expect(pwInput()!.value).not.toBe(first)
    expect(warnings()).toEqual([controlWarningText('this computer')])
  })

  it('a refused create remembers nothing', async () => {
    api.create.mockResolvedValue({ ok: false, error: 'not-entitled' })
    mount()
    await flush()
    setLabel('Ada')
    pickRole('can chat')
    click(btn('Create live link'))
    await flush()
    expect(localStorage.getItem(LIVE_LINK_DEFAULTS_KEY)).toBeNull()
  })

  it('a remembered Control on a terminal that cannot take input opens on "can watch"', async () => {
    localStorage.setItem(LIVE_LINK_DEFAULTS_KEY, JSON.stringify({ role: 'controller', ttl: 3600 }))
    api.controlSupport.mockResolvedValue('unsupported')
    mount()
    await flush()
    expect(roleValue()).toBe('can watch')
    expect(pwInput()).toBeNull()
  })
})
