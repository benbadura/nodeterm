// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubAuthStatus, GitHubControlView } from '@shared/github-issues'
import { useProjects } from '../../../state/projects'
import { useSettings } from '../../../state/settings'
import { DEFAULT_SETTINGS } from '@shared/types'
import { dispatchBinding } from '@shared/board-dispatch'
import { registerWorkspaceDirty } from '../../../state/workspaceDirty'
import { SettingsSearchContext } from '../context'
import { GitHubIssuesSection, STATUS_AFTER_EDIT_MS } from './GitHubIssuesSection'
import { SAVE_DEBOUNCE_MS } from '../../../lib/savePersistence'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AUTH: GitHubAuthStatus = {
  selectedProvider: 'auto', activeProvider: 'token', ghAuthenticated: false,
  tokenPresent: true, storage: 'encrypted', login: 'octocat'
}

function viewWith(auth: Partial<GitHubAuthStatus>, approved = false): GitHubControlView {
  return {
    control: { revision: 0, authProvider: auth.selectedProvider ?? AUTH.selectedProvider },
    auth: { ...AUTH, ...auth },
    project: {
      projectId: 'p1', repository: 'owner/repo', detectedRepository: 'owner/repo', approved
    }
  }
}

/** What `GitHubHostController.status(projectId)` returns for a project that is not approved: the
 *  auth block is masked, so it says nothing about whether the user is signed in. */
function masked(selected: GitHubAuthStatus['selectedProvider'] = 'auto'): GitHubControlView {
  return {
    control: { revision: 0, authProvider: selected },
    auth: {
      selectedProvider: selected, activeProvider: null, ghAuthenticated: false,
      tokenPresent: false, storage: 'encrypted'
    },
    project: {
      projectId: 'p1', repository: 'owner/repo', detectedRepository: 'owner/repo', approved: false
    }
  }
}

describe('GitHubIssuesSection', () => {
  let root: Root
  let host: HTMLElement
  let saveToken: ReturnType<typeof vi.fn>
  let status: ReturnType<typeof vi.fn>
  let dirty: ReturnType<typeof vi.fn<() => void>>
  let unregisterDirty: () => void

  const mount = async (query = ''): Promise<void> => {
    root = createRoot(host)
    await act(async () => {
      root.render(
        <SettingsSearchContext.Provider value={query}>
          <GitHubIssuesSection isActive />
        </SettingsSearchContext.Provider>
      )
    })
  }

  /** `status(projectId)` answers the project view, `status()` the project-independent auth block. */
  const stub = (projectView: GitHubControlView, global = projectView): void => {
    status = vi.fn(async (projectId?: string) => (projectId ? projectView : { ...global, project: undefined }))
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.githubControl.status = status
  }

  const advanced = (): HTMLDetailsElement =>
    host.querySelector<HTMLDetailsElement>('details.github-auth-advanced')!

  beforeEach(async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    dirty = vi.fn<() => void>()
    unregisterDirty = registerWorkspaceDirty(dirty)
    saveToken = vi.fn(async () => viewWith({}))
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal = {
      githubControl: {
        status: vi.fn(),
        approve: vi.fn(),
        revoke: vi.fn(),
        selectProvider: vi.fn(),
        saveToken,
        clearToken: vi.fn()
      },
      githubIssues: {
        createMissingLabels: vi.fn(), refresh: vi.fn(), clearCache: vi.fn()
      }
    }
    stub(viewWith({}))
    useProjects.setState({
      activeProjectId: 'p1',
      projects: [{
        id: 'p1', name: 'Project', color: '#8b5cf6', viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [], cwd: '/repo',
        kanban: {
          columns: [
            { id: 'todo', title: 'Todo', color: '#2563eb' },
            { id: 'done', title: 'Done', color: '#16a34a' }
          ],
          assignments: [],
          github: {
            columnMappings: [
              { columnId: 'todo', label: 'status:todo' },
              { columnId: 'done', label: 'status:done' }
            ],
            completionColumnId: 'done'
          }
        }
      }]
    })
  })

  afterEach(() => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS } })
    act(() => root.unmount())
    host.remove()
    unregisterDirty()
  })

  // #1090: `dispatchStale` is computed during render and reads `repository` through
  // `dispatchBindingFor`. While that `const` was declared below the early returns, any render with a
  // dispatch entry for the active project threw a TDZ ReferenceError and blanked all of Settings.
  const withDispatch = (binding: string): void => {
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        boardDispatch: {
          paused: false,
          projects: { p1: { columnId: 'todo', agentId: 'claude', maxConcurrent: 1, binding } }
        }
      }
    })
  }

  it('renders with dispatch switched on for the active project (#1090)', async () => {
    withDispatch(dispatchBinding('owner/repo', 'Todo', 'status:todo')!)
    stub(viewWith({}, true))
    await mount()
    expect(host.textContent).toContain('Dispatch agents')
    expect(host.textContent).not.toContain('Nothing dispatches until you confirm it again')
  })

  it('still flags a dispatch binding that no longer matches the column (#1090)', async () => {
    withDispatch(dispatchBinding('owner/repo', 'Renamed', 'status:todo')!)
    stub(viewWith({}, true))
    await mount()
    expect(host.textContent).toContain('Nothing dispatches until you confirm it again')
  })

  it('does not call a dispatch binding stale before the repository is known (#1090)', async () => {
    withDispatch(dispatchBinding('owner/repo', 'Todo', 'status:todo')!)
    status = vi.fn(() => new Promise<GitHubControlView>(() => {}))
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.githubControl.status = status
    await mount()
    expect(host.textContent).toContain('Dispatch agents')
    expect(host.textContent).not.toContain('Nothing dispatches until you confirm it again')
  })

  it('says until when sync is held, and how much of the GitHub budget is left', async () => {
    stub({
      ...viewWith({}, true),
      rate: { resource: 'core', limit: 5_000, remaining: 12, resetAt: Date.UTC(2026, 8, 28, 21, 0), observedAt: 1 },
      throttle: { until: Date.UTC(2026, 8, 28, 21, 0), kind: 'low-budget' }
    })
    await mount()
    expect(host.textContent).toContain('Background sync paused until')
    expect(host.textContent).toContain('12 of 5,000 GitHub requests left')
  })

  it('says GitHub could not be reached — never "not signed in" — when the sign-in could not be checked', async () => {
    stub(viewWith({
      activeProvider: null, ghAuthenticated: false, tokenPresent: false, login: undefined,
      unreachable: { reason: 'unreachable' }
    }, true))
    await mount()
    expect(host.textContent).toContain('GitHub could not be reached to check the sign-in.')
    expect(host.textContent).not.toContain('not signed in')
    expect(host.textContent).not.toContain('Authentication is still needed')
  })

  it('keeps the last confirmed sign-in on screen through a rate limit, and says it is the last one', async () => {
    stub(viewWith({
      activeProvider: 'gh', ghAuthenticated: true, login: 'octocat',
      unreachable: { reason: 'rate-limited' }
    }, true))
    await mount()
    expect(host.textContent).toContain('✓ Signed in via GitHub CLI as @octocat')
    expect(host.textContent).toContain('GitHub’s rate limit was reached, so the sign-in could not be checked')
    expect(host.textContent).toContain('the last one GitHub confirmed')
  })

  it('names a rate limit or an outage instead of a generic failure', async () => {
    stub(viewWith({}, true))
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.githubIssues.refresh =
      vi.fn(async () => { throw new Error("Error invoking remote method 'github-issues:refresh': Error: rate-limited") })
    await mount()
    const refresh = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Refresh now')!
    await act(async () => { refresh.click() })
    expect(host.textContent).toContain('GitHub’s rate limit was reached. Try again later.')

    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.githubIssues.refresh =
      vi.fn(async () => { throw new Error("Error invoking remote method 'github-issues:refresh': Error: github-unreachable") })
    await act(async () => { refresh.click() })
    expect(host.textContent).toContain('GitHub could not be reached. Nothing was changed')
  })

  it('asks to approve a changed column mapping before the board may change issues again', async () => {
    const approve = vi.fn(async () => viewWith({}, true))
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.githubControl.approve = approve
    const view = viewWith({}, true)
    stub({ ...view, project: { ...view.project!, mappingApproved: false } })
    await mount()
    expect(host.textContent).toContain('The column labels changed since this machine approved them')
    expect(host.textContent).not.toContain('Ready as')
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Approve column labels')!
    await act(async () => { button.click() })
    expect(approve).toHaveBeenCalledWith({ projectId: 'p1', repository: 'owner/repo', expectedRevision: 0 })
  })

  it('re-reads the status once a label edit has had time to save, instead of keeping "Ready as"', async () => {
    stub(viewWith({}, true))
    await mount()
    const before = status.mock.calls.length
    vi.useFakeTimers()
    try {
      const input = host.querySelector<HTMLInputElement>('#github-label-todo')!
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, 'workflow:ready')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      // Not before the edit can have reached the project file the host reads.
      await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS) })
      expect(status.mock.calls.length).toBe(before)
      await act(async () => { vi.advanceTimersByTime(STATUS_AFTER_EDIT_MS - SAVE_DEBOUNCE_MS) })
      expect(status.mock.calls.length).toBeGreaterThan(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the write-only token field after Save and never renders the stored token', async () => {
    await mount()
    const input = host.querySelector<HTMLInputElement>('#github-personal-access-token')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'github_pat_secret')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save token')!
    await act(async () => { save.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(saveToken).toHaveBeenCalledWith('github_pat_secret')
    expect(input.value).toBe('')
    expect(host.textContent).not.toContain('github_pat_secret')
  })

  it('updates exact label mappings in the shared project board', async () => {
    await mount()
    const input = host.querySelector<HTMLInputElement>('#github-label-todo')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'workflow:ready')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(useProjects.getState().getProject('p1')?.kanban?.github?.columnMappings)
      .toContainEqual({ columnId: 'todo', label: 'workflow:ready' })
  })


  // A board edit made here reaches `.nodeterm/project.json` only through the debounced save Canvas
  // owns: the host reads the project from DISK (`workspaceStore.githubProject`), so an unsaved
  // config makes `resolveProject` throw `invalid-configuration` and Approve fail.
  it('persists a label edit through the workspace-dirty seam', async () => {
    await mount()
    const input = host.querySelector<HTMLInputElement>('#github-label-todo')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'workflow:ready')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(dirty).toHaveBeenCalled()
  })

  it('persists enabling and disabling GitHub issues', async () => {
    await mount()
    const toggle = host.querySelector<HTMLElement>('[aria-label="Include GitHub issues"]')!
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(useProjects.getState().getProject('p1')?.kanban?.github).toBeUndefined()
    expect(dirty).toHaveBeenCalled()
  })



  // Before lifecycle categories the default was simply the LAST column; a board with an archive
  // column after Done would then close issues into the archive.
  it('defaults the completion column to the board\'s Done-category column, not merely the last one', async () => {
    useProjects.setState({
      activeProjectId: 'p1',
      projects: [{
        id: 'p1', name: 'Project', color: '#8b5cf6', viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [], cwd: '/repo',
        kanban: {
          columns: [
            { id: 'todo', title: 'Todo', color: '#2563eb', category: 'unstarted' },
            { id: 'shipped', title: 'Shipped', color: '#16a34a', category: 'done' },
            { id: 'archive', title: 'Archive', color: '#8e8e93', category: 'closed' }
          ],
          assignments: []
        }
      }]
    })
    await mount()
    const toggle = host.querySelector<HTMLElement>('[aria-label="Include GitHub issues"]')!
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(useProjects.getState().getProject('p1')?.kanban?.github?.completionColumnId).toBe('shipped')
  })

  it('reports an Approve failure beside the Approve button, not three rows below it', async () => {
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.githubControl.approve =
      vi.fn(async () => { throw Object.assign(new Error('invalid-configuration'), { code: 'invalid-configuration' }) })
    await mount()
    const approve = [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Approve this machine')!
    await act(async () => { approve.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const message = [...host.querySelectorAll('[role="status"]')]
      .find((element) => element.textContent?.includes('have not finished saving'))!
    expect(message).toBeDefined()
    // Same container as the button: the user sees the answer where they clicked.
    expect(message.closest('div')?.parentElement?.contains(approve)).toBe(true)
  })


  it('moves the single token control into Advanced when the GitHub CLI signs the user in', async () => {
    stub(viewWith({ activeProvider: 'gh', ghAuthenticated: true, tokenPresent: false }, true))
    await mount()
    const inputs = host.querySelectorAll('#github-personal-access-token')
    expect(inputs).toHaveLength(1)
    expect(advanced().contains(inputs[0])).toBe(true)
    expect(host.textContent).toContain('✓ Signed in via GitHub CLI as @octocat')
    expect(host.textContent).not.toContain('gh auth login')
  })

  it('says a saved token is kept as a fallback instead of pretending none exists', async () => {
    stub(viewWith({ activeProvider: 'gh', ghAuthenticated: true, tokenPresent: true }, true))
    await mount()
    expect(host.textContent).toContain('A saved token is kept as a fallback.')
  })

  it('reads the unmasked auth block for a project that is not approved yet', async () => {
    // The project view masks auth to all-false; the signed-in truth only exists in status().
    stub(masked(), viewWith({ activeProvider: 'gh', ghAuthenticated: true, tokenPresent: false }))
    await mount()
    expect(host.textContent).toContain('✓ Signed in via GitHub CLI')
    expect(host.textContent).not.toContain('GitHub CLI is not signed in')
    expect(status.mock.calls).toContainEqual([])
  })

  it('falls back to "not checked yet" rather than "signed out" when the auth read fails', async () => {
    status = vi.fn(async (projectId?: string) => {
      if (!projectId) throw new Error('boom')
      return masked()
    })
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.githubControl.status = status
    await mount()
    expect(host.textContent).toContain('GitHub authentication has not been checked yet.')
    expect(host.textContent).not.toContain('GitHub CLI is not signed in')
  })

  it('does not claim the CLI signs the user in when authentication is pinned to a token', async () => {
    stub(viewWith({
      selectedProvider: 'token', activeProvider: null, ghAuthenticated: true, tokenPresent: false,
      login: undefined
    }, true))
    await mount()
    expect(host.textContent).not.toContain('✓ Signed in via GitHub CLI')
    expect(host.textContent).toContain('pinned to a personal access token')
    expect(host.textContent).toContain('it is signed in, but ignored')
  })

  it('does not offer an inert token when authentication is pinned to the GitHub CLI', async () => {
    stub(viewWith({
      selectedProvider: 'gh', activeProvider: null, ghAuthenticated: false, tokenPresent: false,
      login: undefined
    }, true))
    await mount()
    expect(host.textContent).toContain('pinned to the GitHub CLI')
    expect(host.textContent).not.toContain('paste a personal access token below')
    expect(advanced().contains(host.querySelector('#github-personal-access-token')!)).toBe(true)
  })

  it('re-reads the status when the user checks again after signing in', async () => {
    stub(viewWith({ selectedProvider: 'gh', activeProvider: null, ghAuthenticated: false }, true))
    await mount()
    expect(host.textContent).toContain('GitHub CLI is not signed in')
    stub(viewWith({ selectedProvider: 'gh', activeProvider: 'gh', ghAuthenticated: true }, true))
    const again = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Check again')!
    await act(async () => { again.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(host.textContent).toContain('✓ Signed in via GitHub CLI as @octocat')
  })

  it('opens Advanced while a settings search is active so a matched control is reachable', async () => {
    stub(viewWith({ activeProvider: 'gh', ghAuthenticated: true, tokenPresent: false }, true))
    await mount('token')
    expect(advanced().open).toBe(true)
    expect(host.querySelector('#github-personal-access-token')).not.toBeNull()
  })
})
