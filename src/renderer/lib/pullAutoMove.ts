// Moving a session card when the work it tracks has merged — the decision, pure.
//
// SESSION CARDS ONLY. A GitHub issue card is never moved here: GitHub already closes an issue when a
// PR with "Closes #N" merges, and a second writer would race it (and could overwrite the
// `state_reason` GitHub records). The board shows that close through its normal sync.
//
// The guards, in this order, each a refusal:
//   1. the card opted out                      → never
//   2. no linked PR                            → nothing to decide
//   3. any linked PR still open or a draft     → wait
//   4. any linked PR closed WITHOUT merging    → blocked until the user removes that link; an
//                                                abandoned PR is not finished work
//   5. already in the target column            → nothing to do
//   6. all merged, but none of the merges was OBSERVED by this machine since the switch went on →
//      no move. The host remembers each PR it saw open and when it then saw it merge
//      (core/github/pull-memory.ts); arming the switch, or cloning a repo whose PRs merged long ago,
//      never sweeps old cards across the board.
//
// Remembered PRs keep a card blocked: a PR that closed unmerged stays on the host's pull board (and
// so stays linked) until the user unlinks it — it does not expire when 30 newer PRs close.
//
// Nothing here writes. Each planned move must still win the host's one-time claim
// (`githubIssues.claimPullAutoMove`) — so two windows cannot both move a card, and a card the user
// dragged back is not moved again for the same merges — and is then applied as a compare-and-set.
import type { ProjectKanban } from '@shared/types'
import type { GitHubPullBoard, PullLifecycle } from '@shared/github-pull-status'
import type { IssueRef } from '@shared/github-issue-ref'
import { readPullLinks, type KanbanPullAutoMoveEntry } from '@shared/kanban-pull-links'
import { assignNode, columnForNode } from './kanban'
import { pullsForCard } from './pullLinks'

export type PullAutoMoveDecision =
  | { kind: 'move'; pulls: number[] }
  | {
    kind: 'none'
    reason: 'opted-out' | 'no-links' | 'waiting' | 'blocked' | 'in-target' | 'no-transition'
  }

export function decidePullAutoMove(input: {
  optedOut: boolean
  linked: Array<{ number: number; lifecycle: PullLifecycle; mergedSeenAt?: number }>
  columnId: string | null
  targetColumnId: string
  /** When this machine switched the move on; only merges it OBSERVED since then count. */
  armedAt: number
}): PullAutoMoveDecision {
  if (input.optedOut) return { kind: 'none', reason: 'opted-out' }
  if (input.linked.length === 0) return { kind: 'none', reason: 'no-links' }
  if (input.linked.some((pull) => pull.lifecycle === 'open' || pull.lifecycle === 'draft')) {
    return { kind: 'none', reason: 'waiting' }
  }
  if (input.linked.some((pull) => pull.lifecycle === 'closed')) return { kind: 'none', reason: 'blocked' }
  if (input.columnId === input.targetColumnId) return { kind: 'none', reason: 'in-target' }
  // The host records `mergedSeenAt` only for a PR it had seen open before — a merge first seen
  // already-merged has none, and never counts.
  const observed = input.linked.some((pull) =>
    pull.mergedSeenAt !== undefined && pull.mergedSeenAt >= input.armedAt)
  if (!observed) return { kind: 'none', reason: 'no-transition' }
  return { kind: 'move', pulls: input.linked.map((pull) => pull.number).sort((a, b) => a - b) }
}

/**
 * The move itself, as a compare-and-set: it applies only if the card is still in the column the
 * decision saw (a teammate's pull, a drag a moment ago, or another window's move all make it a
 * no-op) and the target column still exists. Null = nothing to write.
 */
export function applyPullAutoMove(
  board: ProjectKanban,
  cardId: string,
  expectedColumnId: string | null,
  targetColumnId: string
): ProjectKanban | null {
  const current = columnForNode(board, cardId)?.id ?? null
  if (current !== expectedColumnId || current === targetColumnId) return null
  if (!board.columns.some((column) => column.id === targetColumnId)) return null
  return assignNode(board, cardId, targetColumnId, null)
}

/** The board-log line's reason: it names the PRs, so the move can be traced to what caused it. */
export function autoMoveNote(pulls: number[]): string {
  const list = pulls.map((number) => `#${number}`).join(', ')
  return pulls.length === 1 ? `PR ${list} merged` : `PRs ${list} merged`
}

/** The board cards the auto-move may touch: the SESSION source, and only it. An issue card is not
 *  in this list by construction, and the planner re-checks the kind rather than trusting callers. */
const SESSION_CARD_KINDS = new Set(['terminal', 'sticky', 'browser'])

export interface PullAutoMovePlan {
  moves: Array<{ cardId: string; fromColumnId: string | null; pulls: number[] }>
  /** Cards waiting on still-open PRs. The host records these as evidence that THIS card saw the PR
   *  open; its claim for a move later requires one, so a card that first appears after the merge
   *  never moves. */
  waits: Array<{ cardId: string; pulls: number[] }>
}

/**
 * One pass over the board: which cards to move. Nothing moves while the switch is off, while the pull
 * status is unknown or STALE (a decision on a snapshot GitHub could not confirm is a guess), or while
 * the target column does not exist. Write-free by design — an earlier version kept "last seen" in
 * settings.json and could loop against the sanitizer's bounds; observation now lives on the host.
 */
export function planPullAutoMoves(input: {
  cards: Array<{ id: string; kind: string; worktreeBranch?: string; issueRef?: IssueRef }>
  board: ProjectKanban
  pullBoard: GitHubPullBoard | undefined
  entry: KanbanPullAutoMoveEntry | undefined
}): PullAutoMovePlan {
  const { entry, pullBoard, board } = input
  const idle: PullAutoMovePlan = { moves: [], waits: [] }
  if (!entry || !pullBoard || pullBoard.observedAt === undefined || pullBoard.stale) return idle
  if (!board.columns.some((column) => column.id === entry.columnId)) return idle
  const optedOut = new Set(readPullLinks(board).noAutoMove)
  const moves: PullAutoMovePlan['moves'] = []
  const waits: PullAutoMovePlan['waits'] = []
  for (const card of input.cards) {
    if (!SESSION_CARD_KINDS.has(card.kind)) continue
    const linked = pullsForCard(card, pullBoard, board).linked
    const fromColumnId = columnForNode(board, card.id)?.id ?? null
    const decision = decidePullAutoMove({
      optedOut: optedOut.has(card.id),
      linked,
      columnId: fromColumnId,
      targetColumnId: entry.columnId,
      armedAt: entry.armedAt
    })
    if (decision.kind === 'move') moves.push({ cardId: card.id, fromColumnId, pulls: decision.pulls })
    if (decision.kind === 'none' && decision.reason === 'waiting') {
      waits.push({
        cardId: card.id,
        pulls: linked.filter((pull) => pull.lifecycle === 'open' || pull.lifecycle === 'draft')
          .map((pull) => pull.number)
      })
    }
  }
  return { moves, waits }
}
