// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDialogStack } from '../dialog-stack'
import { useProjects } from '../../state/projects'

const h = vi.hoisted(() => ({
  browser: false,
  localRead: vi.fn(async (_p: string) => 'local text'),
  sshRead: vi.fn(async (_p: string) => 'remote text'),
  sshFsFor: [] as string[],
  api: null as unknown
}))

vi.mock('../../session/session', () => ({
  // A STABLE api, like the real session's: the component memoizes its filesystem on it.
  useSession: () => {
    h.api ??= { fs: { read: h.localRead, readBinary: vi.fn() } }
    return { api: h.api }
  }
}))
vi.mock('../../terminal/ssh-fs', () => ({
  sshFs: (projectId: string) => {
    h.sshFsFor.push(projectId)
    return { read: h.sshRead, readBinary: vi.fn() }
  }
}))
vi.mock('../../bridge/runtime', () => ({ isBrowserRuntime: () => h.browser }))

import { LocalFilePreviewModal } from './LocalFilePreviewModal'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => {})
}

describe('LocalFilePreviewModal', () => {
  let host: HTMLDivElement
  let root: Root
  const writeHtml = vi.fn(async () => '/userData/agent-web/x.html')
  const allow = vi.fn(async () => 'nt-media://x')

  beforeEach(() => {
    resetDialogStack()
    h.browser = false
    h.sshFsFor.length = 0
    h.localRead.mockClear()
    h.sshRead.mockClear()
    writeHtml.mockClear()
    ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { media: { writeHtml, allow } }
    useProjects.setState({ activeProjectId: 'local1' })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.innerHTML = ''
  })

  it("reads an SSH card's file through THAT card's project, and offers no canvas jump off-project", async () => {
    act(() =>
      root.render(
        <LocalFilePreviewModal file={{ path: '/srv/app/notes.txt', projectId: 'ssh1', ssh: true }} onClose={vi.fn()} />
      )
    )
    await flush()
    expect(h.sshFsFor).toEqual(['ssh1'])
    expect(h.localRead).not.toHaveBeenCalled()
    expect(document.body.querySelector('.local-file-preview__body pre')?.textContent).toBe('remote text')
    // The active project is local1: "Open on canvas" would land on the wrong canvas.
    expect(document.body.querySelector('[title="Open on canvas"]')).toBeNull()
  })

  it('opens on the canvas as a VIEW for a card of the active project', async () => {
    const seen: unknown[] = []
    const on = (e: Event): void => void seen.push((e as CustomEvent).detail)
    window.addEventListener('nodeterm:open-file', on)
    act(() =>
      root.render(
        <LocalFilePreviewModal file={{ path: '/p/report.txt', projectId: 'local1', ssh: false }} onClose={vi.fn()} />
      )
    )
    await flush()
    act(() => document.body.querySelector<HTMLButtonElement>('[title="Open on canvas"]')!.click())
    window.removeEventListener('nodeterm:open-file', on)
    expect(seen).toEqual([{ path: '/p/report.txt', ssh: false, view: true }])
  })

  it('renders HTML from the CSP jail on desktop', async () => {
    h.localRead.mockResolvedValueOnce('<h1>hi</h1>')
    act(() =>
      root.render(
        <LocalFilePreviewModal file={{ path: '/p/page.html', projectId: 'local1', ssh: false }} onClose={vi.fn()} />
      )
    )
    await flush()
    expect(writeHtml).toHaveBeenCalledWith('<h1>hi</h1>')
    expect(document.body.querySelector('webview')?.getAttribute('src')).toBe('nt-media://x')
  })

  it('shows HTML source in a browser tab (no webview, no jail)', async () => {
    h.browser = true
    h.localRead.mockResolvedValueOnce('<h1>hi</h1>')
    act(() =>
      root.render(
        <LocalFilePreviewModal file={{ path: '/p/page.html', projectId: 'local1', ssh: false }} onClose={vi.fn()} />
      )
    )
    await flush()
    expect(writeHtml).not.toHaveBeenCalled()
    expect(document.body.querySelector('webview')).toBeNull()
    expect(document.body.querySelector('.local-file-preview__body pre')?.textContent).toBe('<h1>hi</h1>')
  })
})
