import { useStore, type NodeProps } from '@xyflow/react'
import { shallow } from 'zustand/shallow'
import { nodeWorktree } from '../lib/nodeWorktree'
import { useAgentNodes } from '../state/agentNodes'
import { useProjects } from '../state/projects'
import { useWorktrees } from '../state/worktrees'
import { NodeTimestamps } from './NodeTimestamps'

function WorktreeLabel({ id, type, data, parentId }: NodeProps) {
  const projectCwd = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId)?.cwd)
  const sshProject = useProjects((s) => !!s.projects.find((p) => p.id === s.activeProjectId)?.ssh)
  const entries = useWorktrees((s) => s.entries)
  const stale = useWorktrees((s) => s.staleGroupIds)
  const ownerId = useAgentNodes((s) =>
    type === 'subagent' ? s.byId[id]?.parentNodeId : type === 'loop' ? id.replace(/^loop-/, '') : undefined
  )
  // Select only checkout facts: moving/resizing nodes or streaming output must not repaint labels.
  const worktree = useStore((s) => nodeWorktree(
    s.nodeLookup.get(ownerId ?? id) ?? { id, type, data, parentId },
    (nodeId) => s.nodeLookup.get(nodeId),
    entries,
    { cwd: projectCwd, ssh: sshProject },
    stale
  ), shallow)

  let label = '—'
  let title = worktree.kind === 'unknown' && worktree.path
    ? `No known worktree for ${worktree.path}`
    : 'No worktree information available'
  if (worktree.kind === 'remote') {
    label = 'SSH'
    title = 'Worktree information is unavailable for SSH nodes'
  } else if (worktree.kind === 'worktree') {
    label = worktree.path.split('/').filter(Boolean).pop() || worktree.path
    if (worktree.main) label += ' (main)'
    if (worktree.missing) label += ' · missing'
    title = `Worktree: ${worktree.path}${worktree.missing ? '\nWorktree directory is missing' : ''}`
  }
  return <div className="node-worktree" title={title}>Worktree: {label}</div>
}

/** Outside the node body so metadata never takes space from its terminal/editor content. */
export function NodeMetadata(props: NodeProps) {
  if (props.data.ghost) return null
  return (
    <div className="node-metadata nodrag nowheel">
      <WorktreeLabel {...props} />
      {props.type !== 'subagent' && props.type !== 'loop' && <NodeTimestamps id={props.id} data={props.data} />}
    </div>
  )
}
