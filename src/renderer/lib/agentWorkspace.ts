import type { WorktreeCreateValue } from '@shared/worktree'
import {
  createBoundWorktree,
  type CreateBoundWorktreeDeps,
  type CreateBoundWorktreeOutcome,
  type WorktreeAttachTarget
} from './worktreeCreate'

export type AgentWorktreeOutcome =
  | (Extract<CreateBoundWorktreeOutcome, { ok: true }> & { agentCreated: boolean })
  | Exclude<CreateBoundWorktreeOutcome, { ok: true }>

/** Open the agent synchronously inside attach: its cwd must see the new frame before a render. */
export async function createAgentWorktree(
  deps: CreateBoundWorktreeDeps & {
    isCurrent(): boolean
    openAgent(groupId: string): boolean
  },
  value: WorktreeCreateValue,
  opts: { target: () => WorktreeAttachTarget; projectId: string }
): Promise<AgentWorktreeOutcome> {
  let agentCreated = false
  const result = await createBoundWorktree({
    ...deps,
    // A dismissed request stays invalid even if the user switches away and back during git.
    activeProjectId: () => deps.isCurrent() ? deps.activeProjectId() : null,
    attach: (target, worktree) => {
      const groupId = deps.attach(target, worktree)
      agentCreated = deps.openAgent(groupId)
      return groupId
    }
  }, value, opts)
  return result.ok ? { ...result, agentCreated } : result
}
