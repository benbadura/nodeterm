// The run history of a GitHub issue card: which sessions were started on the issue and how each
// one ended. Shared by the renderer (UI starts, node deletes) and the Server Edition's headless
// factory (control-verb opens and closes), so the two shells file the SAME event shape under the
// SAME board-log identity.
//
// A run ends when its node is CLOSED — never when a turn ends. `done` means "a turn ended", not
// "the work is finished", and nothing here treats it as more.
//
// No cost or token figure is recorded: nodeterm has no cumulative per-session number, and a
// context-window reading is not one.

import type { BoardLogEvent } from './types'
import type { AgentState } from './agents/normalize'
import { issueLogId } from './github-issue-ref'

/** The node facts a run entry needs — satisfied by live node data and by a stored node alike. */
export interface IssueRunNode {
  id: string
  title?: string
  agentId?: string
  /** The session id nodeterm minted at creation (claude), if any. */
  agentSessionId?: string
}

export type IssueRunEnd = NonNullable<NonNullable<BoardLogEvent['run']>['end']>

/** The status facts that decide how a run ended. */
export interface IssueRunStatus {
  state?: AgentState
  lastTurnError?: { at: number }
  dropped?: boolean
  sessionId?: string
}

/** The last observed state of a session, as the run's end. */
export function runEndState(status: IssueRunStatus | undefined): IssueRunEnd {
  if (!status) return 'unknown'
  if (status.dropped) return 'dropped'
  if (status.lastTurnError) return 'errored'
  switch (status.state) {
    case 'working':
    case 'waiting':
    case 'blocked':
    case 'done':
      return status.state
    default:
      return 'unknown'
  }
}

function runOf(
  node: IssueRunNode,
  sessionId: string | undefined,
  end?: IssueRunEnd
): NonNullable<BoardLogEvent['run']> {
  return {
    nodeId: node.id,
    ...(node.agentId ? { agentId: node.agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(end ? { end } : {})
  }
}

/** `run-started`, filed under the issue card's board-log identity. Null for a reference this
 *  module cannot vouch for — nothing is logged on its behalf. */
export function runStartedEvent(
  ref: unknown,
  node: IssueRunNode
): { nodeId: string; event: BoardLogEvent } | null {
  const logId = issueLogId(ref)
  if (!logId) return null
  return {
    nodeId: logId,
    event: {
      type: 'run-started',
      ...(node.title ? { title: node.title } : {}),
      run: runOf(node, node.agentSessionId)
    }
  }
}

/** `run-ended`, written when a bound node is CLOSED. The live session id wins over the minted one
 *  (a `/clear` or a resume mints a new id inside the CLI). */
export function runEndedEvent(
  ref: unknown,
  node: IssueRunNode,
  status: IssueRunStatus | undefined
): { nodeId: string; event: BoardLogEvent } | null {
  const logId = issueLogId(ref)
  if (!logId) return null
  return {
    nodeId: logId,
    event: {
      type: 'run-ended',
      ...(node.title ? { title: node.title } : {}),
      run: runOf(node, status?.sessionId ?? node.agentSessionId, runEndState(status))
    }
  }
}
