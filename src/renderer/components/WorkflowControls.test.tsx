// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssueWorkflowControls, WorkflowRunControls } from './WorkflowControls'
import { useProjects } from '../state/projects'
import { builtinWorkflows, type WorkflowRun } from '@shared/workflows'

const hostApi = vi.hoisted(() => ({
  list: vi.fn(async (): Promise<WorkflowRun[]> => []), start: vi.fn(async () => ({ ok: true })),
  act: vi.fn(async () => ({ ok: true })), listeners: new Set<(id: string, runs: WorkflowRun[]) => void>(),
  onChanged: vi.fn((fn: (id: string, runs: WorkflowRun[]) => void) => { hostApi.listeners.add(fn); return () => { hostApi.listeners.delete(fn) } })
}))
vi.mock('../session/session', () => ({ sessionForProject: () => ({ api: { workflows: hostApi } }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const template = builtinWorkflows('claude').templates[0]
const run: WorkflowRun = { id: 'run', projectId: 'p', groupId: 'group', template,
  issueRef: { owner: 'o', repo: 'r', number: 42 }, state: 'waiting-approval', stepIndex: 0,
  attempts: [{ id: 'attempt', stepId: 'analysis', nodeId: 'node', state: 'awaiting-approval', startedAt: 1 }], createdAt: 1, updatedAt: 1 }
afterEach(() => { vi.clearAllMocks(); hostApi.listeners.clear(); useProjects.setState({ projects: [], activeProjectId: '' }) })

describe('workflow controls', () => {
  it('starts the default template in one click without opening its containing issue card', async () => {
    useProjects.setState({ projects: [{ id: 'p', name: 'P', cwd: '/repo', color: '#fff', nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, workflows: builtinWorkflows('claude') }] })
    const host = document.createElement('div'), root = createRoot(host), open = vi.fn()
    await act(async () => root.render(<div onClick={open}><IssueWorkflowControls projectId="p" compact issue={{ number: 42, htmlUrl: 'https://github.com/o/r/issues/42' }} /></div>))
    const start = [...host.querySelectorAll('button')].find(b => b.textContent === 'Run Fix a bug')!
    await act(async () => start.click())
    expect(hostApi.start).toHaveBeenCalledWith('p', 'fix-bug', { owner: 'o', repo: 'r', number: 42 })
    expect(open).not.toHaveBeenCalled()
    await act(async () => hostApi.listeners.forEach(fn => fn('p', [run])))
    expect(host.textContent).toContain('waiting approval')
    expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Run Fix a bug')).toBe(false)
    await act(async () => root.unmount())
    expect(hostApi.listeners.size).toBe(0)
  })
  it('shows stage attempts, opens the chosen session, and sends an explicit approval', async () => {
    const host = document.createElement('div'), root = createRoot(host), open = vi.fn()
    await act(async () => root.render(<WorkflowRunControls projectId="p" run={run} onOpenNode={open} />))
    const buttons = [...host.querySelectorAll('button')]
    act(() => buttons.find(b => b.textContent === 'awaiting approval')!.click())
    expect(open).toHaveBeenCalledWith('node')
    await act(async () => buttons.find(b => b.textContent === 'Approve stage')!.click())
    expect(hostApi.act).toHaveBeenCalledWith('p', 'run', 'approve')
    await act(async () => root.unmount())
  })
  it('keeps SSH starts disabled and explains why', async () => {
    useProjects.setState({ projects: [{ id: 'p', name: 'P', cwd: '/repo', remote: { peerId: 'peer', projectId: 'other' } as never,
      color: '#fff', nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, workflows: builtinWorkflows('claude') }] })
    const host = document.createElement('div'), root = createRoot(host)
    await act(async () => root.render(<IssueWorkflowControls projectId="p" compact issue={{ number: 42, htmlUrl: 'https://github.com/o/r/issues/42' }} />))
    const start = [...host.querySelectorAll('button')].find(b => b.textContent === 'Run Fix a bug')!
    expect(start.disabled).toBe(true)
    expect(start.title).toContain('local project')
    await act(async () => root.unmount())
  })
})
