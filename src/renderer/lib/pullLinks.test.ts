import { describe, expect, it } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import type { GitHubPullBoard, GitHubPullStatus } from '@shared/github-pull-status'
import {
  prunePullLinks,
  readPullLinks,
  relinkPull,
  sanitizeKanbanPullAutoMove,
  setNoAutoMove,
  unlinkPull
} from '@shared/kanban-pull-links'
import { pruneAssignments } from './kanban'
import { pullsClosingIssue, pullsForCard } from './pullLinks'

const empty: ProjectKanban = { columns: [], assignments: [] }
const pull = (number: number, over: Partial<GitHubPullStatus> = {}): GitHubPullStatus =>
  ({ number, lifecycle: 'open', headRefName: 'feat/x', closes: [], ...over })
const pulls = (items: GitHubPullStatus[]): GitHubPullBoard => ({
  repository: 'o/r',
  pulls: items, observedAt: 1, stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false
})

describe('pullsForCard', () => {
  it('links PRs whose head is the card\'s worktree branch, newest open first', () => {
    const links = pullsForCard({ id: 'n', worktreeBranch: 'feat/x' }, pulls([
      pull(3, { lifecycle: 'merged' }), pull(5), pull(4, { headRefName: 'feat/y' }), pull(7)
    ]), empty)
    expect(links.linked.map((item) => item.number)).toEqual([7, 5, 3])
  })

  it('never links a fork PR, whatever its branch is called', () => {
    expect(pullsForCard({ id: 'n', worktreeBranch: 'feat/x' }, pulls([pull(5, { crossRepository: true })]), empty).linked)
      .toEqual([])
  })

  it('a card outside a worktree group has no links', () => {
    expect(pullsForCard({ id: 'n' }, pulls([pull(5)]), empty).linked).toEqual([])
  })

  it('an unlinked PR stays unlinked (and is offered back), even though the branch still matches', () => {
    const board = unlinkPull(empty, 'n', 5)
    const links = pullsForCard({ id: 'n', worktreeBranch: 'feat/x' }, pulls([pull(5), pull(6)]), board)
    expect(links.linked.map((item) => item.number)).toEqual([6])
    expect(links.unlinked.map((item) => item.number)).toEqual([5])
    expect(pullsForCard({ id: 'n', worktreeBranch: 'feat/x' }, pulls([pull(5)]), relinkPull(board, 'n', 5))
      .linked.map((item) => item.number)).toEqual([5])
    // The tombstone is per card: another card on the same branch still links.
    expect(pullsForCard({ id: 'other', worktreeBranch: 'feat/x' }, pulls([pull(5)]), board).linked).toHaveLength(1)
  })
})

describe('pullsForCard — a session started on an issue', () => {
  const issueCard = { id: 'n', issueRef: { owner: 'O', repo: 'R', number: 4 } }

  it('links the PRs that close its issue, forks included, from the same repository only', () => {
    const board = pulls([
      pull(7, { closes: [4], headRefName: 'anything' }),
      pull(8, { closes: [4], crossRepository: true, headRefName: 'fork/x' }),
      pull(9, { closes: [5] })
    ])
    expect(pullsForCard(issueCard, board, empty).linked.map((item) => item.number)).toEqual([8, 7])
    expect(pullsForCard({ ...issueCard, issueRef: { owner: 'else', repo: 'R', number: 4 } }, board, empty).linked)
      .toEqual([])
  })

  it('joins with the branch link without duplicates, and honours tombstones', () => {
    const board = pulls([pull(7, { closes: [4] }), pull(6)])
    const card = { ...issueCard, worktreeBranch: 'feat/x' }
    expect(pullsForCard(card, board, empty).linked.map((item) => item.number)).toEqual([7, 6])
    expect(pullsForCard(card, board, unlinkPull(empty, 'n', 7)).linked.map((item) => item.number)).toEqual([6])
  })
})

describe('pullsClosingIssue', () => {
  it('lists open PRs that close the issue', () => {
    expect(pullsClosingIssue(12, pulls([
      pull(1, { closes: [12] }), pull(2, { closes: [13] }), pull(3, { closes: [12], lifecycle: 'merged' })
    ])).map((item) => item.number)).toEqual([1])
  })
})

describe('board pull links (git-shared, hostile input)', () => {
  it('drops malformed entries instead of trusting them', () => {
    const hostile = { ...empty, pullLinks: {
      unlinked: [{ nodeId: 'n', pull: 5 }, { nodeId: 7, pull: 'x' }, null, { nodeId: 'm', pull: -1 }],
      noAutoMove: ['n', 42, 'n']
    } } as unknown as ProjectKanban
    expect(readPullLinks(hostile)).toEqual({ unlinked: [{ nodeId: 'n', pull: 5 }], noAutoMove: ['n'] })
    expect(readPullLinks({ ...empty, pullLinks: 'nope' } as unknown as ProjectKanban))
      .toEqual({ unlinked: [], noAutoMove: [] })
  })

  it('a write keeps keys a newer build stored in the block', () => {
    const newer = { ...empty, pullLinks: { issueLinks: [{ nodeId: 'n', issue: 4 }] } } as unknown as ProjectKanban
    const next = unlinkPull(newer, 'n', 5)
    expect((next.pullLinks as unknown as Record<string, unknown>).issueLinks).toEqual([{ nodeId: 'n', issue: 4 }])
    expect(readPullLinks(next).unlinked).toEqual([{ nodeId: 'n', pull: 5 }])
    const cleared = relinkPull(next, 'n', 5)
    expect(cleared.pullLinks).toEqual({ issueLinks: [{ nodeId: 'n', issue: 4 }] })
  })

  it('an emptied block leaves no key in the file', () => {
    const on = setNoAutoMove(empty, 'n', true)
    expect(on.pullLinks).toEqual({ noAutoMove: ['n'] })
    expect('pullLinks' in setNoAutoMove(on, 'n', false)).toBe(false)
  })

  it('pruning a dead card drops its tombstone and opt-out; unchanged returns the same object', () => {
    const k = setNoAutoMove(unlinkPull(empty, 'dead', 5), 'live', true)
    expect(prunePullLinks(k, new Set(['live'])).pullLinks).toEqual({ noAutoMove: ['live'] })
    const settled = prunePullLinks(k, new Set(['live']))
    expect(prunePullLinks(settled, new Set(['live']))).toBe(settled)
    expect(pruneAssignments(k, ['live']).pullLinks).toEqual({ noAutoMove: ['live'] })
    expect(pruneAssignments(settled, ['live'])).toBe(settled)
  })

  it('survives the card-meta setters, which rebuild meta entries from known fields only', async () => {
    const { toggleAssignee } = await import('./kanban')
    const k = toggleAssignee(unlinkPull(empty, 'n', 5), 'n', { name: 'A', color: '#fff' })
    expect(readPullLinks(k).unlinked).toEqual([{ nodeId: 'n', pull: 5 }])
  })
})

describe('the machine-local switch', () => {
  it('reads hand-edited settings defensively; an entry without a valid arming time is off', () => {
    expect(sanitizeKanbanPullAutoMove({ projects: {
      p1: { columnId: 'done', armedAt: 5, seen: { n: { '5': 'open' } } },
      p2: { columnId: 4, armedAt: 1 },
      p3: 'no',
      p4: { columnId: 'done' },
      p5: { columnId: 'done', armedAt: -1 }
    } })).toEqual({ projects: { p1: { columnId: 'done', armedAt: 5 } } })
    expect(sanitizeKanbanPullAutoMove(undefined)).toEqual({ projects: {} })
  })
})
