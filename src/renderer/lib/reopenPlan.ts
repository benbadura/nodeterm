import type { ReopenEntry } from '@renderer/state/reopenHistory'
import type { ReopenNodeSnapshot } from './reopenNode'
import type { CanvasNode } from '@renderer/state/workspace'
import { isClosedTeamTab } from './closedHistory'

/** What `app.reopenLastClosed` (Cmd+Shift+T) should do for ONE popped history entry. Pure
 *  decision only — no store writes, no `setNodes`, no navigation. `Canvas.tsx` executes
 *  whichever variant comes back; `'skip'` means the entry was stale (already reopened another
 *  way, its project was permanently deleted, or every node it held recreated to nothing) and the
 *  caller should keep popping. `'refuse'` means the entry's project is a CLOSED team tab
 *  (`isClosedTeamTab`): nothing may be written into it or reopen it, and the caller drops the entry
 *  and says why. */
export type ReopenPlan =
  | { action: 'reopenProject'; projectId: string }
  | { action: 'insertActive'; nodes: CanvasNode[] }
  | { action: 'insertStored'; projectId: string; reopenProjectAfter: boolean; nodes: CanvasNode[] }
  | { action: 'refuse'; projectId: string }
  | { action: 'skip' }

/** The subset of `Project` this decision needs — kept minimal so tests can pass plain fixtures
 *  instead of a full `Project`. */
export interface PlanReopenProject {
  id: string
  closed?: boolean
  /** A relay tab (a hosted team's project): once closed, never reopened from the history. */
  remote?: boolean
  nodes: readonly { id: string }[]
}

/**
 * Decides what reopening `entry` should do, given the CURRENT project list and active project —
 * both may have changed since the entry was recorded, which is exactly why an entry can be
 * stale. `activeLiveNodeIds` is the live React Flow node id set (`nodesRef.current` on the
 * canvas) — it's only consulted when `entry`'s project turns out to be the active one; a
 * non-active project's own `nodes` (its serialized snapshot) stands in otherwise, since there is
 * no live array for it. `recreate` is `recreateNodeFromSnapshot` pre-bound with everything except
 * the live-id set (account resolution, permission mode, the TARGET project) — kept as an
 * injected function so this stays pure and the account/permission-mode plumbing doesn't leak
 * into the decision logic under test.
 */
export function planReopen(
  entry: ReopenEntry,
  projects: readonly PlanReopenProject[],
  activeProjectId: string | undefined,
  activeLiveNodeIds: ReadonlySet<string>,
  recreate: (snapshot: ReopenNodeSnapshot, liveNodeIds: ReadonlySet<string>) => CanvasNode | null
): ReopenPlan {
  const project = projects.find((p) => p.id === entry.projectId)
  // A closed team tab: its nodes are the host's sessions, and reopening it (or restoring a node
  // into it, which reopens it) would mount them on this machine's core. Checked before anything is
  // recreated, so nothing is written into it.
  if (isClosedTeamTab(project)) return { action: 'refuse', projectId: entry.projectId }

  if (entry.kind === 'project') {
    // Only stale if it isn't sitting closed right now — already reopened another way, or gone.
    return project?.closed ? { action: 'reopenProject', projectId: entry.projectId } : { action: 'skip' }
  }

  if (!project) return { action: 'skip' } // permanently deleted since the entry was recorded

  const isActive = project.id === activeProjectId
  const liveIds = isActive ? activeLiveNodeIds : new Set(project.nodes.map((n) => n.id))
  const created = entry.nodes
    .map((snap) => recreate(snap, liveIds))
    .filter((n): n is CanvasNode => n !== null)
  // A snapshot that recreated to nothing (a kind this feature doesn't cover, or e.g. an editor
  // whose filePath is somehow missing) leaves the whole batch with nothing to insert — treat as
  // stale rather than switching/reopening a project for an empty result. A multi-node batch that
  // DID partially recreate still restores as ONE unit (whatever survived), never split across plans.
  if (!created.length) return { action: 'skip' }

  return isActive
    ? { action: 'insertActive', nodes: created }
    : {
        action: 'insertStored',
        projectId: project.id,
        reopenProjectAfter: !!project.closed,
        nodes: created
      }
}
