import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS, capabilityAgentId } from '@shared/agents/config'
import type { Project, KanbanPriority } from '@shared/types'
import { TASK_STAGES, latestTaskResult, latestTaskRun, taskAttention, taskBoardPreference, type TaskAction, type TaskCreate, type TaskRecord, type TaskReply, type TaskView } from '@shared/tasks'
import type { CodeSnapshot } from '@shared/task-readiness'
import type { GitHubIssueCardView } from '@shared/github-issues'
import type { GitHubPullBoard } from '@shared/github-pull-status'
import { issueKey, issueRefFromHtmlUrl, issueUrl } from '@shared/github-issue-ref'
import { columnCategory } from '@shared/kanban-category'
import { useProjects } from '../../state/projects'
import { useSettings } from '../../state/settings'
import { useAgentStatus } from '../../state/agentStatus'
import { useViewMode } from '../../state/viewMode'
import { isBrowserRuntime } from '../../bridge/runtime'
import { projectSessionSource } from '../LiveLinkChip'
import { uuid } from '../../lib/uuid'
import { KanbanScopeSwitch } from './KanbanScopeSwitch'
import { ReportEditor, ReportView } from './ReadinessPanel'
import type { KanbanSession } from './KanbanView'
import { registerBoardKeys, type BoardKeyAction } from '../../lib/boardKeys'
import { openDialogCount, useDialogStack } from '../dialog-stack'

// One board is the workspace; the inspector owns decisions. Color conveys status only.
export function TaskBoardGate({ projectId, global = false, sessions = [], onOpenNode, children }: {
  projectId: string | null; global?: boolean; sessions?: KanbanSession[]
  onOpenNode: (nodeId: string, projectId: string) => void; children: ReactNode
}) {
  const all = useProjects(s => s.projects)
  const preferences = useSettings(s => s.settings.taskBoards)
  const [legacy, setLegacy] = useState(false)
  useEffect(() => setLegacy(false), [projectId, global])
  const projects = useMemo(() => all.filter(p => (!global ? p.id === projectId : !p.closed) && !p.ssh && !p.remote && !p.unavailable && p.cwd &&
    !isBrowserRuntime() && projectSessionSource(p.id) === 'local' && taskBoardPreference({ taskBoards: preferences }, p.id).enabled), [all, preferences, projectId, global])
  if (!projects.length) return <>{children}</>
  if (legacy) return <><button className="task-return" onClick={() => setLegacy(false)}>← Task board</button>{children}</>
  return <TaskBoard key={`${global}:${projectId}`} projects={projects} sessions={sessions} global={global} onLegacy={nodeId => { setLegacy(true); if (nodeId) useViewMode.getState().requestCard(nodeId) }} onOpenNode={onOpenNode} />
}

type Row = { project: Project; task: TaskRecord }
function message(e: unknown) { return e instanceof Error ? e.message : String(e) }
function value<T>(r: TaskReply<T>): T { if (!r.ok) throw new Error(r.error); return r.value }

export function TaskBoard({ projects, sessions, global, onLegacy, onOpenNode }: {
  projects: Project[]; sessions: KanbanSession[]; global: boolean; onLegacy(nodeId?: string): void; onOpenNode(nodeId: string, projectId: string): void
}) {
  const api = window.nodeTerminal.tasks
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<Row>()
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [filter, setFilter] = useState<'board' | 'attention' | 'archive'>('board')
  const [search, setSearch] = useState('')
  const relevantNodes = rows.map(r => latestTaskRun(r.task)?.nodeId).filter((id): id is string => !!id)
  useAgentStatus(s => relevantNodes.map(id => `${id}:${s.byId[id]?.state ?? ''}:${!!s.byId[id]?.lastTurnError}`).join('|'))
  const statuses = useAgentStatus.getState().byId
  const [views, setViews] = useState<Record<string, TaskView>>({})
  const checked = useRef(new Map<string, { revision: number; at: number }>())
  const refreshVersion = useRef(0)
  const projectIds = projects.map(p => p.id).join('\0')
  const projectRef = useRef(projects); projectRef.current = projects
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current
    try {
      const results = await Promise.all(projectRef.current.map(async project => ({ project, tasks: value(await api.list(project.id)) })))
      if (version !== refreshVersion.current) return
      setRows(results.flatMap(({ project, tasks }) => tasks.map(task => ({ project, task })))); setLoaded(true); setError('')
      for (const { project, tasks } of results) for (const task of tasks) {
        if (task.archivedAt || task.stage !== 'ready_for_acceptance' || !latestTaskResult(task)?.report) continue
        if (version !== refreshVersion.current) return
        const key = `${project.id}:${task.id}`; const stamp = checked.current.get(key)
        if (stamp?.revision === task.revision && Date.now() - stamp.at < 30000) continue
        checked.current.set(key, { revision: task.revision, at: Date.now() })
        const view = await api.read(project.id, task.id)
        if (view.ok && version === refreshVersion.current) setViews(prev => prev[key]?.task.revision > view.value.task.revision ? prev : ({ ...prev, [key]: view.value }))
      }
    } catch (e) { if (version === refreshVersion.current) setError(message(e)) }
  }, [api, projectIds])
  useEffect(() => {
    let stopped = false
    const run = () => { if (!stopped && document.visibilityState !== 'hidden') void refresh() }
    run(); const off = api.onChanged(id => { if (projectRef.current.some(p => p.id === id)) run() })
    window.addEventListener('focus', run)
    const timer = setInterval(run, 5000)
    return () => { stopped = true; ++refreshVersion.current; off(); clearInterval(timer); window.removeEventListener('focus', run) }
  }, [api, refresh])
  const requestedNode = useViewMode(s => s.requestedCardNodeId)
  useEffect(() => {
    if (!requestedNode || !loaded) return
    const row = rows.find(({ task }) => task.runs.some(r => r.nodeId === requestedNode) || task.legacyNodeIds.includes(requestedNode))
    useViewMode.getState().clearCardRequest()
    if (row) setSelected(row); else onLegacy(requestedNode)
  }, [requestedNode, loaded, rows, onLegacy])
  const visible = rows.filter(r => (filter === 'archive' ? !!r.task.archivedAt : !r.task.archivedAt) && `${r.task.title} ${r.task.description} ${r.project.name}`.toLowerCase().includes(search.toLowerCase()))
  const attention = visible.map(row => ({ ...row, attention: taskAttention(row.task, statuses[latestTaskRun(row.task)?.nodeId ?? ''], views[`${row.project.id}:${row.task.id}`]) })).filter(r => r.attention)
    .sort((a, b) => a.attention!.priority - b.attention!.priority || b.attention!.at - a.attention!.at || a.task.id.localeCompare(b.task.id))
  const choose = (row: Row) => setSelected(row)
  const move = async (row: Row, stage: TaskRecord['stage'], beforeId?: string) => {
    try { value(await api.act(row.project.id, row.task.id, row.task.revision, { type: 'move', stage, beforeId })); await refresh() } catch (e) { setError(message(e)) }
  }
  const create = async (projectId: string, input: TaskCreate) => {
    const task = value(await api.create(projectId, input)); await refresh(); setCreating(false); setImporting(false)
    setSelected({ project: projects.find(p => p.id === projectId)!, task })
  }
  const drag = useRef<Row>()
  const keyboard = useRef<(action: BoardKeyAction) => boolean>(() => false)
  keyboard.current = action => {
    const target = document.activeElement as HTMLElement | null
    if (openDialogCount() || target?.closest('input, textarea, select, [contenteditable="true"]')) return false
    const cards = [...document.querySelectorAll<HTMLButtonElement>('[data-task-card]')]
    const current = target?.closest('[data-task-card]') as HTMLButtonElement | null
    if (action === 'open') { if (!current) return false; current.click(); return true }
    if (!cards.length) return false
    const index = current ? cards.indexOf(current) : -1
    let next: HTMLButtonElement | undefined
    if (action === 'left' || action === 'right') {
      const columns = [...document.querySelectorAll('.task-column')]
      const column = current?.closest('.task-column')
      if (!column) return false
      next = columns[columns.indexOf(column) + (action === 'right' ? 1 : -1)]?.querySelector<HTMLButtonElement>('[data-task-card]') ?? undefined
    } else next = cards[index < 0 ? action === 'prev' ? cards.length - 1 : 0 : (index + (action === 'next' ? 1 : -1) + cards.length) % cards.length]
    if (!next) return false
    next.focus(); next.scrollIntoView?.({ block: 'nearest' }); return true
  }
  useEffect(() => registerBoardKeys(action => keyboard.current(action)), [])
  return <section className="task-board" aria-label="Task board">
    <header className="task-board__header"><div><span className="task-eyebrow">{global ? 'All local projects' : projects[0]?.name}</span><h1>Tasks</h1></div>
      <KanbanScopeSwitch scope={global ? 'all' : 'project'} />
      <button onClick={() => onLegacy()}>Session view</button><button onClick={() => setImporting(true)}>Import</button>
      <button className="task-primary" onClick={() => setCreating(true)}>+ New task</button>
    </header>
    <div className="task-board__tools"><nav aria-label="Task views">{(['board', 'attention', 'archive'] as const).map(f => <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'attention' ? `Needs attention${attention.length ? ` · ${attention.length}` : ''}` : f === 'archive' ? 'Archive' : 'Board'}</button>)}</nav>
      <input aria-label="Search tasks" placeholder="Search tasks…" value={search} onChange={e => setSearch(e.target.value)} />
      {rows.some(r => latestTaskRun(r.task)?.state === 'queued') && <button onClick={() => void Promise.all(projects.map(async p => value(await api.resumeQueue(p.id)))).then(refresh).catch(e => setError(message(e)))}>Resume queue</button>}
    </div>
    {error && <div className="task-error" role="alert">{error}<button onClick={() => void refresh()}>Reload</button></div>}
    {!loaded && !error && <p className="task-empty" role="status">Loading tasks…</p>}
    {filter === 'board' ? <div className="task-board__columns">{TASK_STAGES.map(stage => {
      const cards = visible.filter(r => r.task.stage === stage.id).sort((a, b) => a.task.rank.localeCompare(b.task.rank) || a.task.id.localeCompare(b.task.id))
      return <section className="task-column" key={stage.id} aria-label={stage.label} onDragOver={e => { if (drag.current) e.preventDefault() }} onDrop={e => { e.preventDefault(); const row = drag.current; drag.current = undefined; if (row) { if (stage.id === 'done') choose(row); else void move(row, stage.id) } }}>
        <h2><span className={`task-stage-dot task-stage-dot--${stage.id}`} />{stage.label}<span>{cards.length}</span></h2>
        {cards.map(row => { const run = latestTaskRun(row.task); const need = taskAttention(row.task, statuses[run?.nodeId ?? ''], views[`${row.project.id}:${row.task.id}`]); return <button className="task-card" data-task-card={row.task.id} key={`${row.project.id}:${row.task.id}`} draggable onDragStart={() => { drag.current = row }} onDragEnd={() => { drag.current = undefined }} onClick={() => choose(row)}
          onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); e.stopPropagation(); const source = drag.current; drag.current = undefined; if (source?.project.id === row.project.id && source.task.id !== row.task.id && stage.id !== 'done') void move(source, stage.id, row.task.id) }}>
          {global && <small>{row.project.name}</small>}<strong>{row.task.title}</strong>
          {need ? <span className={`task-card__signal task-card__signal--${need.kind}`}>{need.label}</span> : run && <span className="task-muted">{run.role} · {run.state}</span>}
          <span className="task-card__foot">{row.task.issueRef && <span>#{row.task.issueRef.number}</span>}{row.task.planFirst && !run && <span>Plan first</span>}{row.task.meta?.priority && <span>{row.task.meta.priority}</span>}{row.task.meta?.dueAt && <span>{new Date(row.task.meta.dueAt).toLocaleDateString()}</span>}<span>{row.task.runs.length ? `${row.task.runs.length} runs` : 'Not started'}</span></span>
        </button> })}
        {!cards.length && <p className="task-column__empty">{stage.id === 'todo' ? 'Add a task with a clear outcome.' : stage.id === 'in_progress' ? 'Started tasks appear here.' : stage.id === 'ready_for_acceptance' ? 'Reported results wait for your decision.' : 'Accepted work stays in history.'}</p>}
      </section>
    })}</div> : <div className="task-list">{filter === 'attention' ? attention.length ? attention.map(row => <button key={`${row.project.id}:${row.task.id}`} onClick={() => choose(row)}><span><strong>{row.task.title}</strong><small>{row.project.name} · {row.attention!.label}</small></span><span>{row.attention!.action} →</span></button>) : <p className="task-empty">Nothing needs your attention.</p> : visible.map(row => <button key={row.task.id} onClick={() => choose(row)}><strong>{row.task.title}</strong><span>View history →</span></button>)}</div>}
    {creating && <TaskDialog title="New task" close={() => setCreating(false)}><TaskForm projects={projects} save={create} /></TaskDialog>}
    {importing && <TaskDialog title="Import a task" close={() => setImporting(false)}><TaskImport projects={projects} sessions={sessions} create={create} /></TaskDialog>}
    {selected && <TaskDialog title={selected.task.title} close={() => setSelected(undefined)}><TaskDetail project={selected.project} taskId={selected.task.id} close={() => setSelected(undefined)} changed={refresh} onOpenNode={onOpenNode} onOriginal={onLegacy} /></TaskDialog>}
  </section>
}

function TaskDialog({ title, close, children }: { title: string; close(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const isTop = useDialogStack()
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="task-dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close() }}><div ref={ref} className="task-dialog readiness-panel" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={e => {
    if (!isTop()) return
    if (e.key === 'Escape') { e.stopPropagation(); close() }
    if (e.key === 'Tab') {
      const nodes = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]')].filter(n => n.getClientRects().length)
      const first = nodes[0], last = nodes.at(-1)
      if (!first) { e.preventDefault(); return }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { e.preventDefault(); first.focus() }
    }
  }}><header className="task-dialog__header"><h2>{title}</h2><button aria-label="Close task" onClick={close}>✕</button></header>{children}</div></div>
}

function TaskForm({ projects, task, save }: { projects: Project[]; task?: TaskRecord; save(id: string, input: TaskCreate): Promise<void> }) {
  const [projectId, setProject] = useState(projects[0]?.id ?? '')
  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [criteria, setCriteria] = useState(task?.criteria.map(c => c.text).join('\n') ?? '')
  const [planFirst, setPlanFirst] = useState(task?.planFirst ?? false)
  const [autoReview, setAutoReview] = useState(task?.autoReview ?? false)
  const [priority, setPriority] = useState<KanbanPriority | ''>(task?.meta?.priority ?? '')
  const [due, setDue] = useState(task?.meta?.dueAt ? new Date(task.meta.dueAt).toISOString().slice(0, 10) : '')
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  return <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { await save(projectId, { title, description, planFirst, autoReview, meta: { ...task?.meta, priority: priority || undefined, dueAt: due ? new Date(`${due}T12:00:00`).getTime() : undefined }, criteria: criteria.split('\n').map(s => s.trim()).filter(Boolean).map((text, i) => ({ id: task?.criteria[i]?.id ?? uuid(), text })) }) } catch (e) { setError(message(e)) } finally { setBusy(false) } }}>
    {projects.length > 1 && <label>Project<select value={projectId} onChange={e => setProject(e.target.value)}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
    <label>Title<input autoFocus required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="What should be achieved?" /></label>
    <label>Brief<textarea maxLength={32000} value={description} onChange={e => setDescription(e.target.value)} placeholder="Context, expected behavior and constraints" /></label>
    <label>Acceptance criteria · one per line<textarea maxLength={32000} value={criteria} onChange={e => setCriteria(e.target.value)} placeholder="Observable outcomes that you can verify" /></label>
    <div className="task-inline"><label>Priority<select value={priority} onChange={e => setPriority(e.target.value as typeof priority)}><option value="">No priority</option>{(['low', 'medium', 'high', 'urgent'] as const).map(p => <option key={p} value={p}>{p}</option>)}</select></label><label>Due date<input type="date" value={due} onChange={e => setDue(e.target.value)} /></label></div>
    <label className="task-check"><input type="checkbox" checked={planFirst} onChange={e => setPlanFirst(e.target.checked)} />Approve a plan before implementation</label>
    <label className="task-check"><input type="checkbox" checked={autoReview} onChange={e => setAutoReview(e.target.checked)} />Request an independent review after implementation</label>
    {error && <p role="alert" className="task-error">{error}</p>}<button className="task-primary" disabled={busy}>{task ? 'Save brief' : 'Create task'}</button>
  </form>
}

async function issues(project: Project): Promise<GitHubIssueCardView[]> {
  const api = window.nodeTerminal.githubIssues
  const columns: Array<string | null> = [null, ...(project.kanban?.columns.map(c => c.id) ?? [])]
  const pages = await Promise.all(columns.map(async columnId => {
    const items: GitHubIssueCardView[] = []; let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const result = await api.query({ projectId: project.id, columnId, pageSize: 50, cursor })
      items.push(...result.items); cursor = result.nextCursor
      if (!cursor) return items
    }
    throw new Error('Too many GitHub issues. Narrow the board’s repository filters.')
  }))
  return [...new Map(pages.flat().filter(i => !i.pull).map(i => [i.number, i])).values()]
}
function TaskImport({ projects, sessions, create }: { projects: Project[]; sessions: KanbanSession[]; create(id: string, input: TaskCreate): Promise<void> }) {
  const [projectId, setProject] = useState(projects[0].id); const project = projects.find(p => p.id === projectId)!
  const [items, setItems] = useState<GitHubIssueCardView[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [mapStage, setMapStage] = useState(false)
  const run = async (input: TaskCreate) => { setBusy(true); try { await create(projectId, input) } catch (e) { setError(message(e)) } finally { setBusy(false) } }
  const local = projects.length === 1 && sessions.length ? sessions.filter(s => s.kind === 'terminal' && s.agentId).map(s => ({ id: s.id, title: s.title, issueRef: s.issueRef })) : project.nodes.filter(n => (!n.kind || n.kind === 'terminal') && n.agentId && !n.ssh && !n.sshRemoteTmux)
  return <div><p className="task-muted">Choose specific sessions or GitHub issues. Existing session history stays available.</p>
    {projects.length > 1 && <label>Project<select value={projectId} onChange={e => { setProject(e.target.value); setItems([]) }}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
    <label>Filter<input value={query} onChange={e => setQuery(e.target.value)} /></label>
    <h3>Existing agent sessions</h3><label className="task-check"><input type="checkbox" checked={mapStage} onChange={e => setMapStage(e.target.checked)} />Use the session column’s lifecycle category. Completed sessions wait for your acceptance.</label><div className="task-list">{local.filter(n => n.title.toLowerCase().includes(query.toLowerCase())).map(n => <button disabled={busy} key={n.id} onClick={() => {
      const category = mapStage ? columnCategory(project.kanban?.columns.find(c => c.id === project.kanban?.assignments.find(a => a.nodeId === n.id)?.columnId)) : undefined
      void run({ title: n.title, issueRef: n.issueRef, legacyNodeId: n.id, meta: project.kanban?.meta?.find(m => m.nodeId === n.id), stage: category === 'started' ? 'in_progress' : category === 'done' || category === 'closed' ? 'ready_for_acceptance' : 'todo' })
    }}>{n.title}<span>Create task →</span></button>)}</div>
    <h3>GitHub issues</h3><button disabled={busy} onClick={() => { setBusy(true); void window.nodeTerminal.githubIssues.refresh(projectId).then(() => issues(project)).then(setItems).catch(e => setError(message(e))).finally(() => setBusy(false)) }}>Load issues</button>
    <p className="task-muted">Uses this project’s configured repository and board mappings. Reimporting the same issue opens its existing task.</p>
    <div className="task-list">{items.filter(i => `${i.title} ${i.number}`.toLowerCase().includes(query.toLowerCase())).map(i => <button disabled={busy} key={i.number} onClick={() => void run({ title: i.title, description: i.body.slice(0, 32000), issueRef: issueRefFromHtmlUrl(i.htmlUrl, i.number) })}>#{i.number} {i.title}<span>Import →</span></button>)}</div>
    {error && <p role="alert" className="task-error">{error}</p>}
  </div>
}

function TaskDetail({ project, taskId, close, changed, onOpenNode, onOriginal }: { project: Project; taskId: string; close(): void; changed(): Promise<void>; onOpenNode(nodeId: string, projectId: string): void; onOriginal(nodeId: string): void }) {
  const api = window.nodeTerminal.tasks
  const [view, setView] = useState<TaskView>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState('summary'); const [editing, setEditing] = useState(false)
  const [agentId, setAgent] = useState('claude'); const [accountId, setAccount] = useState('')
  const [workspace, setWorkspace] = useState<'worktree' | 'current'>('worktree'); const [instructions, setInstructions] = useState('')
  const [comment, setComment] = useState(''); const [summary, setSummary] = useState(''); const [snapshot, setSnapshot] = useState<CodeSnapshot>()
  const [diff, setDiff] = useState<string>(); const [pulls, setPulls] = useState<GitHubPullBoard>()
  const [ack, setAck] = useState(false); const [issueMessage, setIssueMessage] = useState(''); const [attachNode, setAttachNode] = useState('')
  const settings = useSettings(s => s.settings)
  const load = useCallback(async () => { try { const next = value(await api.read(project.id, taskId)); setView(prev => prev && prev.task.revision > next.task.revision ? prev : next) } catch (e) { setError(message(e)) } }, [api, project.id, taskId])
  useEffect(() => { void load(); const off = api.onChanged(id => { if (id === project.id) void load() }); const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void load() }, 5000); return () => { off(); clearInterval(timer) } }, [api, load, project.id])
  useEffect(() => { void window.nodeTerminal.githubIssues.pullStatus(project.id).then(setPulls).catch(() => {}) }, [project.id])
  const task = view?.task; const run = task && latestTaskRun(task); const result = task && latestTaskResult(task)
  useEffect(() => setAck(false), [result?.id, view?.freshness, task?.criteriaRevision, view?.warnings.join('\0')])
  const live = useAgentStatus(s => s.byId[run?.nodeId ?? ''])
  const execute = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); await load(); await changed() } catch (e) { setError(message(e)) } finally { setBusy(false) } }
  const act = (action: TaskAction) => execute(async () => { value(await api.act(project.id, taskId, task!.revision, action)) })
  const start = (role: 'implementation' | 'review') => act({ type: 'start', requestId: uuid(), agentId, accountId: accountId || undefined, workspace, role, instructions })
  const open = (id: string) => { close(); onOpenNode(id, project.id) }
  const openUrl = (url: string) => { window.nodeTerminal.shell.openExternal(url) }
  if (!task || !view) return <p role="status">{error || 'Loading task…'}</p>
  const need = taskAttention(task, live, view)
  const running = !!run && (['starting', 'working', 'waiting', 'queued'].includes(run.state) || ['working', 'waiting', 'blocked'].includes(live?.state ?? ''))
  const linkedPulls = pulls?.pulls.filter(p => (!p.crossRepository && p.headRefName === task.checkout?.branch) || (task.issueRef && pulls.repository?.toLowerCase() === `${task.issueRef.owner}/${task.issueRef.repo}`.toLowerCase() && p.closes.includes(task.issueRef.number))) ?? []
  const refreshIssue = async (closeIssue = false) => {
    await window.nodeTerminal.githubIssues.refresh(project.id)
    const issue = (await issues(project)).find(i => issueKey(issueRefFromHtmlUrl(i.htmlUrl, i.number)) === issueKey(task.issueRef))
    if (!issue) throw new Error('Issue was not found in this project’s GitHub cache. Open it on GitHub or check the repository settings.')
    if (closeIssue) {
      const columnId = project.kanban?.github?.completionColumnId
      if (!columnId) throw new Error('Choose a completion column in GitHub board settings, or close the issue on GitHub.')
      const reply = await window.nodeTerminal.githubIssues.moveIssue({ projectId: project.id, issueNumber: issue.number, toColumnId: columnId, expectedUpdatedAt: issue.updatedAt, closeReason: 'completed' })
      if (reply.status !== 'confirmed') throw new Error(`GitHub could not close the issue (${reply.status}). The task remains accepted.`)
      setIssueMessage('Issue closed on GitHub.')
    } else {
      value(await api.act(project.id, task.id, task.revision, { type: 'edit', title: issue.title, description: issue.body.slice(0, 32000), criteria: task.criteria, planFirst: task.planFirst, autoReview: task.autoReview }))
      setIssueMessage('Brief refreshed from GitHub.')
    }
  }
  return <div className="task-detail">
    <div className="task-detail__status"><span>{TASK_STAGES.find(s => s.id === task.stage)?.label}</span>{run && <span>{run.role} · {run.state}</span>}{task.issueRef && <button onClick={() => openUrl(issueUrl(task.issueRef)!)}>#{task.issueRef.number} ↗</button>}</div>
    {need && <div className={`task-signal task-signal--${need.kind}`}><span>{need.label}</span>{need.kind === 'question' && run && <button onClick={() => open(run.nodeId)}>Open session to answer →</button>}</div>}
    {error && <p className="task-error" role="alert">{error}</p>}
    <nav className="task-detail__tabs" aria-label="Task details">{['summary', 'evidence', 'sessions'].map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t === 'summary' ? 'Summary' : t === 'evidence' ? 'Changes & checks' : 'Sessions & history'}</button>)}</nav>
    {tab === 'summary' && <>
      {editing ? <TaskForm projects={[project]} task={task} save={async (_id, input) => { value(await api.act(project.id, taskId, task.revision, { type: 'edit', title: input.title, description: input.description!, criteria: input.criteria!, planFirst: !!input.planFirst, autoReview: !!input.autoReview, meta: input.meta })); setEditing(false); await load(); await changed() }} /> : <>
        <p className="task-prose">{task.description || 'Add context and acceptance criteria before starting.'}</p>
        {task.meta && <p className="task-muted">{[task.meta.priority, task.meta.dueAt ? `Due ${new Date(task.meta.dueAt).toLocaleDateString()}` : '', task.meta.assignees?.map(a => a.name).join(', '), task.meta.labels?.map(id => project.kanban?.labels?.find(l => l.id === id)?.name ?? id).join(', ')].filter(Boolean).join(' · ')}</p>}
        {!!task.criteria.length && <section><h3>Acceptance criteria</h3><ul>{task.criteria.map(c => <li key={c.id}>{c.text}</li>)}</ul></section>}
        {task.stage !== 'done' && <button onClick={() => setEditing(true)}>Edit brief</button>}
      </>}
      {run?.plan && <section className="task-plan"><h3>{run.planApprovedAt ? 'Approved plan' : 'Plan awaiting approval'}</h3><p className="task-prose">{run.plan}</p>{!run.planApprovedAt && <button className="task-primary" disabled={busy || running} onClick={() => void act({ type: 'approve-plan', requestId: uuid() })}>Approve plan & implement</button>}</section>}
      {result && <section className="task-result"><h3>Implementation result</h3><p className="task-prose">{result.summary}</p><small className="task-muted">{result.author} · {new Date(result.at).toLocaleString()}</small></section>}
      {run?.role === 'review' && task.results.filter(r => r.runId === run.id).slice(-1).map(r => <section key={r.id} className="task-result"><h3>Review result</h3><p className="task-prose">{r.summary}</p>{r.report?.review.items.flatMap((v, i) => v.findings.map((f, j) => <p key={`${i}:${j}`}>{f.severity} · {f.summary}{f.file && ` (${f.file}${f.line ? `:${f.line}` : ''})`}</p>))}</section>)}
      {linkedPulls.map(p => <p key={p.number}>PR #{p.number} · {p.lifecycle}{p.ci && ` · CI ${p.ci}`}{p.merge && ` · ${p.merge}`}{pulls?.stale && ' · last known status'}</p>)}
      {task.stage !== 'done' && !task.archivedAt && <section className="task-run-controls"><h3>{run ? 'Continue work' : 'Start implementation'}</h3>
        <div className="task-inline"><label>Agent<select value={agentId} onChange={e => { setAgent(e.target.value); setAccount('') }}>{BUILTIN_AGENT_IDS.filter(id => !settings.disabledAgents?.includes(id)).map(id => <option key={id} value={id}>{AGENT_CONFIG[id].label}</option>)}{settings.customAgents.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
          {capabilityAgentId(agentId) === 'claude' && <label>Account<select value={accountId} onChange={e => setAccount(e.target.value)}><option value="">Project default</option>{settings.claudeAccounts.filter(a => !a.host && !a.pending).map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>}
          {!task.checkout && <label>Workspace<select value={workspace} onChange={e => setWorkspace(e.target.value as typeof workspace)}><option value="worktree">Separate worktree (Git)</option><option value="current">Current checkout</option></select></label>}
        </div>
        {task.checkout && <p className="task-muted">Checkout: <code>{task.checkout.cwd}</code>{task.checkout.branch && ` · ${task.checkout.branch}`}</p>}
        <label>{run ? 'Corrections / instructions for the next run' : 'Additional instructions (optional)'}<textarea value={instructions} maxLength={32000} onChange={e => setInstructions(e.target.value)} /></label>
        <div className="task-inline"><button className="task-primary" disabled={busy || running} onClick={() => void start('implementation')}>{run?.plan && !run.planApprovedAt ? 'Request revised plan' : run ? 'Start correction run' : task.planFirst ? 'Prepare plan' : 'Start task'}</button>
          {result && <button disabled={busy || running} onClick={() => void start('review')}>Request review</button>}{run && <button onClick={() => open(run.nodeId)}>Open current session</button>}</div>
        {running && <p className="task-muted">The current run must settle before another run or acceptance.</p>}
        {run?.state === 'queued' && <button disabled={busy} onClick={() => void act({ type: 'cancel-queued' })}>Cancel queued run</button>}
        {run?.state === 'unknown' && <label className="task-check"><input type="checkbox" disabled={busy} onChange={e => { if (e.target.checked) void act({ type: 'confirm-settled' }) }} />I inspected the session and confirmed its turn has ended.</label>}
      </section>}
      {task.stage !== 'done' && !task.archivedAt && <section className="task-accept"><h3>Accept result</h3><p className="task-muted">Accepts the selected result and code snapshot. GitHub and Git actions stay separate.</p>
        {!!view.warnings.length && <><ul>{view.warnings.map(w => <li key={w}>{w}</li>)}</ul><label className="task-check"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />I reviewed these gaps and accept responsibility for this result.</label></>}
        <button className="task-primary" disabled={busy || running || !!view.warnings.length && !ack} onClick={() => void act({ type: 'accept', resultId: result?.id, allowWarnings: ack })}>{view.warnings.length ? 'Accept despite gaps' : 'Accept result'}</button>
      </section>}
      {task.stage === 'done' && <section><p>Accepted {new Date(task.acceptances.at(-1)!.at).toLocaleString()}. {task.acceptances.at(-1)!.warnings.length ? 'Acceptance includes recorded gaps.' : ''}</p><button disabled={busy} onClick={() => void act({ type: 'reopen' })}>Reopen task</button>{task.issueRef && <button disabled={busy} onClick={() => void execute(() => refreshIssue(true))}>Close GitHub issue</button>}</section>}
      {task.issueRef && task.stage !== 'done' && <button disabled={busy} onClick={() => void execute(() => refreshIssue())}>Refresh brief from GitHub</button>}{issueMessage && <p role="status">{issueMessage}</p>}
      <button disabled={busy || running} onClick={() => void act({ type: 'archive', archived: !task.archivedAt })}>{task.archivedAt ? 'Restore task' : 'Archive task'}</button>
    </>}
    {tab === 'evidence' && <>
      <p className="task-muted">{view.freshness === 'current' ? 'Evidence matches the current code.' : view.reason || 'No current code verification.'}</p>
      <button disabled={busy} onClick={() => void execute(async () => { setDiff(value(await api.diff(project.id, taskId))) })}>Show current diff</button>
      {diff !== undefined && <><p className="task-muted">Live checkout compared with the task’s starting commit. Untracked files are listed separately.</p><pre className="task-diff">{diff || 'No tracked changes.'}</pre></>}
      {task.results.map(r => <details key={r.id} open={r.id === result?.id}><summary>{task.runs.find(run => run.id === r.runId)?.role} · {r.author} · {new Date(r.at).toLocaleString()}</summary><p className="task-prose">{r.summary}</p>{r.report ? <ReportView report={r.report} openUrl={openUrl} /> : <p className="task-muted">No structured verification evidence.</p>}</details>)}
      {run && task.stage !== 'done' && !task.archivedAt && <section><h3>Record your own verification</h3><label>Result summary<textarea value={summary} maxLength={32000} onChange={e => setSummary(e.target.value)} /></label>
        {!snapshot ? <div className="task-inline"><button disabled={busy} onClick={() => void execute(async () => setSnapshot(value(await api.capture(project.id, taskId, run.id))))}>Capture code before checks</button><button disabled={busy || !summary.trim()} onClick={() => void execute(async () => { value(await api.report(project.id, taskId, run.id, summary)); setSummary('') })}>Record summary without evidence</button></div> : <ReportEditor snapshot={snapshot} criteria={snapshot.acceptance} busy={busy} cancel={() => setSnapshot(undefined)} submit={async evidence => { await execute(async () => { value(await api.report(project.id, taskId, run.id, summary, evidence)); setSnapshot(undefined); setSummary('') }) }} />}
      </section>}
    </>}
    {tab === 'sessions' && <>
      <h3>Agent runs</h3>{!task.runs.length && <p className="task-muted">No agent runs yet.</p>}{[...task.runs].reverse().map(r => <div className="task-history-row" key={r.id}><span><strong>{r.role} · {r.agentId}</strong><small>{r.state} · {new Date(r.createdAt).toLocaleString()}</small>{r.error && <p>{r.error}</p>}</span><button onClick={() => open(r.nodeId)}>Open session →</button></div>)}
      {task.legacyNodeIds.map(id => <p key={id}><button onClick={() => { close(); onOriginal(id) }}>Original session · {id}</button><span className="task-muted"> · original comments and readiness history</span></p>)}
      {task.stage !== 'done' && <div className="task-inline"><label>Attach an existing session<select value={attachNode} onChange={e => setAttachNode(e.target.value)}><option value="">Choose session</option>{project.nodes.filter(n => n.agentId && !n.ssh && !n.sshRemoteTmux).map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select></label><button disabled={busy || !attachNode || running} onClick={() => void act({ type: 'attach', nodeId: attachNode })}>Attach without sending instructions</button></div>}
      <h3>Activity & decisions</h3>{[...task.events].reverse().map(e => <div className="task-history-row" key={e.id}><span><p className="task-prose">{e.text}</p><small>{e.author} · {new Date(e.at).toLocaleString()}</small></span></div>)}
      {task.acceptances.map(a => <details key={a.id}><summary>Acceptance · {new Date(a.at).toLocaleString()}</summary><p>Result {a.resultId || 'without a report'} · snapshot {a.snapshot?.fingerprint || 'unverified'}</p><ul>{a.warnings.map(w => <li key={w}>{w}</li>)}</ul></details>)}
      <label>Add a comment<textarea value={comment} maxLength={32000} onChange={e => setComment(e.target.value)} /></label><button disabled={busy || !comment.trim()} onClick={() => void act({ type: 'comment', text: comment }).then(() => setComment(''))}>Add comment</button>
    </>}
  </div>
}
