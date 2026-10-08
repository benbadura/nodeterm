import { useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { issueRefFromHtmlUrl, type IssueRef } from '@shared/github-issue-ref'
import { currentWorkflowAttempt, workflowFinished, type WorkflowAction, type WorkflowRun } from '@shared/workflows'
import { useProjects } from '../state/projects'
import { sessionForProject } from '../session/session'
import { useWorkflowRuns } from '../state/workflows'
import { flushWorkspaceEdits } from '../state/workspaceDirty'

export function WorkflowRunControls({ projectId, run, onOpenNode }: {
  projectId: string; run: WorkflowRun; onOpenNode?: (id: string) => void
}): React.JSX.Element {
  const api = sessionForProject(projectId).api.workflows
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const attempt = currentWorkflowAttempt(run)
  const action = async (value: WorkflowAction) => {
    setBusy(true); setError('')
    try { const result = await api.act(projectId, run.id, value); if (!result.ok) setError(result.error) }
    catch { setError('The workflow host could not be reached.') }
    finally { setBusy(false) }
  }
  return <div className="workflow-run" data-state={run.state}>
    <div className="workflow-run__heading"><strong>{run.template.name}</strong><span>{run.state.replaceAll('-', ' ')}</span></div>
    <ol className="workflow-run__steps">
      {run.template.steps.map((step, i) => {
        const attempts = run.attempts.filter(a => a.stepId === step.id)
        return <li key={step.id} className={i === run.stepIndex ? 'workflow-run__current' : ''}>
          <span>{i < run.stepIndex ? '✓ ' : ''}{step.title}</span>
          <small>{step.agentId}{step.model ? ` · ${step.model}` : ''}</small>
          {attempts.map((a, index) => <button key={a.id} type="button" disabled={!onOpenNode}
            onClick={() => onOpenNode?.(a.nodeId)} title={a.error ?? a.note ?? a.nodeId}>
            {attempts.length > 1 ? `Attempt ${index + 1}: ` : ''}{a.state.replaceAll('-', ' ')}
          </button>)}
        </li>
      })}
    </ol>
    {run.worktree && <small title={run.worktree.path}>⎇ {run.worktree.branch}</small>}
    {run.error && <p role="status">{run.error}</p>}
    {run.state === 'paused' && <p>Resume explicitly to continue. Active sessions keep their work.</p>}
    {run.state === 'running' && attempt?.turnDoneAt && !attempt.outcome && <p>Waiting for the stage’s outcome report.</p>}
    {!workflowFinished(run) && <div className="workflow-actions">
      {run.state === 'waiting-approval' && <button type="button" disabled={busy} onClick={() => void action('approve')}>Approve stage</button>}
      {run.state === 'paused' && attempt?.state !== 'uncertain' && <button type="button" disabled={busy} onClick={() => void action('resume')}>Resume</button>}
      {(run.state === 'failed' || (run.state === 'paused' && attempt?.state === 'uncertain')) &&
        <button type="button" disabled={busy} onClick={() => void action('retry')}>Retry stage</button>}
      {run.state !== 'paused' && <button type="button" disabled={busy} onClick={() => void action('pause')}>Pause</button>}
      <button type="button" disabled={busy} onClick={() => void action('cancel')}>Cancel workflow</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>
}

export function IssueWorkflowControls({ projectId, issue, onOpenNode, compact = false }: {
  projectId: string; issue: { number: number; htmlUrl: string }; onOpenNode?: (id: string) => void; compact?: boolean
}): React.JSX.Element | null {
  const project = useProjects(s => s.projects.find(p => p.id === projectId))
  const api = sessionForProject(projectId).api.workflows
  const all = useWorkflowRuns(api, projectId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(!compact)
  const ref = issueRefFromHtmlUrl(issue.htmlUrl, issue.number)
  if (!project || !ref || !api) return null
  const templates = project.workflows?.templates ?? []
  const runs = all.filter(r => sameIssue(r.issueRef, ref))
  const active = runs.find(r => !workflowFinished(r))
  const selected = templates.find(t => t.id === project.workflows?.defaultTemplateId) ?? templates[0]
  const unsupported = project.ssh || project.remote || project.unavailable || !project.cwd
  const start = async (id: string) => {
    setBusy(true); setError('')
    try {
      await flushWorkspaceEdits(sessionForProject(projectId).api)
      const result = await api.start(projectId, id, ref); if (!result.ok) setError(result.error); else setExpanded(true)
    }
    catch (e) { setError(e instanceof Error ? e.message : 'The workflow host could not be reached.') }
    finally { setBusy(false) }
  }
  if (!templates.length && !runs.length) return compact ? null : <p className="workflow-hint">Create saved workflows in this project’s Settings → Workflows.</p>
  return <div className="workflow-issue nodrag nowheel" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <div className="workflow-actions">
      {!active && selected && <button type="button" disabled={busy || !!unsupported} title={unsupported ? 'Workflows require a local project on its host.' : selected.name}
        onClick={() => void start(selected.id)}>Run {selected.name}</button>}
      {!active && templates.length > 1 && <select aria-label="Run another workflow" value="" disabled={busy || !!unsupported}
        onChange={e => { if (e.target.value) void start(e.target.value) }}>
        <option value="">Other workflows…</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>}
      {runs.length > 0 && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {active ? `${active.template.name}: ${active.state.replaceAll('-', ' ')}` : `Workflow history (${runs.length})`}
      </button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {expanded && runs.slice(0, 10).map(run => <WorkflowRunControls key={run.id} projectId={projectId} run={run} onOpenNode={onOpenNode} />)}
  </div>
}

function sameIssue(a: IssueRef, b: IssueRef): boolean {
  return a.number === b.number && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
}

export function WorkflowGroupControls({ groupId }: { groupId: string }): React.JSX.Element | null {
  const flow = useReactFlow()
  const projectId = useProjects(s => s.activeProjectId)
  const api = projectId ? sessionForProject(projectId).api.workflows : undefined
  const runs = useWorkflowRuns(api, projectId ?? '')
  const [expanded, setExpanded] = useState(false)
  const run = runs.find(r => r.groupId === groupId)
  if (!projectId || !run) return null
  return <div className="workflow-group nodrag nowheel">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      Workflow · {Math.min(run.stepIndex + 1, run.template.steps.length)}/{run.template.steps.length} · {run.state.replaceAll('-', ' ')}
    </button>
    {expanded && <WorkflowRunControls projectId={projectId} run={run} onOpenNode={id => {
      const node = flow.getNode(id)
      if (node) void flow.fitView({ nodes: [node], duration: 200, maxZoom: 1 })
    }} />}
  </div>
}
