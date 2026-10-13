// @vitest-environment jsdom
import { act, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/types'
import { useNodeActivity } from './useNodeActivity'
import { flushNodeActivities, recordNodeActivity } from '../lib/nodeActivity'
import type { CanvasNode } from '../state/workspace'
import { useProjects } from '../state/projects'
import { useAgentStatus } from '../state/agentStatus'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const NOW = Date.parse('2026-10-10T14:30:00Z')
const live: CanvasNode = {
  id: 'live', type: 'sticky', position: { x: 0, y: 0 },
  data: { title: 'Note', text: '', color: '#888', group: null, createdAt: 1000, lastActivityAt: 2000 }
}
const background: Project = {
  id: 'background', name: 'Background', color: '#888', viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [{ id: 'agent', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 400, height: 300 },
    title: 'Agent', color: '#888', group: null, createdAt: 1000, lastActivityAt: 2000 }]
}

describe('canvas node activity integration', () => {
  let root: Root
  let host: HTMLDivElement
  let oldProjects: ReturnType<typeof useProjects.getState>
  let oldStatus: ReturnType<typeof useAgentStatus.getState>
  let updateNodes: Dispatch<SetStateAction<CanvasNode[]>>
  let readOnly = false
  let loading = false
  const dirty = vi.fn()

  function Harness() {
    const [nodes, setNodes] = useState([live])
    updateNodes = setNodes
    const nodesRef = useRef(nodes)
    nodesRef.current = nodes
    const projectRef = useRef<string | null>('active')
    const loadingRef = useRef(loading)
    loadingRef.current = loading
    useNodeActivity({ nodes, nodesRef, projectRef, renderedProjectId: 'active', loadingRef,
      setNodes, markDirty: dirty, canTrackProject: () => !readOnly })
    return <div className="react-flow__node" data-id="live"><input aria-label="Note" /><output>{nodes[0].data.lastActivityAt}</output></div>
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    readOnly = false
    loading = false
    dirty.mockClear()
    oldProjects = useProjects.getState()
    oldStatus = useAgentStatus.getState()
    useProjects.setState({ projects: [background], activeProjectId: 'active' })
    useAgentStatus.setState({ byId: {} })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    useProjects.setState(oldProjects, true)
    useAgentStatus.setState(oldStatus, true)
    vi.useRealTimers()
  })

  it('leaves hydration idle, then stamps interactions and programmatic content changes', async () => {
    await act(async () => vi.advanceTimersByTime(2000))
    expect(dirty).not.toHaveBeenCalled()
    await act(async () => {
      host.querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true }))
      flushNodeActivities()
    })
    expect(host.querySelector('output')!.textContent).toBe(String(NOW + 2000))
    vi.setSystemTime(NOW + 5000)
    await act(async () => updateNodes((nodes) => nodes.map((node) => ({ ...node, data: { ...node.data, text: 'Changed' } }))))
    await act(async () => flushNodeActivities())
    expect(host.querySelector('output')!.textContent).toBe(String(NOW + 5000))
    const writes = dirty.mock.calls.length
    await act(async () => vi.advanceTimersByTime(5000))
    expect(dirty).toHaveBeenCalledTimes(writes) // Clock renders cannot create an activity loop.
  })

  it('stores background agent events in their own project, even same-state hook events', async () => {
    await act(async () => {
      useAgentStatus.getState().setState('agent', 'working')
      flushNodeActivities()
    })
    expect(useProjects.getState().getProject('background')!.nodes[0])
      .toMatchObject({ createdAt: 1000, lastActivityAt: NOW })
    expect(host.querySelector('output')!.textContent).toBe('2000')
    vi.setSystemTime(NOW + 5000)
    await act(async () => {
      useAgentStatus.getState().setState('agent', 'working')
      flushNodeActivities()
    })
    expect(useProjects.getState().getProject('background')!.nodes[0].lastActivityAt).toBe(NOW + 5000)
  })

  it('does not modify a read-only canvas or a loading live canvas', async () => {
    readOnly = true
    await act(async () => {
      recordNodeActivity('live')
      recordNodeActivity('agent')
      flushNodeActivities()
    })
    expect(dirty).not.toHaveBeenCalled()
    expect(useProjects.getState().getProject('background')!.nodes[0].lastActivityAt).toBe(2000)
    readOnly = false
    loading = true
    await act(async () => root.render(<Harness />))
    await act(async () => { recordNodeActivity('live'); flushNodeActivities() })
    expect(host.querySelector('output')!.textContent).toBe('2000')
    expect(dirty).not.toHaveBeenCalled()
  })
})
