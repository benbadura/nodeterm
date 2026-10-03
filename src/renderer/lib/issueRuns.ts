// Pure rules for the GitHub-issue ↔ session binding on the board: which sessions a card shows, what
// its live chip says, and the run history filed under the issue card.
//
// Two invariants the rest of the feature leans on, stated here where they are decided:
//
//   - A hook `done` NEVER moves a card. `done` means "a turn ended", not "the work is finished" —
//     it drives the chip, and nothing in this module (or anywhere the chip is read) writes a board
//     assignment. A card moves only when the session `assign`s itself or a person drags it.
//   - The run history carries NO cost or token figure. nodeterm has no cumulative per-session
//     number; the context meter is a window reading, and presenting it as a cost would be a wrong
//     number shown as a fact.

import { issueKey, normalizeIssueRef, type IssueRef } from '@shared/github-issue-ref'
import {
  runEndState,
  runEndedEvent,
  runStartedEvent,
  type IssueRunNode,
  type IssueRunStatus
} from '@shared/issue-runs'
import type { AgentNodeStatus } from '../state/agentStatus'
import type { BoardLogAppendInput } from '../state/boardLog'
import { cardBadge } from './kanbanStatusChips'

export { runEndState, type IssueRunNode }

type StatusLike = Pick<AgentNodeStatus, 'state' | 'unread'> &
  Partial<Pick<AgentNodeStatus, 'paused' | 'hibernated'>> &
  IssueRunStatus

/** `run-started` as a board-log append (the shared event, filed under the issue card). */
export function runStartedEntry(ref: unknown, node: IssueRunNode): BoardLogAppendInput | null {
  const e = runStartedEvent(ref, node)
  return e ? { kind: 'event', ...e } : null
}

/** `run-ended` as a board-log append — written when a bound node is CLOSED, never on a turn ending. */
export function runEndedEntry(
  ref: unknown,
  node: IssueRunNode,
  status: StatusLike | undefined
): BoardLogAppendInput | null {
  const e = runEndedEvent(ref, node, status)
  return e ? { kind: 'event', ...e } : null
}

export type IssueRunChipKind = 'running' | 'needs' | 'failed' | 'dropped' | 'paused' | 'sleeping' | 'idle'

/** What a bound session's chip on the issue card says. The precedence is the session card's own
 *  (`cardBadge` — ONE definition, so the chip on the issue and the badge on the session's card can
 *  never disagree), plus the TURN FAILED verdict the node header shows, ranked above the quiet
 *  pause states. `done` is `idle`: a finished turn is not a finished issue. */
export function issueRunChip(status: StatusLike | undefined): { kind: IssueRunChipKind; unread: boolean } {
  const unread = !!status?.unread
  if (!status) return { kind: 'idle', unread }
  const badge = cardBadge('terminal', status as AgentNodeStatus)
  if (badge === 'dropped' || badge === 'running' || badge === 'needs') return { kind: badge, unread }
  if (status.lastTurnError) return { kind: 'failed', unread }
  if (badge === 'paused' || badge === 'sleeping') return { kind: badge, unread }
  return { kind: 'idle', unread }
}

/** A primitive the chip subscribes to (`useAgentStatus(s => issueRunChipSig(s.byId[id]))`), so a
 *  same-state hook event — which refreshes `stateAt` in place — re-renders nothing. */
export function issueRunChipSig(status: StatusLike | undefined): string {
  const c = issueRunChip(status)
  return `${c.kind}|${c.unread ? 1 : 0}`
}

/** One session as the issue card sees it. */
export interface IssueRunSession {
  id: string
  title: string
  agentId?: string
  issueRef?: IssueRef
}

export interface IssueRun {
  id: string
  title: string
  agentId?: string
}

/** Shared empty list, so an unbound issue card's memoized props never change identity. */
export const NO_ISSUE_RUNS: readonly IssueRun[] = Object.freeze([])

/**
 * Sessions grouped by the issue they are bound to (keyed by `issueKey`, case-insensitive). Pass the
 * previous result to keep each group's array identity when its content is unchanged — the board
 * derives sessions on every canvas change, and a fresh array per render would defeat the issue
 * card's memo.
 */
export function boundRunsByIssue(
  sessions: readonly IssueRunSession[],
  previous?: ReadonlyMap<string, readonly IssueRun[]>
): Map<string, readonly IssueRun[]> {
  const grouped = new Map<string, IssueRun[]>()
  for (const s of sessions) {
    const ref = normalizeIssueRef(s.issueRef)
    const key = ref ? issueKey(ref) : undefined
    if (!key) continue
    const list = grouped.get(key) ?? []
    list.push({ id: s.id, title: s.title, ...(s.agentId ? { agentId: s.agentId } : {}) })
    grouped.set(key, list)
  }
  const out = new Map<string, readonly IssueRun[]>()
  for (const [key, list] of grouped) {
    const prev = previous?.get(key)
    const same =
      !!prev &&
      prev.length === list.length &&
      prev.every((r, i) => r.id === list[i].id && r.title === list[i].title && r.agentId === list[i].agentId)
    out.set(key, same ? prev : list)
  }
  return out
}
