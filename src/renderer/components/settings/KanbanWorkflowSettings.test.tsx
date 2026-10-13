// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Project } from '@shared/types'
import { defaultKanban } from '../../lib/kanban'
import { prepareKanbanWorkflow } from '../../lib/kanbanWorkflow'
import { useProjects } from '../../state/projects'
import { useSettings } from '../../state/settings'
import { registerWorkspaceDirty } from '../../state/workspaceDirty'
import { KanbanWorkflowSettings } from './KanbanWorkflowSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('one-time Kanban task workflow configuration', () => {
  let root: Root
  let host: HTMLElement
  let dirty: ReturnType<typeof vi.fn<() => void>>
  let unregister: () => void
  const project = (over: Partial<Project> = {}): Project => ({
    id: 'project', name: 'Project', color: '#000', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], ...over
  })
  function LiveSettings(): React.JSX.Element {
    const p = useProjects(s => s.projects[0])
    return <KanbanWorkflowSettings project={p} />
  }
  const render = (p = project()) => {
    useProjects.setState({ projects: [p, project({ id: 'other' })], activeProjectId: p.id })
    act(() => root.render(<LiveSettings />))
  }
  const toggle = () => act(() => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click())

  beforeEach(() => {
    vi.useFakeTimers()
    useSettings.setState({ settings: DEFAULT_SETTINGS })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    dirty = vi.fn()
    unregister = registerWorkspaceDirty(dirty)
    ;(window as any).nodeTerminal = { settings: { save: vi.fn(async () => {}) } }
  })
  afterEach(() => {
    act(() => root.unmount())
    act(() => vi.runOnlyPendingTimers())
    vi.useRealTimers()
    unregister()
    host.remove()
    useSettings.setState({ settings: DEFAULT_SETTINGS })
    useProjects.setState({ projects: [], activeProjectId: '' })
  })

  it('starts off, creates the workflow once, and saves the board through the normal persistence seam', () => {
    const board = defaultKanban('project')
    board.assignments = [{ nodeId: 'existing', columnId: board.columns[1].id }]
    render(project({ kanban: board }))
    expect(host.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
    toggle()
    expect(useProjects.getState().projects[0].kanban?.columns.map(c => c.title))
      .toEqual(['To Do', 'Planning', 'In Progress', 'Ready for test', 'Done'])
    expect(useProjects.getState().projects[0].kanban?.assignments).toEqual(board.assignments)
    expect(Object.keys(useSettings.getState().settings.kanbanSessionWorkflows!.projects.project)).toHaveLength(5)
    expect(host.querySelectorAll('select')).toHaveLength(5)
    expect(dirty).toHaveBeenCalledOnce()
  })

  it('turns off future-session instructions while preserving the board and another project’s setting', () => {
    const prepared = prepareKanbanWorkflow(defaultKanban('project'))
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS,
      kanbanSessionWorkflows: { projects: { project: prepared.columns, other: prepared.columns } } } })
    render(project({ kanban: prepared.board }))
    toggle()
    expect(useSettings.getState().settings.kanbanSessionWorkflows!.projects).toEqual({ other: prepared.columns })
    expect(useProjects.getState().projects[0].kanban).toBe(prepared.board)
    expect(host.querySelectorAll('select')).toHaveLength(0)
    expect(dirty).not.toHaveBeenCalled()
  })

  it('lets the user replace a deleted stage without silently guessing or moving cards', () => {
    const prepared = prepareKanbanWorkflow(defaultKanban('project'))
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, kanbanSessionWorkflows: { projects: { project: prepared.columns } } } })
    const board = { ...prepared.board, columns: [
      ...prepared.board.columns.filter(c => c.id !== prepared.columns.testing),
      { id: 'qa', title: 'QA', color: '#000' }
    ] }
    render(project({ kanban: board }))
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Ready for test workflow column"]')!
    expect(select.textContent).toContain('Missing column')
    expect(select.querySelector<HTMLOptionElement>(`option[value="${prepared.columns.done}"]`)!.disabled).toBe(true)
    act(() => { select.value = 'qa'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(useSettings.getState().settings.kanbanSessionWorkflows!.projects.project.testing).toBe('qa')
    expect(useProjects.getState().projects[0].kanban).toBe(board)
  })

  it('explains and disables the switch for an SSH project', () => {
    render(project({ ssh: { server: { user: 'user', host: 'host' } as never, remoteCwd: '/repo' } }))
    expect(host.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true)
    expect(host.textContent).toContain('local projects in the desktop app')
    toggle()
    expect(useSettings.getState().settings.kanbanSessionWorkflows).toBeUndefined()
    expect(dirty).not.toHaveBeenCalled()
  })
})
