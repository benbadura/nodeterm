import type { CanvasNodeState, Project, PtyCreateOptions } from './types'

/** Size of a headless spawn until a real viewer attaches and resizes it (tmux redraws then). */
export const HEADLESS_COLS = 120
export const HEADLESS_ROWS = 36

type NodeSpawnFields = Pick<CanvasNodeState, 'id' | 'cwd' | 'shell' | 'agentId' | 'agentModel' | 'accountId'>

/**
 * The PtyCreateOptions a LOCAL spawn of `node` uses when no viewer initiates it: the desktop
 * headless launcher (#925) and the Server Edition's canvas factory.
 *
 * It mirrors the local fields of TerminalNode's own `transport.create`: `shell`, `cwd`,
 * `persistKey`, `ownerProjectId`, `agentId`, `agentModel` and `accountId`. The session a viewer later
 * warm-attaches to therefore carries the env it would have had if the viewer had spawned it. Two
 * deliberate differences:
 *  - `cwd` falls back to the project root. A headless spawn has no mounted node to inherit a
 *    working directory from, and the Server Edition always did this.
 *  - No `sshRemote` / `requireRemote` / `clearEnv`. Headless starts are local-only in v1, and
 *    clearEnv is a one-shot restart flag.
 * TerminalNode itself is NOT moved onto this builder: its create also serves warm and SSH attaches,
 * and a cwd-less node there spawns in $HOME today.
 */
export function localNodePtyOptions(
  project: Pick<Project, 'id' | 'cwd'>,
  node: NodeSpawnFields,
  size: { cols: number; rows: number }
): PtyCreateOptions {
  return {
    cwd: node.cwd || project.cwd,
    cols: size.cols,
    rows: size.rows,
    persistKey: node.id,
    ownerProjectId: project.id,
    ...(node.shell ? { shell: node.shell } : {}),
    ...(node.agentId ? { agentId: node.agentId } : {}),
    ...(node.agentModel ? { agentModel: node.agentModel } : {}),
    ...(node.accountId ? { accountId: node.accountId } : {})
  }
}
