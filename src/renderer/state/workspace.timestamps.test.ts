import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentNode, createBrowserNode, createDiffNode, createDinoNode, createEditorNode,
  createFilesNode, createGroupNode, createStickyNode, createTerminalNode, createTriggerNode,
  createVideoNode, createWebNode, duplicateNode, flowToNodeStates, nodeStatesToFlow
} from './workspace'
import { useProjects } from './projects'

const NOW = Date.parse('2026-10-10T14:30:00Z')
afterEach(() => vi.restoreAllMocks())

describe('node date lifecycle', () => {
  it('stamps fresh nodes and retains both clocks through persistence and reload', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const nodes = [
      createTerminalNode(0), createAgentNode('claude', 0), createStickyNode(0),
      createGroupNode({ x: 0, y: 0 }), createEditorNode(0, '/tmp/a.ts'),
      createDiffNode(0, '/tmp', 'a.ts', false), createVideoNode(0, '/tmp/a.mp4'),
      createWebNode(0, { url: 'https://example.test' }), createBrowserNode(0, ''),
      createFilesNode(0, '/tmp'), createDinoNode(0), createTriggerNode(0)
    ]
    for (const node of nodes) expect(node.data).toMatchObject({ createdAt: NOW, lastActivityAt: NOW })
    nodes[0].data.lastActivityAt = NOW + 60_000
    const stored = flowToNodeStates(nodes)
    const reloaded = nodeStatesToFlow(stored)
    for (const node of flowToNodeStates(reloaded)) {
      const original = stored.find((candidate) => candidate.id === node.id)!
      expect(node).toMatchObject({ createdAt: original.createdAt, lastActivityAt: original.lastActivityAt })
    }
  })

  it('recovers legacy creation time, leaving unavailable activity unknown', () => {
    const stored = flowToNodeStates([createStickyNode(0)])[0]
    delete stored.createdAt
    delete stored.lastActivityAt
    const loaded = nodeStatesToFlow([stored])[0]
    const idClock = Number.parseInt(stored.id.split('-')[1], 36)
    expect(loaded.data.createdAt).toBe(idClock)
    expect(loaded.data.lastActivityAt).toBeUndefined()
  })

  it('a duplicate gets new dates in both canvas and background-project paths', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const source = createStickyNode(0)
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 60_000)
    expect(duplicateNode(source).data).toMatchObject({ createdAt: NOW + 60_000, lastActivityAt: NOW + 60_000 })
    const old = useProjects.getState()
    try {
      useProjects.setState({ projects: [], activeProjectId: '' })
      const project = useProjects.getState().addProject('Dates')
      useProjects.getState().commitCanvas(project.id, flowToNodeStates([source]), project.viewport)
      useProjects.getState().duplicateNode(project.id, source.id)
      expect(useProjects.getState().getProject(project.id)!.nodes[1])
        .toMatchObject({ createdAt: NOW + 60_000, lastActivityAt: NOW + 60_000 })
      expect(source.data.createdAt).toBe(NOW)
    } finally {
      useProjects.setState(old, true)
    }
  })

})
