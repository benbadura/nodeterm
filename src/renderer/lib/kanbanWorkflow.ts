import { capabilityAgentId, canControlCanvas, type AgentId } from '@shared/agents/config'
import { isAgentIntegrationEnabled } from '@shared/agent-integrations'
import {
  KANBAN_WORKFLOW_STAGES, kanbanWorkflowColumnsExist, kanbanWorkflowPrompt,
  sanitizeKanbanSessionWorkflows, type KanbanWorkflowColumns
} from '@shared/kanban-workflow'
import type { ProjectKanban, Settings } from '@shared/types'
import { setNoAutoMove } from '@shared/kanban-pull-links'
import { addColumn, assignNode } from './kanban'

/** The workflow's final testing stays human even if this project enables PR-merge auto-moves. */
export function assignKanbanTaskSession(board: ProjectKanban, nodeId: string, columnId: string | null, workflow: boolean): ProjectKanban {
  const assigned = assignNode(board, nodeId, columnId, null)
  return workflow ? setNoAutoMove(assigned, nodeId, true) : assigned
}

/** Add only missing stages; preserve existing cards, metadata, GitHub mappings and columns. */
export function prepareKanbanWorkflow(board: ProjectKanban): { board: ProjectKanban; columns: KanbanWorkflowColumns } {
  let next = board
  const columns = {} as KanbanWorkflowColumns
  const used = new Set<string>()
  const folded = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, '')
  for (const { key, title } of KANBAN_WORKFLOW_STAGES) {
    const category = key === 'todo' ? 'unstarted' : key === 'implementation' ? 'started' : key === 'done' ? 'done' : undefined
    let column = next.columns.find(c => !used.has(c.id) && folded(c.title) === folded(title))
      ?? (category ? next.columns.find(c => !used.has(c.id) && c.category === category &&
        !['planning', 'readyfortest'].includes(folded(c.title))) : undefined)
    if (!column) {
      next = addColumn(next, title, key === 'planning' ? '#bf5af2' : key === 'testing' ? '#ff9f0a' : '#0a84ff')
      column = next.columns.at(-1)!
      next = { ...next, columns: next.columns.map(c => c.id === column!.id
        ? { ...c, category: category ?? 'started' } : c) }
    }
    columns[key] = column.id
    used.add(column.id)
  }
  // Place the stages in workflow order in their existing slots; unrelated columns stay put.
  const stages = KANBAN_WORKFLOW_STAGES.map(({ key }) => next.columns.find(c => c.id === columns[key])!)
  let index = 0
  next = { ...next, columns: next.columns.map(c => used.has(c.id) ? stages[index++] : c) }
  return { board: next, columns }
}

/** Ordinary canvas sessions have no column argument and never get the workflow prompt. */
export function kanbanSessionWorkflowLaunch(input: {
  settings: Pick<Settings, 'kanbanSessionWorkflows' | 'agentIntegrations'>
  projectId: string
  board: ProjectKanban
  columnId: string | null | undefined
  agentId: AgentId
  supportedHost: boolean
}): { prompt?: string; error?: string } {
  const config = sanitizeKanbanSessionWorkflows(input.settings.kanbanSessionWorkflows).projects[input.projectId]
  if (input.columnId === undefined || !config) return {}
  if (!input.supportedHost) return { error: 'Kanban task workflow requires a local desktop project.' }
  if (!canControlCanvas(input.agentId) || !isAgentIntegrationEnabled(input.settings, capabilityAgentId(input.agentId))) {
    return { error: 'Kanban task workflow requires an agent with Hooks & skills enabled in Settings → Agents.' }
  }
  if (!kanbanWorkflowColumnsExist(input.board, config)) {
    return { error: 'A Kanban task workflow column was deleted. Update the columns in this project’s Settings.' }
  }
  return { prompt: kanbanWorkflowPrompt(config) }
}
