// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider, useStoreApi, type NodeProps } from '@xyflow/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Project } from '@shared/types'
import type { CanvasNode } from '../state/workspace'
import { useProjects } from '../state/projects'
import { useAgentNodes } from '../state/agentNodes'
import { useWorktrees } from '../state/worktrees'
import { withNodeBoundary } from './NodeBoundary'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
let store: ReturnType<typeof useStoreApi>
function Capture() { store = useStoreApi(); return null }
const Body = vi.fn(() => <div>Node body</div>)
const Wrapped = withNodeBoundary(Body)
const node = (id = 'test', type: CanvasNode['type'] = 'terminal'): CanvasNode => ({
  id, type, position: { x: 0, y: 0 },
  data: { title: id, color: '#fff', group: null, cwd: '/repo/src', createdAt: 1, lastActivityAt: 2 }
})
function mount(n: CanvasNode) {
  useProjects.setState({ projects: [{ id: 'p', cwd: '/repo' } as Project], activeProjectId: 'p' })
  useWorktrees.setState({ entries: [{ path: '/repo', branch: 'main', head: 'abc', isBare: false }], staleGroupIds: [] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const props: NodeProps = {
    ...n, type: n.type ?? 'terminal', selected: false, dragging: false, draggable: true,
    selectable: true, deletable: true, isConnectable: false, zIndex: 0,
    positionAbsoluteX: 0, positionAbsoluteY: 0
  }
  act(() => root.render(<ReactFlowProvider initialNodes={[n]}><Capture /><Wrapped {...props} /></ReactFlowProvider>))
}
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  Body.mockClear()
  useWorktrees.getState().reset()
  useAgentNodes.setState({ byId: {} })
})

it('adds checkout metadata to an already open node and updates it without remounting its body', () => {
  mount(node())
  const metadata = host.querySelector('.node-metadata')!
  expect(metadata.textContent).toContain('Worktree: repo (main)')
  expect(metadata.textContent).toContain('Created:')
  expect(host.querySelector('.node-worktree')?.getAttribute('title')).toBe('Worktree: /repo')
  const renders = Body.mock.calls.length
  act(() => useWorktrees.setState({ entries: [
    { path: '/repo', branch: 'main', head: 'abc', isBare: false },
    { path: '/repo/wt', branch: 'feature', head: 'def', isBare: false }
  ] }))
  act(() => store.getState().setNodes([{ ...node(), data: { ...node().data, cwd: '/repo/wt/src' } }]))
  expect(metadata.textContent).toContain('Worktree: wt')
  expect(metadata.textContent).not.toContain('(main)')
  expect(host.querySelector('.node-worktree')?.getAttribute('title')).toBe('Worktree: /repo/wt')
  expect(Body.mock.calls).toHaveLength(renders)
})

it('hides all metadata for background webview ghosts', () => {
  const ghost = node('ghost', 'browser')
  ghost.data.ghost = true
  mount(ghost)
  expect(host.querySelector('.node-metadata')).toBeNull()
})

it.each(['subagent', 'loop'] as const)('uses the owning terminal for a %s card, without adding unknown dates', (type) => {
  const card = node(type === 'loop' ? 'loop-owner' : 'child', type)
  card.data.cwd = undefined
  useAgentNodes.setState({ byId: { child: { parentNodeId: 'owner', state: 'working', startedAt: 1 } } })
  mount(card)
  act(() => store.getState().setNodes([card, { ...node('owner'), data: { ...node('owner').data, cwd: '/outside' } }]))
  expect(host.querySelector('.node-worktree')?.textContent).toBe('Worktree: —')
  expect(host.querySelector('.node-worktree')?.getAttribute('title')).toContain('/outside')
  expect(host.querySelector('.node-timestamps')).toBeNull()
})
