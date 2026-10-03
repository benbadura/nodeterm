// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShareTeamDialog, ShareTeamDialogBody, type ShareDialogState } from './ShareTeamDialog'
import { resetDialogStack } from './dialog-stack'
import type { ShareConfirmSummary, ShareOutcome, SharePhase } from '../lib/shareSshTeam'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const noop = (): void => {}
const body = (state: ShareDialogState, extra: Partial<Parameters<typeof ShareTeamDialogBody>[0]> = {}) =>
  renderToStaticMarkup(
    <ShareTeamDialogBody
      projectName="proj"
      state={state}
      onConfirm={noop}
      onCancel={noop}
      onClose={noop}
      onCopy={noop}
      onCancelInstall={noop}
      {...extra}
    />
  )
const SECURITY = 'Editors get a shell as alice on box and can make themselves owners; Viewers cannot.'
const SUMMARY: ShareConfirmSummary = {
  host: 'box',
  user: 'alice',
  install: 'missing',
  restartsService: false,
  resumable: [{ nodeId: 'a', title: 'Claude' }],
  manual: [{ node: { nodeId: 'x', title: 'Work' }, reason: 'runs under a managed account' }],
  stopping: [{ node: { nodeId: 'p', title: 'dev server' }, command: 'npm' }],
  security: SECURITY
}
const SHARED: Extract<ShareOutcome, { kind: 'shared' }> = {
  kind: 'shared',
  joinCode: 'ntj1.CODE',
  teamLabel: 'Box team',
  projectName: 'proj',
  hosting: 'up',
  resumed: [{ nodeId: 'a', title: 'Claude' }],
  notResumed: [{ node: { nodeId: 'x', title: 'Work' }, reason: 'runs under a managed account' }],
  stillOnSsh: [{ nodeId: 'q', title: 'logs' }]
}
const RESTORED_SENTENCE = 'The SSH project was reopened; nothing was changed.'
const RESTORE_FAILED_SENTENCE = 'The SSH project could not be restored automatically. Reopen it from Recently closed.'

describe('ShareTeamDialogBody', () => {
  it('confirm shows host, install, the security sentence and all three lists', () => {
    const html = body({ phase: 'confirm', summary: SUMMARY })
    for (const s of [
      'Share proj with a team',
      'alice@box',
      'about 600 MB',
      'Editors get a shell as alice on box',
      'These agents continue on the server:',
      'Claude',
      'These terminals are running something that will stop:',
      'dev server',
      'npm',
      'These agents will not be resumed — resume them by hand:',
      'Work',
      'runs under a managed account',
      '>Share<',
      '>Cancel<'
    ]) {
      expect(html).toContain(s)
    }
  })

  it('confirm words each install reason exactly, and the restart only when one happens', () => {
    expect(body({ phase: 'confirm', summary: SUMMARY })).toContain(
      'nodeterm-server will be installed on the host: about 600 MB, built from source, as a systemd --user service that updates itself daily.'
    )
    expect(body({ phase: 'confirm', summary: { ...SUMMARY, install: 'outdated' } })).toContain(
      'nodeterm-server on the host is too old for this and will be updated (the same installer).'
    )
    expect(body({ phase: 'confirm', summary: { ...SUMMARY, install: 'not-running' } })).toContain(
      'nodeterm-server on the host is not answering and will be reinstalled and restarted.'
    )
    const restart = 'Updating restarts the server; teammates connected to it are briefly disconnected.'
    expect(body({ phase: 'confirm', summary: SUMMARY })).not.toContain(restart)
    expect(body({ phase: 'confirm', summary: { ...SUMMARY, install: 'outdated', restartsService: true } })).toContain(restart)
    // A ready server: no install line at all.
    expect(body({ phase: 'confirm', summary: { ...SUMMARY, install: null } })).not.toContain('nodeterm-server')
  })

  it('confirm leaves out an empty list', () => {
    const html = body({ phase: 'confirm', summary: { ...SUMMARY, manual: [], stopping: [] } })
    expect(html).toContain('These agents continue on the server:')
    expect(html).not.toContain('These terminals are running something that will stop:')
    expect(html).not.toContain('These agents will not be resumed')
  })

  it('running shows the step line and, while installing, the log and a Cancel', () => {
    const html = body({ phase: 'running', step: 'installing', log: 'cloning…' })
    expect(html).toContain('Installing nodeterm-server on the host.')
    expect(html).toContain('cloning…')
    expect(html).toContain('Cancel')
    // The panel takes focus, not the Cancel: a stray Enter must not stop a long install.
    expect(html).not.toContain('data-autofocus')
    expect(body({ phase: 'running', step: 'bootstrapping', log: '' })).not.toContain('Cancel')
    expect(body({ phase: 'running', step: 'bootstrapping', log: 'cloning…' })).not.toContain('cloning…')
  })

  it('words every step exactly', () => {
    const lines: Record<SharePhase, string> = {
      probing: 'Checking the host…',
      installing: 'Installing nodeterm-server on the host. This can take several minutes…',
      'checking-install': 'Checking the install…',
      releasing: 'Saving the canvas to the host…',
      bootstrapping: 'Setting up the team…',
      'handing-over': 'Moving the terminals to the server…',
      joining: 'Joining the team…'
    }
    for (const [step, line] of Object.entries(lines)) {
      expect(body({ phase: 'running', step: step as SharePhase, log: '' })).toContain(line)
    }
  })

  it('the install log shows only its last 4000 characters', () => {
    const html = body({ phase: 'running', step: 'installing', log: 'HEAD' + 'x'.repeat(4000) })
    expect(html).not.toContain('HEAD')
    expect(html).toContain('x'.repeat(4000))
    expect(html).toContain('role="log"')
  })

  it('shared shows the code with Copy, the security note, and the result lists', () => {
    const html = body({ phase: 'done', outcome: SHARED, security: SECURITY })
    for (const s of [
      'Shared with Box team',
      'Invite code',
      'ntj1.CODE',
      '>Copy<',
      'Give this code to teammates. An owner approves each new device.',
      SECURITY,
      'This computer is joining the team; its tab opens when it connects.',
      'Resumed on the server:',
      'Claude',
      'Not resumed:',
      'Work — runs under a managed account',
      'Still running on SSH (not moved):',
      'logs',
      '>Close<'
    ]) {
      expect(html).toContain(s)
    }
    expect(html).not.toContain('Hosting is starting')
    expect(body({ phase: 'done', outcome: SHARED, copied: true })).toContain('>Copied<')
  })

  it('shared says hosting is still starting only when it is', () => {
    expect(body({ phase: 'done', outcome: { ...SHARED, hosting: 'starting' } })).toContain(
      'Hosting is starting — the code works in a moment.'
    )
  })

  it('shared leaves out an empty result list', () => {
    const html = body({ phase: 'done', outcome: { ...SHARED, notResumed: [], stillOnSsh: [] } })
    expect(html).toContain('Resumed on the server:')
    expect(html).not.toContain('Not resumed:')
    expect(html).not.toContain('Still running on SSH')
  })

  it('refused shows the reason and the busy agents', () => {
    const html = body({
      phase: 'done',
      outcome: {
        kind: 'refused',
        reason: 'Wait for these agents to finish (or stop them), then share again.',
        busy: [{ nodeId: 'a', title: 'Busy Claude' }]
      }
    })
    expect(html).toContain('Wait for these agents to finish (or stop them), then share again.')
    expect(html).toContain('Busy Claude')
    expect(html).toContain('>Close<')
  })

  it('failed says whether the SSH project was reopened', () => {
    const failed = { kind: 'failed', step: 'bootstrapping', error: 'boom' } as const
    const reopened = body({ phase: 'done', outcome: { ...failed, reopened: true } })
    expect(reopened).toContain('Could not share: boom')
    expect(reopened).toContain(RESTORED_SENTENCE)
    expect(reopened).toContain('>Close<')
    expect(body({ phase: 'done', outcome: { ...failed, reopened: false } })).not.toContain(RESTORED_SENTENCE)
  })

  it('failed never claims nothing changed when the undo itself failed', () => {
    for (const reopened of [false, true]) {
      const html = body({ phase: 'done', outcome: { kind: 'failed', step: 'bootstrapping', error: 'boom', reopened, restoreFailed: true } })
      expect(html).toContain('Could not share: boom')
      expect(html).toContain(RESTORE_FAILED_SENTENCE)
      expect(html).not.toContain(RESTORED_SENTENCE)
    }
    expect(body({ phase: 'done', outcome: { kind: 'failed', step: 'probing', error: 'x', reopened: false } })).not.toContain(
      RESTORE_FAILED_SENTENCE
    )
  })

  it('failed shows the install log it carries', () => {
    const html = body({ phase: 'done', outcome: { kind: 'failed', step: 'checking-install', error: 'x', reopened: false, log: 'npm ERR! boom' } })
    expect(html).toContain('npm ERR! boom')
    expect(html).toContain('role="log"')
  })
})

// ---- the mounted dialog ----------------------------------------------------------------------

type Ui = Parameters<Parameters<typeof ShareTeamDialog>[0]['start']>[0]

let api: {
  onInstallOutput: ReturnType<typeof vi.fn<(projectId: string, listener: (text: string) => void) => () => void>>
  cancelInstall: ReturnType<typeof vi.fn<(projectId: string) => Promise<void>>>
}
let output: ((text: string) => void) | null
let unsubscribed: number
let writeText: ReturnType<typeof vi.fn<(text: string) => void>>
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  resetDialogStack()
  output = null
  unsubscribed = 0
  api = {
    onInstallOutput: vi.fn((_id: string, listener: (text: string) => void) => {
      output = listener
      return () => {
        unsubscribed++
        output = null
      }
    }),
    cancelInstall: vi.fn(async () => {})
  }
  writeText = vi.fn()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    shareTeam: api,
    clipboard: { writeText }
  }
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
const btn = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('.share-team button')].find((b) => b.textContent === label)
const click = (el: Element): void => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const escape = (): void => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
const text = (): string => document.querySelector('.share-team')?.textContent ?? ''

function mount(start: (ui: Ui) => Promise<ShareOutcome>): { onClose: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn()
  const startFn = vi.fn(start)
  act(() => root.render(<ShareTeamDialog projectId="p1" projectName="proj" start={startFn} onClose={onClose} />))
  return { onClose, start: startFn }
}

describe('ShareTeamDialog', () => {
  it('the wrapper drives start(): confirm resolves from the Share button, the outcome renders', async () => {
    let finish!: (o: ShareOutcome) => void
    let agreed: boolean | undefined
    const { onClose, start } = mount(async (ui) => {
      ui.phase('probing')
      agreed = await ui.confirm(SUMMARY)
      ui.phase('bootstrapping')
      return new Promise<ShareOutcome>((r) => (finish = r))
    })
    await flush()
    expect(start).toHaveBeenCalledTimes(1)
    expect(text()).toContain('Share proj with a team')
    click(btn('Share')!)
    await flush()
    expect(agreed).toBe(true)
    expect(text()).toContain('Setting up the team…')
    await act(async () => finish(SHARED))
    expect(text()).toContain('Shared with Box team')
    // The confirm's security sentence is carried into the result.
    expect(text()).toContain(SECURITY)
    expect(onClose).not.toHaveBeenCalled()
    click(btn('Close')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Cancel at the confirm cancels the run and closes the dialog', async () => {
    let agreed: boolean | undefined
    const { onClose } = mount(async (ui) => {
      agreed = await ui.confirm(SUMMARY)
      return agreed ? SHARED : { kind: 'cancelled' }
    })
    await flush()
    click(btn('Cancel')!)
    await flush()
    expect(agreed).toBe(false)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the step while probing, before anything is asked', async () => {
    mount(async (ui) => {
      ui.phase('probing')
      return new Promise<ShareOutcome>(() => {})
    })
    await flush()
    expect(text()).toContain('Checking the host…')
  })

  it('Escape cancels at the confirm, is ignored while running, and closes once done', async () => {
    let finish!: (o: ShareOutcome) => void
    let agreed: boolean | undefined
    const run = mount(async (ui) => {
      agreed = await ui.confirm(SUMMARY)
      return agreed ? SHARED : { kind: 'cancelled' }
    })
    await flush()
    escape()
    await flush()
    expect(agreed).toBe(false)
    expect(run.onClose).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
    root = createRoot(host)
    const second = mount(async (ui) => {
      ui.phase('bootstrapping')
      return new Promise<ShareOutcome>((r) => (finish = r))
    })
    await flush()
    escape()
    click(document.querySelector('.confirm-overlay')!)
    expect(second.onClose).not.toHaveBeenCalled()
    await act(async () => finish({ kind: 'failed', step: 'bootstrapping', error: 'boom', reopened: true }))
    expect(text()).toContain('Could not share: boom')
    escape()
    expect(second.onClose).toHaveBeenCalledTimes(1)
  })

  it('streams the install output into the log, and Cancel stops the install', async () => {
    mount(async (ui) => {
      ui.phase('installing')
      return new Promise<ShareOutcome>(() => {})
    })
    await flush()
    expect(api.onInstallOutput).toHaveBeenCalledWith('p1', expect.any(Function))
    act(() => output!('cloning…\n'))
    act(() => output!('building…\n'))
    expect(document.querySelector('[role="log"]')!.textContent).toBe('cloning…\nbuilding…\n')
    expect(document.activeElement?.classList.contains('share-team')).toBe(true)
    expect(document.activeElement).not.toBe(btn('Cancel'))
    click(btn('Cancel')!)
    expect(api.cancelInstall).toHaveBeenCalledWith('p1')
  })

  it('keeps the log across a step change and unsubscribes on close', async () => {
    let ui!: Ui
    mount(async (u) => {
      ui = u
      u.phase('installing')
      return new Promise<ShareOutcome>(() => {})
    })
    await flush()
    act(() => output!('built\n'))
    act(() => ui.phase('checking-install'))
    act(() => ui.phase('installing'))
    expect(document.querySelector('[role="log"]')!.textContent).toBe('built\n')
    act(() => root.unmount())
    expect(unsubscribed).toBe(1)
    root = createRoot(host)
  })

  it('a failed install shows the output it streamed', async () => {
    let finish!: (o: ShareOutcome) => void
    mount(async (ui) => {
      ui.phase('installing')
      return new Promise<ShareOutcome>((r) => (finish = r))
    })
    await flush()
    act(() => output!('npm ERR! gyp\n'))
    await act(async () => finish({ kind: 'failed', step: 'checking-install', error: 'not ready', reopened: false }))
    expect(text()).toContain('Could not share: not ready')
    expect(document.querySelector('[role="log"]')!.textContent).toBe('npm ERR! gyp\n')
  })

  it('Copy puts the invite code on the clipboard and says so', async () => {
    mount(async () => SHARED)
    await flush()
    click(btn('Copy')!)
    expect(writeText).toHaveBeenCalledWith('ntj1.CODE')
    expect(btn('Copied')).toBeDefined()
  })

  it('a start that rejects shows the failure (the project is not touched here)', async () => {
    mount(async (ui) => {
      ui.phase('probing')
      throw new Error('bridge gone')
    })
    await flush()
    expect(text()).toContain('Could not share: bridge gone')
    expect(text()).not.toContain(RESTORED_SENTENCE)
  })

  it('a pending confirm answers no when the dialog goes away', async () => {
    let agreed: boolean | undefined
    mount(async (ui) => {
      agreed = await ui.confirm(SUMMARY)
      return { kind: 'cancelled' }
    })
    await flush()
    act(() => root.unmount())
    await flush()
    expect(agreed).toBe(false)
    root = createRoot(host)
  })
})
