// Which project owns a node id, when more than one holds it.
//
// A node id is normally in exactly one project, but "Share with team" breaks that on purpose: the
// SSH project it handed off stays in "Recently closed" (closed, `handedOffTo` set) holding the same
// node ids as the hosted team's tab that now serves them (the ids are the tmux session names, and
// the server keeps them). A plain `projects.find(...)` returns whichever comes first, which is the
// closed SSH project, so every "go to node" landed on the reopen warning instead of the live tab.

/** The little the lookup needs to know about a project. */
export interface OwnerProject {
  closed?: boolean
  handedOffTo?: unknown
  /** A relay tab (a hosted team's project). */
  remote?: boolean
  nodes: readonly { id: string }[]
}

/**
 * The project that owns `nodeId`: an open project before a closed one, and, among those, one not
 * handed off to a hosted team before one that was; ties go to the first in the list. `undefined`
 * when no project holds the node. A CLOSED team tab never owns a node: reopening it would mount the
 * host's node ids on this machine's core, so a shared node whose team tab is closed falls back to
 * the handed-off SSH project, whose reopen asks first.
 */
export function nodeOwner<T extends OwnerProject>(projects: readonly T[], nodeId: string): T | undefined {
  let best: T | undefined
  let bestRank = Number.POSITIVE_INFINITY
  for (const p of projects) {
    if ((p.remote && p.closed) || !p.nodes.some((n) => n.id === nodeId)) continue
    const rank = (p.closed ? 2 : 0) + (p.handedOffTo ? 1 : 0)
    if (rank < bestRank) {
      best = p
      bestRank = rank
    }
  }
  return best
}

/** The node ids that some project other than `projectId` also holds. Deleting `projectId` must not
 *  drop what those nodes still need (their agent status). */
export function nodeIdsHeldElsewhere(
  projects: readonly (OwnerProject & { id: string })[],
  projectId: string
): Set<string> {
  const out = new Set<string>()
  for (const p of projects) {
    if (p.id === projectId) continue
    for (const n of p.nodes) out.add(n.id)
  }
  return out
}
