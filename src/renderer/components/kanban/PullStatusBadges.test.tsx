// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCardView } from '@shared/github-issues'
import { pullStatusFrom, type GitHubPullStatus, type PullStatusFacts } from '@shared/github-pull-status'
import { GitHubPullCard } from './GitHubPullCard'
import { GitHubIssueCard } from './GitHubIssueCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HEAD = 'a'.repeat(40)
const ALL = { ci: true, merge: true }

const item = (over: Partial<GitHubIssueCardView> = {}): GitHubIssueCardView => ({
  id: 7, number: 7, title: 'Pull cards', body: '', state: 'open', stateReason: null,
  htmlUrl: 'https://github.com/o/r/pull/7', apiUrl: 'https://api.github.com/repos/o/r/issues/7',
  labels: [], assignees: [], createdAt: '2026-08-09T00:00:00Z', updatedAt: '2026-08-09T00:00:00Z',
  locked: false, columnId: null, conflict: null, pull: { draft: false, mergedAt: null }, ...over
})

/** Built through the real semantics, so these tests pin what a GitHub answer ends up SHOWING. */
function status(over: Partial<PullStatusFacts> = {}, access = ALL): GitHubPullStatus {
  return pullStatusFrom({
    number: 7, headRefName: 'feat/x', headRefOid: HEAD, crossRepository: false, isDraft: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', rollup: 'SUCCESS', rollupOid: HEAD,
    closes: [], ...over
  }, access)
}

function renderPull(value: GitHubPullStatus | undefined, freshness: 'fresh' | 'stale' | 'expired' = 'fresh'): HTMLElement {
  const host = document.createElement('div')
  act(() => createRoot(host).render(
    <GitHubPullCard pull={item()} status={value} freshness={freshness} observedAt={0} onOpen={vi.fn()} />
  ))
  return host
}

describe('pull request status on the card', () => {
  it('a PR with no check rollup shows no CI at all — never a passed tick', () => {
    const host = renderPull(status({ rollup: null, rollupOid: null }))
    expect(host.textContent).not.toContain('Checks passed')
    expect(host.textContent).not.toContain('✓')
    expect(host.querySelector('.pull-status__ci')).toBeNull()
  })

  it('a token that may not read checks hides the CI region instead of failing', () => {
    const host = renderPull(status({}, { ci: false, merge: false }))
    expect(host.querySelector('[data-testid="pull-status"]')).toBeNull()
    expect(host.textContent).toContain('Pull cards')
  })

  it('MERGEABLE is not "ready to merge": a blocked PR says Blocked', () => {
    const host = renderPull(status({ mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }))
    expect(host.textContent).not.toContain('Ready to merge')
    expect(host.textContent).toContain('Blocked')
    expect(renderPull(status()).textContent).toContain('Ready to merge')
  })

  it('shows passing, failing and running checks at the head commit', () => {
    expect(renderPull(status()).textContent).toContain('Checks passed')
    expect(renderPull(status({ rollup: 'FAILURE' })).textContent).toContain('Checks failing')
    expect(renderPull(status({ rollup: 'PENDING' })).textContent).toContain('Checks running')
  })

  it('a rollup from an older commit is not shown as the head\'s result', () => {
    const host = renderPull(status({ rollup: 'SUCCESS', rollupOid: 'b'.repeat(40) }))
    expect(host.textContent).not.toContain('Checks passed')
  })

  it('a stale snapshot stays on screen, marked, and greys once expired', () => {
    const stale = renderPull(status(), 'stale')
    expect(stale.textContent).toContain('Checks passed')
    expect(stale.textContent).toContain('stale')
    expect(renderPull(status(), 'expired').querySelector('.pull-status--expired')).not.toBeNull()
  })

  it('names the issues the PR closes', () => {
    expect(renderPull(status({ closes: [4, 9] })).textContent).toContain('Closes #4, #9')
  })
})

describe('the issue card', () => {
  it('shows the PRs that close it, with their state', () => {
    const host = document.createElement('div')
    act(() => createRoot(host).render(
      <GitHubIssueCard
        issue={item({ number: 4, pull: undefined })}
        columns={[]}
        moving={false}
        readOnly
        pulls={[{ ...status({ number: 12, closes: [4] }) }]}
        onOpen={vi.fn()}
        onMove={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />
    ))
    expect(host.textContent).toContain('PR #12')
    expect(host.querySelector('.pull-ref__ready')).not.toBeNull()
  })
})
