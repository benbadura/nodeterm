import { isAncestorPath, isRemoteSessionNode, type GroupWorktree, type WorktreeEntry } from '@shared/worktree'

interface WorktreeNode {
  id: string
  type?: string
  parentId?: string
  data: {
    cwd?: unknown
    filePath?: unknown
    worktree?: GroupWorktree
    ssh?: unknown
    sshRemoteTmux?: unknown
    sshFs?: unknown
  }
}

export type NodeWorktree =
  | { kind: 'worktree'; path: string; main: boolean; missing: boolean }
  | { kind: 'unknown'; path?: string }
  | { kind: 'remote' }

const normalized = (path: string): string => path.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '/'
const nodePath = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? normalized(value) : undefined

/** Resolve the node's checkout from its own path first: dragging a terminal into a worktree
 * frame does not move its running session. Pathless nodes inherit their frame/project context. */
export function nodeWorktree(
  node: WorktreeNode,
  getNode: (id: string) => WorktreeNode | undefined,
  entries: WorktreeEntry[],
  project: { cwd?: string; ssh?: boolean },
  staleGroupIds: string[] = []
): NodeWorktree {
  if (project.ssh || isRemoteSessionNode(node.data) || node.data.sshFs) return { kind: 'remote' }

  let path: string | undefined
  const bindings: Array<{ id: string; path: string }> = []
  const seen = new Set<string>()
  let current: WorktreeNode | undefined = node
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    const boundPath = current.type === 'group' ? nodePath(current.data.worktree?.path) : undefined
    if (boundPath) bindings.push({ id: current.id, path: boundPath })
    path ??= boundPath ?? nodePath(current.data.filePath) ?? nodePath(current.data.cwd)
    current = current.parentId ? getNode(current.parentId) : undefined
  }
  path ??= nodePath(project.cwd)
  if (!path) return { kind: 'unknown' }

  // The deepest matching root wins, including worktrees nested inside the main checkout.
  let match: { path: string; main: boolean; missing: boolean } | undefined
  const consider = (root: string, main: boolean, missing: boolean): void => {
    if (isAncestorPath(root, path) && (!match || root.length > match.path.length)) {
      match = { path: root, main, missing }
    }
  }
  entries.forEach((entry, i) => {
    if (entry.isBare) return
    const root = normalized(entry.path)
    consider(root, i === 0, !!entry.prunable || bindings.some((b) => b.path === root && staleGroupIds.includes(b.id)))
  })
  // Bindings also work while the initial git read is pending or unavailable.
  bindings.forEach((binding) => consider(binding.path, false, staleGroupIds.includes(binding.id)))
  return match ? { kind: 'worktree', ...match } : { kind: 'unknown', path }
}
