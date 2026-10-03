// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import type { GitHubPullBoard } from '@shared/github-pull-status'
import { readPullLinks } from '@shared/kanban-pull-links'
import { useProjects } from '../../state/projects'
import { useGitHubIssues } from '../../state/githubIssues'
import { useSettings } from '../../state/settings'
import { CardPullRequests, PULL_LINK_SSH_REASON } from './CardPullRequests'
import type { KanbanSession } from './KanbanView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const board: ProjectKanban = {
  columns: [{ id: 'doing', title: 'Doing', color: '#fff' }, { id: 'done', title: 'Done', color: '#fff' }],
  assignments: [],
  github: { columnMappings: [], repository: 'o/r' }
}

const session = (over: Partial<KanbanSession> = {}): KanbanSession => ({
  id: 'card-1', title: 'Agent', color: '#fff', kind: 'terminal', spawn: {}, worktreeBranch: 'feat/x', ...over
})

const pullBoard: GitHubPullBoard = {
  pulls: [
    { number: 12, lifecycle: 'open', headRefName: 'feat/x', headRefOid: 'a'.repeat(40), ci: 'passed', merge: 'ready', closes: [] },
    { number: 3, lifecycle: 'closed', headRefName: 'feat/x', closes: [] }
  ],
  observedAt: 1, stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false
}

function setup(ssh = false): void {
  useProjects.setState({
    activeProjectId: 'p1',
    projects: [{
      id: 'p1', name: 'P', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
      ...(ssh ? { ssh: { server: { host: 'h', user: 'u' } as never, remoteCwd: '~' } } : {})
    }]
  } as never)
  useGitHubIssues.setState({ projects: { p1: { pullBoard } as never } })
  useSettings.setState({
    settings: { ...useSettings.getState().settings, kanbanPullAutoMove: { projects: { p1: { columnId: 'done', armedAt: 1 } } } }
  })
}

function render(k: ProjectKanban, card = session()): { host: HTMLElement; onChange: ReturnType<typeof vi.fn> } {
  const host = document.createElement('div')
  const onChange = vi.fn()
  act(() => createRoot(host).render(<CardPullRequests session={card} board={k} onChangeBoard={onChange} />))
  return { host, onChange }
}

beforeEach(() => setup())

describe('CardPullRequests', () => {
  it('lists the PRs from the card\'s worktree branch', () => {
    const { host } = render(board)
    expect(host.textContent).toContain('feat/x')
    expect(host.textContent).toContain('PR #12')
    expect(host.textContent).toContain('PR #3')
  })

  it('unlinking writes a tombstone, so the branch link does not come back', () => {
    const { host, onChange } = render(board)
    const unlink = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Unlink')!
    act(() => unlink.click())
    const next = onChange.mock.calls[0][0] as ProjectKanban
    expect(readPullLinks(next).unlinked).toEqual([{ nodeId: 'card-1', pull: 12 }])
    const again = render(next).host
    expect(again.textContent).toContain('PR #12 (unlinked)')
    expect(again.textContent).toContain('Link again')
  })

  it('says why a closed-unmerged PR blocks the move, and offers the per-card opt-out', () => {
    const { host, onChange } = render(board)
    expect(host.textContent).toContain('closed without merging')
    const optOut = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(optOut.checked).toBe(true)
    act(() => optOut.click())
    expect(readPullLinks(onChange.mock.calls[0][0] as ProjectKanban).noAutoMove).toEqual(['card-1'])
  })

  it('an SSH project says why links are not available instead of showing nothing', () => {
    setup(true)
    expect(render(board).host.textContent).toContain(PULL_LINK_SSH_REASON)
  })

  it('an issue-bound session shows the PRs closing its issue, on SSH too', () => {
    setup(true)
    useGitHubIssues.setState({ projects: { p1: { pullBoard: { ...pullBoard, repository: 'o/r', pulls: [
      { number: 21, lifecycle: 'open', headRefName: 'elsewhere', closes: [4] }
    ] } } as never } })
    const host = render(board, session({ worktreeBranch: undefined, issueRef: { owner: 'o', repo: 'r', number: 4 } })).host
    expect(host.textContent).toContain('PR #21')
    expect(host.textContent).toContain('closes #4')
    expect(host.textContent).not.toContain(PULL_LINK_SSH_REASON)
  })

  it('renders nothing for a board without GitHub or a card outside a worktree group', () => {
    const { github: _github, ...plain } = board
    expect(render(plain).host.textContent).toBe('')
    expect(render(board, session({ worktreeBranch: undefined })).host.textContent).toBe('')
  })
})
