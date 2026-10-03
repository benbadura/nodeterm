// "That was the last session — close the project too?" (issue #848, opt-in).
//
// Users finish work in a project by closing its nodes, but the project tab stays open, so the tab
// strip only grows. Closing a project is cheap — `closeProject` keeps the canvas and lists the
// project under "Recently closed" — so the moment the user closes the LAST session node with ×
// is the natural moment to offer it.
//
// The trigger is the × click itself, never "no process is running": a restart, a session that
// exits on its own, a hibernated agent (its node is still on the canvas), a bulk delete, a
// canvas-control close, a project close or an app quit must never ask. That is why the node
// ANNOUNCES the user's click (`announceUserClosedSession`, called only from TerminalNode's ×) and
// Canvas decides with `shouldOfferProjectClose` against its live node list.
//
// "Session node" is the code's own definition: a TERMINAL-kind node — plain shells and agents
// alike, working, idle, hibernated or exited — the same `(kind ?? 'terminal') === 'terminal'`
// classification `terminalNodeIds` (lib/projectCloseSessions) uses for the close/delete dialogs.
// Notes, markdown, browser, editor and other nodes do not count: they end no session, and the
// canvas they sit on is kept by the close anyway (the issue's open question — answered "still
// offer", the smallest reading of "last session node").

import type { Project } from '@shared/types'

/** Window event TerminalNode's × raises; Canvas listens. `detail: { nodeId }`. */
export const USER_CLOSED_SESSION_EVENT = 'nodeterm:user-closed-session'

/** Called by the × on a terminal/agent node, BEFORE the node is removed from the canvas. */
export function announceUserClosedSession(nodeId: string): void {
  window.dispatchEvent(new CustomEvent(USER_CLOSED_SESSION_EVENT, { detail: { nodeId } }))
}

/** Is this canvas node a session (terminal-kind) node? An untyped node is a terminal. */
export function isSessionNode(node: { type?: string }): boolean {
  return (node.type ?? 'terminal') === 'terminal'
}

export interface LastSessionCloseInput {
  /** `settings.offerCloseProjectOnLastSession` — default off. */
  enabled: boolean
  /** The node whose × was clicked. */
  closedNodeId: string
  /** The ACTIVE canvas's nodes, read while the closed node is still among them. */
  nodes: readonly { id: string; type?: string }[]
  /** The active project. */
  project: Pick<Project, 'remote' | 'closed'> | undefined
}

/**
 * Should closing `closedNodeId` offer to close the project? Only when the setting is on, the
 * project is an open LOCAL/SSH project (a relay tab's "close" only drops a view a reconnect
 * brings back), the clicked node is a session node still on this canvas (a repeated click on a
 * node already gone, or one rendered off-canvas, asks nothing), and no other session node remains.
 */
export function shouldOfferProjectClose(input: LastSessionCloseInput): boolean {
  const { enabled, closedNodeId, nodes, project } = input
  if (!enabled || !project || project.closed || project.remote) return false
  const closed = nodes.find((n) => n.id === closedNodeId)
  if (!closed || !isSessionNode(closed)) return false
  return !nodes.some((n) => n.id !== closedNodeId && isSessionNode(n))
}

export interface LastSessionCloseCopy {
  message: string
  confirmLabel: string
  cancelLabel: string
}

export function lastSessionCloseCopy(name: string): LastSessionCloseCopy {
  return {
    message:
      `That was the last session in “${name}”. Close the project too? You can reopen it from ` +
      `the start screen's “Recently closed” list.`,
    confirmLabel: 'Close project',
    cancelLabel: 'Keep open'
  }
}
