// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCardView } from '@shared/github-issues'
import { GitHubIssueCard } from './GitHubIssueCard'
import { useAgentStatus } from '../../state/agentStatus'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const issue: GitHubIssueCardView = {
  id: 42, number: 42, title: 'Fix polling', body: '', state: 'open', stateReason: null,
  htmlUrl: 'https://github.com/o/r/issues/42', apiUrl: 'https://api.github.com/repos/o/r/issues/42',
  labels: [{ id: 1, name: 'bug', color: 'ff0000' }], assignees: [],
  createdAt: '2026-08-09T00:00:00Z', updatedAt: '2026-08-09T00:00:00Z', locked: false,
  columnId: 'todo', conflict: null
}

describe('GitHubIssueCard', () => {
  it('renders its source and exposes an accessible non-drag move action', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const move = vi.fn()
    act(() => root.render(
      <GitHubIssueCard
        issue={issue}
        columns={[
          { id: 'todo', title: 'Todo', color: '#2563eb' },
          { id: 'done', title: 'Done', color: '#16a34a' }
        ]}
        moving={false}
        readOnly={false}
        onOpen={vi.fn()}
        onMove={move}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />
    ))
    expect(host.textContent).toContain('#42')
    expect(host.textContent).toContain('Fix polling')
    expect(host.textContent).toContain('GH')
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Move issue #42"]')!
    act(() => {
      select.value = 'done'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(move).toHaveBeenCalledWith(issue, 'done')
    const card = host.querySelector<HTMLElement>('[role="button"]')!
    const open = vi.fn()
    act(() => root.render(
      <GitHubIssueCard issue={issue} columns={[]} moving={false} readOnly={false}
        onOpen={open} onMove={vi.fn()} onDragStart={vi.fn()} onDragEnd={vi.fn()} />
    ))
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(open).toHaveBeenCalledWith(issue)
    act(() => root.unmount())
  })

  it('shows a live chip per bound session, and the chip follows that node\'s state', () => {
    useAgentStatus.setState({ byId: {} })
    const host = document.createElement('div')
    const root = createRoot(host)
    const openRun = vi.fn()
    const openIssue = vi.fn()
    act(() => root.render(
      <GitHubIssueCard issue={issue} columns={[]} moving={false} readOnly={false}
        onOpen={openIssue} onMove={vi.fn()} onDragStart={vi.fn()} onDragEnd={vi.fn()}
        runs={[{ id: 'term-1', title: 'Claude', agentId: 'claude' }]} onOpenRun={openRun} />
    ))
    const chip = (): HTMLElement => host.querySelector<HTMLElement>('.issue-run-chip')!
    expect(chip().textContent).toBe('Claude')
    expect(chip().dataset.state).toBe('idle')

    act(() => useAgentStatus.setState({ byId: { 'term-1': { state: 'working', unread: false } } }))
    expect(chip().textContent).toContain('RUNNING')

    act(() => useAgentStatus.setState({ byId: { 'term-1': { state: 'blocked', unread: false } } }))
    expect(chip().textContent).toContain('NEEDS YOU')

    // `done` ends a TURN: the chip goes quiet, it does not claim the issue is finished.
    act(() => useAgentStatus.setState({ byId: { 'term-1': { state: 'done', unread: true } } }))
    expect(chip().dataset.state).toBe('idle')
    expect(chip().querySelector('.kanban-card__unread')).not.toBeNull()

    act(() => chip().dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(openRun).toHaveBeenCalledWith('term-1')
    // The chip's click is the chip's: it does not also open the issue summary behind it.
    expect(openIssue).not.toHaveBeenCalled()
    act(() => root.unmount())
    useAgentStatus.setState({ byId: {} })
  })

  it('draws no chip row for an issue nobody is working on', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(
      <GitHubIssueCard issue={issue} columns={[]} moving={false} readOnly={false}
        onOpen={vi.fn()} onMove={vi.fn()} onDragStart={vi.fn()} onDragEnd={vi.fn()} onOpenRun={vi.fn()} />
    ))
    expect(host.querySelector('.issue-run-chips')).toBeNull()
    act(() => root.unmount())
  })

  it('opens its context menu on right-click', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const context = vi.fn()
    act(() => root.render(
      <GitHubIssueCard issue={issue} columns={[]} moving={false} readOnly={false}
        onOpen={vi.fn()} onMove={vi.fn()} onDragStart={vi.fn()} onDragEnd={vi.fn()} onContext={context} />
    ))
    const card = host.querySelector<HTMLElement>('[role="button"]')!
    act(() => card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 20 })))
    expect(context).toHaveBeenCalledWith(issue, 10, 20)
    act(() => root.unmount())
  })
})
