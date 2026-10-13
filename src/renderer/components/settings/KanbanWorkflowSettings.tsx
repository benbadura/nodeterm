import { isBrowserRuntime } from '@renderer/bridge/runtime'
import { Select } from '@renderer/ui/Select'
import { Switch } from '@renderer/ui/Switch'
import { KANBAN_WORKFLOW_STAGES, sanitizeKanbanSessionWorkflows, type KanbanWorkflowColumns } from '@shared/kanban-workflow'
import type { Project } from '@shared/types'
import { defaultKanban } from '../../lib/kanban'
import { prepareKanbanWorkflow } from '../../lib/kanbanWorkflow'
import { useProjects } from '../../state/projects'
import { useSettings } from '../../state/settings'
import { markWorkspaceDirty } from '../../state/workspaceDirty'
import { FieldRow } from './FieldRow'

export function KanbanWorkflowSettings({ project }: { project: Project }): React.JSX.Element {
  const raw = useSettings(s => s.settings.kanbanSessionWorkflows)
  const config = sanitizeKanbanSessionWorkflows(raw).projects[project.id]
  const board = project.kanban ?? defaultKanban(project.id)
  const unsupported = !!project.ssh || isBrowserRuntime()
  const save = (columns?: KanbanWorkflowColumns): void => {
    const settings = useSettings.getState()
    const current = sanitizeKanbanSessionWorkflows(settings.settings.kanbanSessionWorkflows)
    const live = new Set(useProjects.getState().projects.map(p => p.id))
    const projects = Object.fromEntries(Object.entries(current.projects)
      .filter(([id]) => id !== project.id && live.has(id)))
    settings.update({ kanbanSessionWorkflows: { projects: { ...projects, ...(columns ? { [project.id]: columns } : {}) } } })
  }
  const toggle = (enabled: boolean): void => {
    if (!enabled) { save(); return }
    const current = useProjects.getState().getProject(project.id)
    if (!current) return
    const prepared = prepareKanbanWorkflow(current.kanban ?? defaultKanban(project.id))
    useProjects.getState().setProjectKanban(project.id, prepared.board)
    markWorkspaceDirty()
    save(prepared.columns)
  }
  return <div className="space-y-4">
    <FieldRow
      label="Kanban task workflow"
      description="New agent sessions created from this board receive the workflow automatically: plan, wait for your approval, implement, then hand over for testing. You move the card to Done."
      note={unsupported ? 'Available for local projects in the desktop app.' : undefined}
      control={<Switch ariaLabel="Kanban task workflow" checked={!!config} onChange={toggle} disabled={unsupported} />}
    />
    {config && <>
      <p className="text-[13px] leading-relaxed text-muted">
        Saved for this project on this machine. Applies to new sessions with Hooks &amp; skills enabled.
        Approve the plan in the session’s conversation.
      </p>
      {KANBAN_WORKFLOW_STAGES.map(({ key, title }) => <FieldRow key={key} label={title}
        htmlFor={`kanban-workflow-${project.id}-${key}`}
        control={<Select id={`kanban-workflow-${project.id}-${key}`} aria-label={`${title} workflow column`}
          value={config[key]} disabled={unsupported}
          onChange={e => save({ ...config, [key]: e.target.value })}>
          {!board.columns.some(c => c.id === config[key]) && <option value={config[key]}>Missing column — choose another</option>}
          {board.columns.map(c => <option key={c.id} value={c.id}
            disabled={c.id !== config[key] && Object.values(config).includes(c.id)}>{c.title}</option>)}
        </Select>} />)}
    </>}
  </div>
}
