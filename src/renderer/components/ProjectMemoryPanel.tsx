import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { emptyCheckpoint, emptyDecision, unavailableProjectMemory, type DecisionInput, type MemoryCheckpointInput, type MemoryDecision, type MemoryResult, type MemorySelection, type MemorySource, type MemoryView } from '@shared/project-memory'
import type { AgentId } from '@shared/agents/config'
import { useProjects } from '../state/projects'
import { useSettings } from '../state/settings'
import { useModelGateway } from '../state/modelGateway'
import { useProjectMemoryPanel } from '../state/projectMemory'
import { sessionForProject } from '../session/session'
import { transferConversationItems } from '../lib/transferItems'
import { isTopDialog, nextDialogId, popDialog, pushDialog } from './dialog-stack'
import { ContextMenu } from './ContextMenu'
import '../project-memory.css'

const checkpointLabels: Record<keyof Omit<MemoryCheckpointInput, 'sources'>, string> = { goal: 'Goal', completed: 'Completed', remaining: 'Remaining', blockers: 'Blockers', attempts: 'Previous attempts and results', nextStep: 'Next step' }
const decisionLabels: Record<'title' | 'decision' | 'rationale' | 'constraints' | 'alternatives', string> = { title: 'Title', decision: 'Decision', rationale: 'Why this solution', constraints: 'Constraints', alternatives: 'Alternatives and previous attempts' }

function SourceEditor({ sources, onChange }: { sources: MemorySource[]; onChange: (s: MemorySource[]) => void }) {
  return <fieldset><legend>Sources</legend>{sources.map((source, index) => <div className="memory-source-editor" key={index}>
    <label>Kind<select value={source.kind} onChange={(e) => onChange(sources.map((s, i) => i === index ? { ...s, kind: e.target.value as MemorySource['kind'], commit: undefined } : s))}><option value="file">Project file</option><option value="session">Conversation</option><option value="url">Web link</option></select></label>
    {(['label', 'location', 'excerpt'] as const).map((field) => <label key={field}>{field === 'location' ? 'Relative file path, URL, or session node ID' : field === 'excerpt' ? 'Saved excerpt (author supplied)' : 'Label'}<textarea rows={field === 'excerpt' ? 3 : 1} maxLength={field === 'excerpt' ? 1500 : field === 'label' ? 200 : 2000} value={source[field]} onChange={(e) => onChange(sources.map((s, i) => i === index ? { ...s, [field]: e.target.value } : s))} /></label>)}
    {source.kind === 'file' && <label>Git commit (optional full hash)<input value={source.commit ?? ''} maxLength={64} onChange={(e) => onChange(sources.map((s, i) => i === index ? { ...s, commit: e.target.value || undefined } : s))} /></label>}
    <button type="button" onClick={() => onChange(sources.filter((_, i) => i !== index))}>Remove source</button>
  </div>)}<button type="button" disabled={sources.length >= 20} onClick={() => onChange([...sources, { kind: 'file', location: '', label: '', excerpt: '' }])}>Add source</button></fieldset>
}

export function ProjectMemoryPanel({ projectId, nodeId, taskId, onSelectTask }: { projectId: string; nodeId?: string; taskId?: string; onSelectTask?: (taskId: string) => void }) {
  let api
  try { api = sessionForProject(projectId).api } catch { api = undefined }
  const memory = api?.projectMemory ?? unavailableProjectMemory
  const [view, setView] = useState<MemoryView>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [decision, setDecision] = useState<DecisionInput>()
  const [checkpoint, setCheckpoint] = useState<MemoryCheckpointInput>()
  const [editRevision, setEditRevision] = useState(0)
  const [packet, setPacket] = useState('')
  const [history, setHistory] = useState(false)
  const [sourceText, setSourceText] = useState('')
  const [sourceNodeId, setSourceNodeId] = useState<string>()
  const formRef = useRef<HTMLFormElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number }>()
  const sequence = useRef(0)
  const settings = useSettings((s) => s.settings)
  const models = useModelGateway((s) => s.models)
  const selection: MemorySelection = { ...(nodeId ? { nodeId } : {}), ...(taskId ? { taskId } : {}) }
  const refresh = useCallback(async () => {
    const ticket = ++sequence.current
    const result = await memory.read(projectId, { nodeId, taskId }).catch((e): MemoryResult<MemoryView> => ({ ok: false, error: String(e) }))
    if (ticket !== sequence.current) return
    if (result.ok) { setView(result.value); setError('') } else { setError(result.error); setView(undefined) }
  }, [memory, projectId, nodeId, taskId])
  useEffect(() => {
    setView(undefined); setDecision(undefined); setCheckpoint(undefined); setPacket(''); setSourceText(''); setSourceNodeId(undefined)
    void refresh()
    const off = memory.onChanged((id) => { if (id === projectId) void refresh() })
    return () => { sequence.current++; off() }
  }, [refresh, memory, projectId])
  useEffect(() => { formRef.current?.scrollIntoView?.({ block: 'nearest' }) }, [!!decision, !!checkpoint])
  const action = async (run: () => Promise<MemoryResult<unknown>>): Promise<boolean> => {
    setBusy(true); setError('')
    try {
      const result = await run()
      if (!result.ok) { setError(result.error); return false }
      await refresh(); return true
    } catch (e) { setError(String(e)); return false }
    finally { setBusy(false) }
  }
  const editDecision = (d?: MemoryDecision) => {
    setCheckpoint(undefined)
    const scope = d?.scope ?? (nodeId || taskId ? 'task' : 'project')
    setEditRevision(scope === 'project' ? view?.project.revision ?? 0 : view?.task?.revision ?? 0)
    setDecision(d ? { ...d, replaces: d.id } : { ...emptyDecision(), scope })
  }
  const openSource = async (source: MemorySource) => {
    setSourceNodeId(undefined)
    if (source.kind === 'url') { api?.shell.openExternal(source.location); return }
    if (source.kind === 'session') {
      const node = useProjects.getState().projects.find((p) => p.id === projectId)?.nodes.find((n) => n.id === source.location)
      setSourceNodeId(node?.id)
      setSourceText(`${source.label}\n${node ? 'Original session: ' + node.title : 'Original session unavailable.'}\n\nSaved excerpt (author supplied):\n${source.excerpt || 'No excerpt recorded.'}`)
      return
    }
    const result = await memory.source(projectId, source).catch((e): MemoryResult<string> => ({ ok: false, error: String(e) }))
    setSourceText(`${source.label}\n${result.ok ? result.value : result.error}\n\nSaved excerpt (author supplied):\n${source.excerpt || 'No excerpt recorded.'}`)
  }
  const transfer = async (agentId: AgentId, model?: string) => {
    setMenu(undefined)
    await action(async () => {
      const result = await memory.packet(projectId, selection)
      if (!result.ok) return result
      if (!result.value.taskId) return { ok: false, error: 'Select a task to transfer.' }
      useProjectMemoryPanel.getState().transfer({ projectId, taskId: result.value.taskId, sourceNodeId: nodeId, agentId, model })
      return { ok: true, value: undefined }
    })
  }
  const decisions = [...(view?.task?.decisions ?? []), ...(view?.project.decisions ?? [])]
  const pending = decisions.filter((d) => d.status === 'proposed').length
  const latest = view?.task?.checkpoints.at(-1)
  return <section className="project-memory" aria-label="Project memory" aria-busy={busy}>
    <div className="memory-toolbar"><strong>{view?.task?.title || 'Project memory'} {pending > 0 && <span className="memory-count">{pending} proposals</span>}</strong><button onClick={() => void refresh()} disabled={busy}>Refresh</button></div>
    {error && <p role="alert" className="memory-error">{error}</p>}
    {!view && !error && <p>Loading memory…</p>}
    {view && <>
      {!nodeId && !taskId && <section><h3>Tasks</h3>{!view.tasks.length && <p>No task checkpoints yet.</p>}{view.tasks.map((task) => <button className="memory-task" key={task.id} onClick={() => onSelectTask?.(task.id)}>{task.title}<small>{task.updatedAt ? new Date(task.updatedAt).toLocaleString() : 'State not recorded'}</small></button>)}</section>}
      {(nodeId || taskId) && <section><h3>Task state</h3>{latest ? <><p className="memory-muted">Reported by {latest.author} · {new Date(latest.at).toLocaleString()} · verify against the current checkout</p>{Object.entries(checkpointLabels).map(([key, label]) => <div key={key}><strong>{label}</strong><p className="memory-text">{latest[key as keyof typeof checkpointLabels] || 'Not recorded.'}</p></div>)}{latest.sources.map((s, i) => <button key={i} onClick={() => void openSource(s)}>{s.label} ↗</button>)}</> : <p>Goal, current state and next step have not been recorded.</p>}
        <button disabled={busy} onClick={() => { setDecision(undefined); setEditRevision(view.task?.revision ?? 0); setCheckpoint(latest ?? emptyCheckpoint()) }}>Update task state</button>{view.task && <details><summary>Checkpoint history ({view.task.checkpoints.length})</summary>{[...view.task.checkpoints].reverse().map((c) => <article key={c.id}><strong>{c.author} · {new Date(c.at).toLocaleString()}</strong>{Object.entries(checkpointLabels).map(([key, label]) => <p className="memory-text" key={key}>{label}: {c[key as keyof typeof checkpointLabels] || 'Not recorded.'}</p>)}</article>)}</details>}
      </section>}
      <div className="memory-toolbar"><h3>Decisions</h3><button disabled={busy} onClick={() => editDecision()}>Propose decision</button><label><input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> Show history</label></div>
      {!decisions.length && <p>No decisions recorded.</p>}
      {decisions.filter((d) => history || ['proposed', 'approved'].includes(d.status)).map((d) => <article key={d.id} className="memory-decision"><div className="memory-toolbar"><strong>{d.title}</strong><span>{d.scope} · {d.status}</span></div><p className="memory-muted">{d.author} · {new Date(d.at).toLocaleString()}{d.reviewedAt && ` · ${d.reviewedBy} reviewed ${new Date(d.reviewedAt).toLocaleString()}`}</p>
        {(['decision', 'rationale', 'constraints', 'alternatives'] as const).map((key) => <p className="memory-text" key={key}><strong>{decisionLabels[key]}: </strong>{d[key] || 'Not recorded.'}</p>)}
        {d.sources.map((source, i) => <details key={i}><summary>{source.label}</summary><p><button onClick={() => void openSource(source)}>Open source</button> <code>{source.location}{source.commit && ` @ ${source.commit}`}</code></p><blockquote>{source.excerpt || 'No saved excerpt.'}</blockquote><small>Excerpt supplied by the author.</small></details>)}
        <div className="memory-toolbar">{d.status === 'proposed' && <><button disabled={busy} onClick={() => void action(() => memory.review(projectId, selection, d.scope, d.id, 'approve', d.scope === 'project' ? view.project.revision : view.task!.revision))}>Approve</button><button disabled={busy} onClick={() => void action(() => memory.review(projectId, selection, d.scope, d.id, 'reject', d.scope === 'project' ? view.project.revision : view.task!.revision))}>Reject</button></>}{['proposed', 'approved'].includes(d.status) && <button disabled={busy} onClick={() => editDecision(d)}>Propose revision</button>}{d.status === 'approved' && <button disabled={busy} onClick={() => void action(() => memory.review(projectId, selection, d.scope, d.id, 'withdraw', d.scope === 'project' ? view.project.revision : view.task!.revision))}>Withdraw</button>}</div>
      </article>)}
      <div className="memory-toolbar"><button disabled={busy} onClick={() => void action(async () => { const result = await memory.packet(projectId, selection); if (result.ok) setPacket(result.value.body); return result })}>Preview startup packet</button>{(nodeId || taskId) && <button disabled={busy} onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}>Transfer task…</button>}</div>
      {packet && <details open><summary>Startup packet</summary><pre>{packet}</pre></details>}
      {sourceText && <details open><summary>Source preview</summary>{sourceNodeId && <button onClick={() => useProjectMemoryPanel.getState().openSource(projectId, sourceNodeId)}>Open original session</button>}<pre>{sourceText}</pre></details>}
      {decision && <form ref={formRef} onSubmit={(e) => { e.preventDefault(); void action(() => memory.propose(projectId, selection, decision, editRevision)).then((ok) => { if (ok) setDecision(undefined) }) }}><h3>{decision.replaces ? 'Propose revised decision' : 'Propose decision'}</h3><label>Scope<select disabled={!!decision.replaces} value={decision.scope} onChange={(e) => { const scope = e.target.value as DecisionInput['scope']; setDecision({ ...decision, scope }); setEditRevision(scope === 'project' ? view.project.revision : view.task?.revision ?? 0) }}><option value="project">Project</option>{(nodeId || taskId) && <option value="task">Task</option>}</select></label>{Object.entries(decisionLabels).map(([key, label]) => <label key={key}>{label}<textarea required={['title', 'decision', 'rationale'].includes(key)} maxLength={key === 'title' ? 200 : 4000} value={decision[key as keyof typeof decisionLabels]} onChange={(e) => setDecision({ ...decision, [key]: e.target.value })} /></label>)}<SourceEditor sources={decision.sources} onChange={(sources) => setDecision({ ...decision, sources })} /><button disabled={busy} type="submit">Save proposal</button><button type="button" onClick={() => setDecision(undefined)}>Cancel</button></form>}
      {checkpoint && <form ref={formRef} onSubmit={(e) => { e.preventDefault(); void action(() => memory.checkpoint(projectId, selection, checkpoint, editRevision)).then((ok) => { if (ok) setCheckpoint(undefined) }) }}><h3>Update task state</h3>{Object.entries(checkpointLabels).map(([key, label]) => <label key={key}>{label}<textarea required={key === 'goal' || key === 'nextStep'} maxLength={key === 'nextStep' || key === 'blockers' ? 1500 : 2000} value={checkpoint[key as keyof typeof checkpointLabels]} onChange={(e) => setCheckpoint({ ...checkpoint, [key]: e.target.value })} /></label>)}<SourceEditor sources={checkpoint.sources} onChange={(sources) => setCheckpoint({ ...checkpoint, sources })} /><button disabled={busy} type="submit">Save checkpoint</button><button type="button" onClick={() => setCheckpoint(undefined)}>Cancel</button></form>}
    </>}
    {menu && <ContextMenu {...menu} zIndex={95} onClose={() => setMenu(undefined)} items={transferConversationItems(nodeId ?? '', undefined, { sourceAgentId: 'claude', sessionId: undefined, taskTransfer: true, disabledAgents: settings.disabledAgents, customAgents: settings.customAgents, gatewayModels: models }, (_node, agent, _at, model) => void transfer(agent, model))} />}
  </section>
}

export function ProjectMemoryDialog() {
  const opened = useProjectMemoryPanel((s) => s.opened)
  const close = useProjectMemoryPanel((s) => s.close)
  const dialog = useRef<HTMLDivElement>(null)
  const [dialogId] = useState(nextDialogId)
  useEffect(() => {
    if (!opened) return
    pushDialog(dialogId)
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (!isTopDialog(dialogId)) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close() }
      if (e.key === 'Tab') {
        const elements = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, summary, [tabindex="0"]')
        if (!elements?.length) return
        const first = elements[0], last = elements[elements.length - 1]
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', key, true)
    return () => { popDialog(dialogId); document.removeEventListener('keydown', key, true); previous?.focus() }
  }, [opened, close, dialogId])
  if (!opened) return null
  return createPortal(<div className="memory-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}><div className="memory-dialog" role="dialog" aria-modal="true" aria-label="Project memory" tabIndex={-1} ref={dialog}><header><h2>Project memory</h2>{opened.selection.taskId && <button onClick={() => useProjectMemoryPanel.getState().open(opened.projectId)}>All tasks</button>}<button onClick={close} aria-label="Close project memory">Close</button></header><ProjectMemoryPanel key={JSON.stringify(opened)} projectId={opened.projectId} {...opened.selection} onSelectTask={(taskId) => useProjectMemoryPanel.getState().open(opened.projectId, { taskId })} /></div></div>, document.body)
}
