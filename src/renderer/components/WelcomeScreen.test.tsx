// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WelcomeScreen } from './WelcomeScreen'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const noop = (): void => {}

describe('WelcomeScreen — Recently closed session badges (issue #442)', () => {
  let root: Root
  let host: HTMLElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const render = async (el: React.ReactElement): Promise<void> => {
    await act(async () => root.render(el))
  }

  const base = {
    onNewProject: noop,
    onOpenFolder: noop,
    onCloneRepo: noop,
    onConnectSsh: noop,
    closedProjects: [
      { id: 'p1', name: 'Web', cwd: '/w' },
      { id: 'p2', name: 'API', cwd: '/a' }
    ]
  }

  it('shows a live-session badge only for projects the sweep counted', async () => {
    await render(<WelcomeScreen {...base} sessionCounts={{ p1: 3 }} />)
    const badges = host.querySelectorAll('.welcome__recent-sessions')
    expect(badges).toHaveLength(1)
    expect(badges[0].textContent).toBe('3 running')
    // The tooltip carries what the badge means — parked sessions still running on this machine.
    expect(badges[0].getAttribute('title')).toContain('still running on this machine')
  })

  it('shows NO badge when counts were not measured — a failed sweep is not "0"', async () => {
    await render(<WelcomeScreen {...base} />)
    expect(host.querySelectorAll('.welcome__recent-sessions')).toHaveLength(0)
  })

  it('the × routes through onDeleteClosed without also triggering the row reopen', async () => {
    const onReopen = vi.fn()
    const onDeleteClosed = vi.fn()
    await render(<WelcomeScreen {...base} onReopen={onReopen} onDeleteClosed={onDeleteClosed} />)
    const del = host.querySelector('.welcome__recent-del') as HTMLButtonElement
    act(() => del.click())
    expect(onDeleteClosed).toHaveBeenCalledWith('p1')
    expect(onReopen).not.toHaveBeenCalled()
  })
})

describe('WelcomeScreen — Recently closed filter (issue #506)', () => {
  let root: Root
  let host: HTMLElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const render = async (el: React.ReactElement): Promise<void> => {
    await act(async () => root.render(el))
  }

  const many = Array.from({ length: 7 }, (_, i) => ({
    id: `p${i}`,
    name: i === 3 ? 'dot-github' : `Project ${i}`,
    cwd: `/repos/p${i}`
  }))

  const base = {
    onNewProject: noop,
    onOpenFolder: noop,
    onCloneRepo: noop,
    onConnectSsh: noop
  }

  const type = async (input: HTMLInputElement, value: string): Promise<void> => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('stays out of the way below the visible-row cap', async () => {
    await render(<WelcomeScreen {...base} closedProjects={many.slice(0, 6)} />)
    expect(host.querySelector('.welcome__recent-filter')).toBeNull()
  })

  it('appears once the list is longer than the cap, and narrows by name', async () => {
    await render(<WelcomeScreen {...base} closedProjects={many} />)
    const input = host.querySelector('.welcome__recent-filter') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(host.querySelectorAll('.welcome__recent-item')).toHaveLength(7)

    await type(input, 'dot-git')
    const rows = host.querySelectorAll('.welcome__recent-name')
    expect(Array.from(rows).map((r) => r.textContent)).toEqual(['dot-github'])
  })

  it('narrows by folder too — the row already renders it as the title', async () => {
    await render(<WelcomeScreen {...base} closedProjects={many} />)
    const input = host.querySelector('.welcome__recent-filter') as HTMLInputElement
    await type(input, '/repos/p5')
    expect(host.querySelectorAll('.welcome__recent-item')).toHaveLength(1)
  })

  it('says nothing matched instead of rendering an empty list', async () => {
    await render(<WelcomeScreen {...base} closedProjects={many} />)
    const input = host.querySelector('.welcome__recent-filter') as HTMLInputElement
    await type(input, 'zzzz')
    expect(host.querySelectorAll('.welcome__recent-item')).toHaveLength(0)
    expect(host.querySelector('.welcome__recent-empty')!.textContent).toContain('zzzz')
  })

  it('the section itself stays hidden when there are no closed projects at all', async () => {
    await render(<WelcomeScreen {...base} closedProjects={[]} />)
    expect(host.querySelector('.welcome__recent')).toBeNull()
  })
})

/**
 * The two lists under the cards live in ONE container (`.welcome__lists`), which styles.css makes
 * exactly as wide as the card row and splits into two columns. Before, each list was its own
 * centered max-width box: the page read as a ragged, left-leaning column (#1062 follow-up). The CSS
 * half is pinned in styles.welcome-layout.test.ts; this pins the half the CSS depends on — both
 * sections are direct children of the same container, conversations first, and a section that is not
 * drawn leaves no placeholder behind (`:only-child` is what lets the other span both columns).
 */
describe('WelcomeScreen — one container for both lists', () => {
  let root: Root
  let host: HTMLElement
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })
  const render = async (el: React.ReactElement): Promise<void> => {
    await act(async () => root.render(el))
  }
  const base = { onNewProject: noop, onOpenFolder: noop, onCloneRepo: noop, onConnectSsh: noop }
  const recent = {
    recentConversations: [
      { agentId: 'claude' as const, sessionId: 's1', cwd: '/w', lastActiveAt: 1, title: 'Fix it', titleSource: 'prompt' as const }
    ],
    recentActionFor: () => ({ label: 'Resume' }),
    onResumeRecent: noop
  }
  const closedProjects = [{ id: 'p1', name: 'Web', cwd: '/w' }]
  const lists = (): HTMLElement => {
    const el = host.querySelector<HTMLElement>('.welcome__lists')
    expect(el, 'no .welcome__lists container').not.toBeNull()
    return el!
  }

  it('puts Recent conversations and Recently closed side by side in the same container, in that order', async () => {
    await render(<WelcomeScreen {...base} {...recent} closedProjects={closedProjects} />)
    const kids = [...lists().children]
    expect(kids).toHaveLength(2)
    expect(kids[0].classList.contains('welcome__recent--convs')).toBe(true)
    expect(kids[1].classList.contains('welcome__recent--closed')).toBe(true)
    // The container sits after the card row, as a sibling — not inside it, not before it.
    expect(lists().previousElementSibling?.classList.contains('welcome__cards')).toBe(true)
  })

  it('a lone section is the container’s only child, so it takes the full width', async () => {
    await render(<WelcomeScreen {...base} closedProjects={closedProjects} />)
    expect([...lists().children].map((c) => c.className)).toEqual(['welcome__recent welcome__recent--closed'])
    await render(<WelcomeScreen {...base} {...recent} closedProjects={[]} />)
    expect(lists().children).toHaveLength(1)
    expect(lists().firstElementChild!.classList.contains('welcome__recent--convs')).toBe(true)
  })

  it('an empty conversation list leaves no element behind', async () => {
    await render(<WelcomeScreen {...base} {...recent} recentConversations={[]} closedProjects={closedProjects} />)
    expect(lists().children).toHaveLength(1)
    await render(<WelcomeScreen {...base} />)
    // `:empty` hides it — no stray 28px margin under the cards on a first-run screen.
    expect(lists().childNodes).toHaveLength(0)
  })
})
