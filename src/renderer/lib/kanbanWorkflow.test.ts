import { beforeEach, describe, expect, it } from 'vitest'
import { assignKanbanTaskSession, prepareKanbanWorkflow, kanbanSessionWorkflowLaunch } from './kanbanWorkflow'
import { defaultKanban } from './kanban'
import { DEFAULT_SETTINGS, type ProjectKanban } from '@shared/types'
import { useSettings } from '../state/settings'
import { createAgentNode } from '../state/workspace'

beforeEach(() => useSettings.setState({ settings: DEFAULT_SETTINGS }))

describe('Kanban task workflow setup and launch', () => {
  it('adds Planning and testing between existing stages without losing board content', () => {
    const board = defaultKanban('project')
    board.assignments = [{ nodeId: 'session', columnId: board.columns[1].id }]
    board.labels = [{ id: 'label', name: 'Bug', color: 'red' }]
    board.github = {
      repository: 'owner/repo',
      columnMappings: board.columns.map(c => ({ columnId: c.id, label: `status:${c.title}` })),
      completionColumnId: board.columns[2].id
    }
    const prepared = prepareKanbanWorkflow(board)
    expect(prepared.board.columns.map(c => c.title)).toEqual(['To Do', 'Planning', 'In Progress', 'Ready for test', 'Done'])
    expect(prepared.board.assignments).toBe(board.assignments)
    expect(prepared.board.labels).toBe(board.labels)
    expect(prepared.board.github?.columnMappings).toHaveLength(5)
    expect(prepared.board.github?.completionColumnId).toBe(board.github!.completionColumnId)
    expect(prepared.board.columns.find(c => c.id === prepared.columns.testing)?.category).toBe('started')
    expect(prepareKanbanWorkflow(prepared.board).columns).toEqual(prepared.columns)
    expect(prepareKanbanWorkflow(prepared.board).board.columns).toEqual(prepared.board.columns)
  })

  it('reuses categorized custom stages and preserves unrelated columns', () => {
    const board: ProjectKanban = { columns: [
      { id: 'backlog', title: 'Backlog', color: '#000', category: 'unstarted' },
      { id: 'blocked', title: 'Blocked', color: '#000' },
      { id: 'work', title: 'Doing', color: '#000', category: 'started' },
      { id: 'shipped', title: 'Shipped', color: '#000', category: 'done' }
    ], assignments: [] }
    const prepared = prepareKanbanWorkflow(board)
    expect(prepared.columns).toMatchObject({ todo: 'backlog', implementation: 'work', done: 'shipped' })
    expect(prepared.board.columns[1].id).toBe('blocked')
    expect(prepared.board.columns).toHaveLength(6)
  })

  const launch = (patch: Partial<Parameters<typeof kanbanSessionWorkflowLaunch>[0]> = {}) => {
    const prepared = prepareKanbanWorkflow(defaultKanban('project'))
    return kanbanSessionWorkflowLaunch({
      projectId: 'project', board: prepared.board, columnId: prepared.columns.todo, agentId: 'claude', supportedHost: true,
      settings: { kanbanSessionWorkflows: { projects: { project: prepared.columns } }, agentIntegrations: { agents: { claude: 'enabled' } } },
      ...patch
    })
  }

  it('changes neither ordinary canvas launches nor boards that have not enabled it', () => {
    expect(launch({ columnId: undefined })).toEqual({})
    expect(launch({ settings: {} })).toEqual({})
    expect(launch({ projectId: 'other-project' })).toEqual({})
    expect(launch({ columnId: null }).prompt).toContain('Kanban task workflow')
  })

  it('refuses unavailable controls and missing stage columns instead of starting an unconfigured task', () => {
    expect(launch({ supportedHost: false }).error).toContain('local desktop')
    expect(launch({ agentId: 'not-an-agent' }).error).toContain('Hooks & skills')
    expect(launch({ board: { columns: [], assignments: [] } }).error).toContain('column was deleted')
    const prepared = prepareKanbanWorkflow(defaultKanban('project'))
    expect(launch({ settings: { kanbanSessionWorkflows: { projects: { project: prepared.columns } } } }).error).toContain('Hooks & skills')
  })

  it('delivers the standing rules through the real agent launch assembler', () => {
    const prompt = launch().prompt!
    const node = createAgentNode('claude', 0, '/repo', undefined, prompt)
    const command = node.data.initialCommand as string
    expect(command).toContain('explicitly approve this plan')
    expect(command).toContain('Ready for test')
    expect(command).toContain('Never move your card to Done yourself')
    expect(createAgentNode('claude', 0).data.initialCommand).toBe('claude')
  })

  it('keeps workflow tasks out of PR-merge auto-moves, including tasks created in Ungrouped', () => {
    const board = defaultKanban('project')
    const regular = assignKanbanTaskSession(board, 'regular', board.columns[0].id, false)
    expect(regular.pullLinks).toBeUndefined()
    const task = assignKanbanTaskSession(regular, 'task', board.columns[0].id, true)
    expect(task.pullLinks?.noAutoMove).toEqual(['task'])
    expect(task.assignments.map(a => a.nodeId)).toContain('task')
    const ungrouped = assignKanbanTaskSession(task, 'ungrouped', null, true)
    expect(ungrouped.pullLinks?.noAutoMove).toEqual(['task', 'ungrouped'])
    expect(ungrouped.assignments.some(a => a.nodeId === 'ungrouped')).toBe(false)
  })
})
