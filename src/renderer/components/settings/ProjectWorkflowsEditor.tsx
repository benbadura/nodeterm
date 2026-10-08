import { useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import { builtinWorkflows, sanitizeProjectWorkflows, type ProjectWorkflows, type WorkflowStep } from '@shared/workflows'
import { BUILTIN_AGENT_IDS, hasHooks, canControlCanvas, canContextLink } from '@shared/agents/config'
import { useSettings } from '../../state/settings'
import { useProjects } from '../../state/projects'
import { sessionForProject } from '../../session/session'
import { flushWorkspaceEdits } from '../../state/workspaceDirty'

const newId = () => crypto.randomUUID()
export function ProjectWorkflowsEditor({ project }: { project: Project }): React.JSX.Element {
  const settings = useSettings(s => s.settings)
  const [draft, setDraft] = useState<ProjectWorkflows>(project.workflows ?? { templates: [] })
  const [selected, setSelected] = useState(project.workflows?.templates[0]?.id ?? '')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => { if (!dirty) setDraft(project.workflows ?? { templates: [] }) }, [project.workflows, dirty])
  const agents = [...BUILTIN_AGENT_IDS, ...settings.customAgents.map(a => a.id)].filter(a => hasHooks(a) && canControlCanvas(a) && canContextLink(a))
  const defaultAgent = agents.includes(settings.defaultAgent) ? settings.defaultAgent : agents[0] ?? 'claude'
  const template = draft.templates.find(t => t.id === selected) ?? draft.templates[0]
  const update = (value: ProjectWorkflows) => { setDraft(value); setDirty(true); setMessage('') }
  const edit = (patch: Partial<NonNullable<typeof template>>) => update({ ...draft, templates: draft.templates.map(t => t.id === template?.id ? { ...t, ...patch } : t) })
  const stage = (id: string, patch: Partial<WorkflowStep>) => edit({ steps: template!.steps.map(s => s.id === id ? { ...s, ...patch } : s) })
  const move = (index: number, offset: number) => { const steps = [...template!.steps]; [steps[index], steps[index + offset]] = [steps[index + offset], steps[index]]; edit({ steps }) }
  const save = async () => {
    setBusy(true); setMessage('')
    try {
      const api = sessionForProject(project.id).api
      await flushWorkspaceEdits(api)
      const result = await api.workflows.saveTemplates(project.id, draft)
      if (!result.ok) { setMessage(result.error); return }
      useProjects.setState(s => ({ projects: s.projects.map(p => p.id === project.id ? { ...p, workflows: result.value } : p) }))
      setDraft(result.value); setDirty(false); setMessage('Saved to .nodeterm/project.json.')
    } catch (e) { setMessage(e instanceof Error ? e.message : 'The workflow templates could not be saved.') }
    finally { setBusy(false) }
  }
  if (project.ssh || !project.cwd) return <p>Workflows require a local project folder. SSH projects are unsupported.</p>
  return <section className="workflow-editor" aria-label="Saved workflows">
    <h3>Workflows</h3>
    <p>Reusable stages launched from an issue. Templates are shared with the project; each run has its own worktree and local history.</p>
    <div className="workflow-actions">
      <button type="button" disabled={busy} onClick={() => {
        const builtins = builtinWorkflows(defaultAgent)
        const added = builtins.templates.filter(t => !draft.templates.some(v => v.id === t.id))
        update({ templates: [...draft.templates, ...added], defaultTemplateId: draft.defaultTemplateId ?? builtins.defaultTemplateId }); setSelected(added[0]?.id ?? draft.templates[0]?.id ?? '')
      }}>Add starter templates</button>
      <button type="button" disabled={busy || draft.templates.length >= 50} onClick={() => {
        const id = newId(); update({ ...draft, templates: [...draft.templates, { id, name: 'New workflow', steps: [{ id: newId(), title: 'Stage 1', agentId: defaultAgent, instruction: '', transition: 'success' }] }] }); setSelected(id)
      }}>New workflow</button>
      <button type="button" disabled={busy || !dirty || !sanitizeProjectWorkflows(draft)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save workflows'}</button>
    </div>
    {template && <>
      <label>Template<select value={template.id} onChange={e => setSelected(e.target.value)}>{draft.templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <label>Name<input value={template.name} maxLength={160} onChange={e => edit({ name: e.target.value })} /></label>
      <label>Default workflow<select value={draft.defaultTemplateId ?? ''} onChange={e => update({ ...draft, defaultTemplateId: e.target.value || undefined })}>
        <option value="">First template</option>{draft.templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select></label>
      <ol>{template.steps.map((s, index) => <li key={s.id}>
        <div className="workflow-actions"><strong>Stage {index + 1}</strong>
          <button type="button" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${s.title} up`}>↑</button>
          <button type="button" disabled={index === template.steps.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${s.title} down`}>↓</button>
          <button type="button" disabled={template.steps.length === 1} onClick={() => edit({ steps: template.steps.filter(v => v.id !== s.id) })}>Remove stage</button>
        </div>
        <label>Stage title<input value={s.title} maxLength={160} onChange={e => stage(s.id, { title: e.target.value })} /></label>
        <div className="workflow-editor__pair"><label>Agent<select value={s.agentId} onChange={e => stage(s.id, { agentId: e.target.value })}>
          {!agents.includes(s.agentId) && <option value={s.agentId}>{s.agentId} (unavailable)</option>}
          {agents.map(a => <option key={a} value={a}>{a}</option>)}
        </select></label><label>Model (optional)<input value={s.model ?? ''} maxLength={256} placeholder="Agent default" onChange={e => stage(s.id, { model: e.target.value || undefined })} /></label></div>
        <label>Instruction<textarea rows={4} value={s.instruction} maxLength={32000} onChange={e => stage(s.id, { instruction: e.target.value })} /></label>
        <label>Continue when<select value={s.transition} onChange={e => stage(s.id, { transition: e.target.value as WorkflowStep['transition'] })}>
          <option value="success">Agent reports success and finishes</option><option value="manual">Agent finishes and I approve</option>
        </select></label>
      </li>)}</ol>
      <div className="workflow-actions"><button type="button" disabled={template.steps.length >= 32} onClick={() => edit({ steps: [...template.steps, { id: newId(), title: `Stage ${template.steps.length + 1}`, agentId: defaultAgent, instruction: '', transition: 'success' }] })}>Add stage</button>
        <button type="button" onClick={() => { update({ ...draft, templates: draft.templates.filter(t => t.id !== template.id), defaultTemplateId: draft.defaultTemplateId === template.id ? undefined : draft.defaultTemplateId }); setSelected('') }}>Delete template</button>
      </div>
    </>}
    {dirty && <p>Unsaved changes. Existing runs keep their original stages.</p>}
    {message && <p role="status">{message}</p>}
  </section>
}
