// "Open here anyway" on a project this desktop handed to a hosted team.
//
// The share ended the project's SSH sessions and the server resumed its agents' conversations on its
// own core. Reopening the SSH project here mounts every node fresh against sessions that are gone, so
// each agent node would cold-restore and type `claude --resume <id>` over SSH: a second process on a
// conversation the server is running, both appending to one transcript. So that reopen marks the
// project's terminal nodes, and each one skips its automatic cold-resume ONCE and says why; resuming
// it here stays the user's explicit choice.
//
// The mark is transient (memory only) on purpose. `agentStatus.paused` would also skip the resume,
// but it is persisted and keyed by node id, and the hosted team's tab holds the very same node ids.
import type { CanvasNodeState } from '@shared/types'

const marked = new Set<string>()

/** Mark the terminal nodes of a project taken back from a hosted team. */
export function skipNextColdResumeFor(nodes: readonly Pick<CanvasNodeState, 'id' | 'kind'>[]): void {
  for (const n of nodes) if ((n.kind ?? 'terminal') === 'terminal') marked.add(n.id)
}

/** Take (and clear) a node's mark. Asked once per local mount that reaches the cold-restore
 *  decision, warm or cold, so a mark never outlives the mount it was meant for. */
export function takeColdResumeSkip(nodeId: string): boolean {
  return marked.delete(nodeId)
}

/** Whether this mount skips its cold-restore relaunch: only when it would have relaunched at all. */
export function skipsColdResume(o: { coldStart: boolean; canColdRestore: boolean; marked: boolean }): boolean {
  return o.coldStart && o.canColdRestore && o.marked
}

export function resetColdResumeSkipsForTests(): void {
  marked.clear()
}
