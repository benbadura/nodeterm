import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import type { GitHubPullBoard, GitHubPullStatus } from '@shared/github-pull-status'
import { setNoAutoMove, unlinkPull } from '@shared/kanban-pull-links'
import { applyPullAutoMove, autoMoveNote, decidePullAutoMove, planPullAutoMoves } from './pullAutoMove'
import { columnForNode } from './kanban'

const ARMED = 1_000

const board = (over: Partial<ProjectKanban> = {}): ProjectKanban => ({
  columns: [
    { id: 'doing', title: 'Doing', color: '#0a84ff' },
    { id: 'done', title: 'Done', color: '#30d158' }
  ],
  assignments: [{ nodeId: 'card-1', columnId: 'doing' }],
  ...over
})

/** A PR this machine saw open and then saw merge after the switch went on. */
const observedMerge = (number: number, over: Partial<GitHubPullStatus> = {}): GitHubPullStatus =>
  ({ number, lifecycle: 'merged', headRefName: 'feat/x', closes: [], openSeen: true, mergedSeenAt: ARMED + 5, ...over })
const pull = (number: number, lifecycle: GitHubPullStatus['lifecycle'], over: Partial<GitHubPullStatus> = {}): GitHubPullStatus =>
  ({ number, lifecycle, headRefName: 'feat/x', closes: [], ...over })

const pulls = (items: GitHubPullStatus[], over: Partial<GitHubPullBoard> = {}): GitHubPullBoard => ({
  pulls: items, observedAt: 1, stale: false, access: { ci: true, merge: true }, undecided: false,
  truncated: false, ...over
})

const card = { id: 'card-1', kind: 'terminal', worktreeBranch: 'feat/x' }
const entry = { columnId: 'done', armedAt: ARMED }

const boardFor = (): ProjectKanban => board()

describe('decidePullAutoMove — the guard order', () => {
  const base = { optedOut: false, columnId: 'doing', targetColumnId: 'done', armedAt: ARMED }
  const merged = { number: 1, lifecycle: 'merged' as const, mergedSeenAt: ARMED + 1 }

  it('an opted-out card never moves, even when everything merged', () => {
    expect(decidePullAutoMove({ ...base, optedOut: true, linked: [merged] }))
      .toEqual({ kind: 'none', reason: 'opted-out' })
  })

  it('waits while any linked PR is open or a draft', () => {
    expect(decidePullAutoMove({ ...base, linked: [merged, { number: 2, lifecycle: 'draft' }] }))
      .toEqual({ kind: 'none', reason: 'waiting' })
  })

  it('a PR closed without merging blocks the move', () => {
    expect(decidePullAutoMove({ ...base, linked: [merged, { number: 2, lifecycle: 'closed' }] }))
      .toEqual({ kind: 'none', reason: 'blocked' })
  })

  it('moves only on a merge this machine observed after the switch went on', () => {
    expect(decidePullAutoMove({ ...base, linked: [merged] })).toEqual({ kind: 'move', pulls: [1] })
    expect(decidePullAutoMove({ ...base, linked: [{ number: 1, lifecycle: 'merged' }] }))
      .toEqual({ kind: 'none', reason: 'no-transition' })
    expect(decidePullAutoMove({ ...base, linked: [{ ...merged, mergedSeenAt: ARMED - 1 }] }))
      .toEqual({ kind: 'none', reason: 'no-transition' })
  })

  it('does nothing for a card already in the target column', () => {
    expect(decidePullAutoMove({ ...base, columnId: 'done', linked: [merged] }))
      .toEqual({ kind: 'none', reason: 'in-target' })
  })
})

describe('applyPullAutoMove — compare-and-set', () => {
  it('moves the card from the column the decision saw — one assignment, in the target column', () => {
    const next = applyPullAutoMove(board(), 'card-1', 'doing', 'done')!
    expect(next.assignments.filter((a) => a.nodeId === 'card-1')).toHaveLength(1)
    expect(columnForNode(next, 'card-1')?.id).toBe('done')
  })

  it('does nothing when the card moved since the decision', () => {
    expect(applyPullAutoMove(board(), 'card-1', null, 'done')).toBeNull()
  })

  it('does nothing when the target column is gone', () => {
    expect(applyPullAutoMove(board(), 'card-1', 'doing', 'deleted')).toBeNull()
  })
})

describe('planPullAutoMoves', () => {
  it('plans the move for a card whose only PR was seen open and then merged', () => {
    expect(planPullAutoMoves({ cards: [card], board: board(), pullBoard: pulls([observedMerge(1)]), entry }).moves)
      .toEqual([{ cardId: 'card-1', fromColumnId: 'doing', pulls: [1] }])
  })

  it('a merge first seen already-merged, or seen before arming, moves nothing', () => {
    expect(planPullAutoMoves({ cards: [card], board: board(), pullBoard: pulls([pull(1, 'merged')]), entry }).moves)
      .toEqual([])
    expect(planPullAutoMoves({
      cards: [card], board: board(), pullBoard: pulls([observedMerge(1, { mergedSeenAt: ARMED - 1 })]), entry
    }).moves).toEqual([])
  })

  it('reports a card waiting on an open PR, so the host can note that THIS card saw it open', () => {
    const plan = planPullAutoMoves({
      cards: [card], board: board(), pullBoard: pulls([pull(3, 'open'), pull(4, 'draft'), observedMerge(1)]), entry
    })
    expect(plan.moves).toEqual([])
    expect(plan.waits).toEqual([{ cardId: 'card-1', pulls: [3, 4] }])
  })

  it('does nothing at all while the switch is off, the status is stale, or unknown', () => {
    const merged = pulls([observedMerge(1)])
    expect(planPullAutoMoves({ cards: [card], board: board(), pullBoard: merged, entry: undefined }).moves).toEqual([])
    expect(planPullAutoMoves({ cards: [card], board: board(), pullBoard: { ...merged, stale: true }, entry }).moves)
      .toEqual([])
    expect(planPullAutoMoves({ cards: [card], board: board(), pullBoard: undefined, entry }).moves).toEqual([])
  })

  it('an unlinked PR does not count, and an opted-out card stays put', () => {
    const merged = pulls([observedMerge(1)])
    expect(planPullAutoMoves({ cards: [card], board: unlinkPull(board(), 'card-1', 1), pullBoard: merged, entry }).moves)
      .toEqual([])
    expect(planPullAutoMoves({ cards: [card], board: setNoAutoMove(board(), 'card-1', true), pullBoard: merged, entry }).moves)
      .toEqual([])
  })

  it('a closed-unmerged sibling blocks until the user removes that link', () => {
    const both = pulls([observedMerge(1), pull(2, 'closed')])
    expect(planPullAutoMoves({ cards: [card], board: board(), pullBoard: both, entry }).moves).toEqual([])
    expect(planPullAutoMoves({ cards: [card], board: unlinkPull(board(), 'card-1', 2), pullBoard: both, entry }).moves)
      .toEqual([{ cardId: 'card-1', fromColumnId: 'doing', pulls: [1] }])
  })

  it('moves a session started on an issue once the PR that closes it merged', () => {
    const issueCard = { id: 'card-1', kind: 'terminal', issueRef: { owner: 'o', repo: 'r', number: 4 } }
    const board = { ...pulls([observedMerge(9, { closes: [4], headRefName: 'someone/else' })]), repository: 'o/r' }
    expect(planPullAutoMoves({ cards: [issueCard], board: boardFor(), pullBoard: board, entry }).moves)
      .toEqual([{ cardId: 'card-1', fromColumnId: 'doing', pulls: [9] }])
  })

  it("a fork PR on a same-named branch is not this card's work", () => {
    const plan = planPullAutoMoves({
      cards: [card], board: board(), pullBoard: pulls([observedMerge(1, { crossRepository: true })]), entry
    })
    expect(plan.moves).toEqual([])
  })

  it('GitHub issue cards are never moved — GitHub closes them itself', () => {
    const plan = planPullAutoMoves({
      cards: [{ id: 'github:12', kind: 'github', worktreeBranch: 'feat/x' }],
      board: board({ assignments: [{ nodeId: 'github:12', columnId: 'doing' }] }),
      pullBoard: pulls([observedMerge(1, { closes: [12] })]),
      entry
    })
    expect(plan.moves).toEqual([])
  })

  it('the planner and its hook never reach the GitHub issue write path, and never write settings', () => {
    for (const file of ['pullAutoMove.ts', '../components/kanban/usePullAutoMove.ts']) {
      const source = readFileSync(path.join(__dirname, file), 'utf8').replace(/\r\n/g, '\n')
      expect(source).not.toMatch(/moveIssue|githubIssues\s*\.\s*move|updateIssue/)
      expect(source).not.toMatch(/\.update\(|settings\.save/)
    }
  })

  it('is stable: the same inputs plan the same moves (no hidden state to converge)', () => {
    const input = { cards: [card], board: board(), pullBoard: pulls([observedMerge(1)]), entry }
    expect(planPullAutoMoves(input)).toEqual(planPullAutoMoves(input))
  })
})

describe('helpers', () => {
  it('names the PRs in the board-log line', () => {
    expect(autoMoveNote([12])).toBe('PR #12 merged')
    expect(autoMoveNote([12, 15])).toBe('PRs #12, #15 merged')
  })
})
