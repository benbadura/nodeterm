import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { normalizeNodeTimestamp } from '@shared/node-timestamps'
import { useProjects } from '../state/projects'
import { useAgentStatus } from '../state/agentStatus'
import type { CanvasNode } from '../state/workspace'
import { nodeActivityChanged, recordNodeActivity, stampNodeActivities, subscribeNodeActivityBatch } from '../lib/nodeActivity'

interface Options {
  nodes: CanvasNode[]
  nodesRef: MutableRefObject<CanvasNode[]>
  projectRef: MutableRefObject<string | null>
  renderedProjectId: string | null
  loadingRef: MutableRefObject<boolean>
  setNodes: Dispatch<SetStateAction<CanvasNode[]>>
  markDirty: () => void
  canTrackProject: (projectId: string) => boolean
}

export function useNodeActivity(options: Options): void {
  const current = useRef(options)
  current.current = options

  useEffect(() => subscribeNodeActivityBatch((activity) => {
    const { nodesRef, projectRef, loadingRef, setNodes, markDirty, canTrackProject } = current.current
    const liveIds = new Set(nodesRef.current.map((node) => node.id))
    let changed = false
    if (!loadingRef.current && projectRef.current && canTrackProject(projectRef.current)) {
      const next = stampNodeActivities(nodesRef.current, activity)
      if (next !== nodesRef.current) {
        nodesRef.current = next
        setNodes((nodes) => stampNodeActivities(nodes, activity))
        changed = true
      }
    }
    // Background agent events belong to their own project, including while another tab is open.
    for (const project of useProjects.getState().projects) {
      if (!canTrackProject(project.id)) continue
      const mutations = project.nodes.flatMap((node) => {
        if (project.id === projectRef.current && liveIds.has(node.id)) return []
        const at = activity.get(node.id)
        if (at === undefined || at <= (normalizeNodeTimestamp(node.lastActivityAt) ?? 0)) return []
        return [{ op: 'upsert' as const, node: { ...node, lastActivityAt: at } }]
      })
      if (mutations.length) {
        useProjects.getState().applyOwnNodeMutations(project.id, mutations)
        changed = true
      }
    }
    if (changed) markDirty()
  }), [])

  useEffect(() => {
    const onInteraction = (event: Event) => {
      const { nodesRef, projectRef, loadingRef, canTrackProject } = current.current
      if (loadingRef.current || !projectRef.current || !canTrackProject(projectRef.current)) return
      const target = event.composedPath().find((entry) => entry instanceof Element) as Element | undefined
      const id = target?.closest('.react-flow__node')?.getAttribute('data-id')
      if (id && nodesRef.current.some((node) => node.id === id)) recordNodeActivity(id)
    }
    const events = ['pointerdown', 'keydown', 'input', 'wheel']
    for (const event of events) document.addEventListener(event, onInteraction, { capture: true, passive: true })
    return () => {
      for (const event of events) document.removeEventListener(event, onInteraction, true)
    }
  }, [])

  const previous = useRef<{ projectId: string | null; nodes: Map<string, CanvasNode> }>({ projectId: null, nodes: new Map() })
  useEffect(() => {
    const { nodes, renderedProjectId, projectRef, loadingRef, canTrackProject } = current.current
    if (loadingRef.current || renderedProjectId !== projectRef.current) {
      previous.current = { projectId: null, nodes: new Map() }
      return
    }
    const old = previous.current
    previous.current = { projectId: renderedProjectId, nodes: new Map(nodes.map((node) => [node.id, node])) }
    if (!renderedProjectId || !canTrackProject(renderedProjectId)) return
    for (const node of nodes) {
      const before = old.projectId === renderedProjectId ? old.nodes.get(node.id) : undefined
      if (before && nodeActivityChanged(before, node)) recordNodeActivity(node.id)
      // Existing agent nodes already have a persisted event clock. Recover that actual date.
      const seenAt = normalizeNodeTimestamp(useAgentStatus.getState().byId[node.id]?.lastSeen?.at)
      if (seenAt !== undefined && seenAt > (normalizeNodeTimestamp(node.data.lastActivityAt) ?? 0)) {
        recordNodeActivity(node.id, seenAt)
      }
    }
  }, [options.nodes, options.renderedProjectId])
}
