// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TaskBoard } from './TaskBoard'
import { DEFAULT_SETTINGS, type Project } from '@shared/types'
import { unavailableTasks, taskAttention, type TaskRecord, type TaskApi } from '@shared/tasks'
import { useSettings } from '../../state/settings'
import { useAgentStatus } from '../../state/agentStatus'
import { runBoardKey } from '../../lib/boardKeys'
import { resetDialogStack } from '../dialog-stack'

vi.mock('./KanbanScopeSwitch', () => ({ KanbanScopeSwitch: () => null }))
vi.mock('./ReadinessPanel', () => ({ ReportView: () => <p>Frozen verification evidence</p>, ReportEditor: () => <p>Verification editor</p> }))
let root: Root, host: HTMLDivElement, api: TaskApi, tasks: TaskRecord[], listener: (id: string) => void
const project: Project = { id: 'p', name: 'Project', cwd: '/local/project', nodes: [], color: '#fff', viewport: { x: 0, y: 0, zoom: 1 } }
const task = (id: string, stage: TaskRecord['stage'] = 'todo'): TaskRecord => ({ version: 1, id, revision: 1, title: `Task ${id}`, description: 'An observable outcome', criteria: [{ id: 'c1', text: 'Works' }], criteriaRevision: 0, stage, rank: id, createdAt: 1, updatedAt: 1, planFirst: false, autoReview: false, legacyNodeIds: [], runs: [], captures: [], results: [], acceptances: [], events: [] })
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!
const click = async (element: HTMLElement) => { await act(async () => { element.click() }) }
const input = async (element: HTMLInputElement | HTMLTextAreaElement, text: string) => { await act(async () => {
  const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, text)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}) }
async function mount() { await act(async () => root.render(<TaskBoard projects={[project]} sessions={[]} global={false} onLegacy={vi.fn()} onOpenNode={vi.fn()} />)) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); tasks = [task('a'), task('b', 'in_progress')]; listener = () => {}
  api = { ...unavailableTasks, list: vi.fn(async () => ({ ok: true as const, value: tasks })), read: vi.fn(async (_p, id) => ({ ok: true as const, value: { task: tasks.find(t => t.id === id)!, freshness: 'none' as const, warnings: ['No verification evidence recorded.'] } })),
    create: vi.fn(async (_id, input) => { const t = { ...task('created'), ...input }; tasks.push(t); return { ok: true as const, value: t } }),
    act: vi.fn(async (_p, id, _rev, action) => ({ ok: true as const, value: tasks.find(t => t.id === id)! })), onChanged: cb => { listener = cb; return () => {} } }
  Object.assign(window, { nodeTerminal: { tasks: api, settings: { save: async () => {} }, githubIssues: { pullStatus: async () => ({ pulls: [], stale: false }) }, shell: { openExternal: vi.fn() } } })
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } }); useAgentStatus.setState({ byId: {} }); resetDialogStack()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); resetDialogStack(); vi.unstubAllGlobals() })

it('creates a task brief with criteria and optional planning, then opens its summary', async () => {
  await mount(); await click(button('+ New task'))
  const form = host.querySelector('form')!
  await input(form.querySelector('input')!, 'Improve search')
  const areas = form.querySelectorAll('textarea'); await input(areas[0], 'Users can find records quickly.'); await input(areas[1], 'Enter finds a record\nEscape clears the query')
  await click(form.querySelector('input[type="checkbox"]')!)
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(api.create).toHaveBeenCalledWith('p', expect.objectContaining({ title: 'Improve search', planFirst: true, autoReview: false, criteria: [expect.objectContaining({ text: 'Enter finds a record' }), expect.objectContaining({ text: 'Escape clears the query' })] }))
  expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Improve search')
  expect(button('Summary').getAttribute('aria-pressed')).toBe('true')
})
it('requires a conscious acceptance despite gaps and sends the exact result id and revision', async () => {
  tasks[0].stage = 'ready_for_acceptance'
  tasks[0].runs = [{ id: 'run', nodeId: 'node', hostId: 'host', role: 'implementation', agentId: 'claude', state: 'reported', createdAt: 1, updatedAt: 1 }]
  tasks[0].results = [{ id: 'result', runId: 'run', at: 1, author: 'claude', summary: 'Changes ready', criteriaRevision: 0 }]
  await mount(); await click(host.querySelector<HTMLButtonElement>('[data-task-card="a"]')!)
  const accept = button('Accept despite gaps'); expect(accept.disabled).toBe(true)
  await click(host.querySelector('.task-accept input')!); expect(accept.disabled).toBe(false)
  await click(accept)
  expect(api.act).toHaveBeenCalledWith('p', 'a', 1, { type: 'accept', resultId: 'result', allowWarnings: true })
})
it('shows one attention row per task with questions before errors, plans and results', async () => {
  tasks[0].runs = [{ id: 'run', nodeId: 'node', hostId: 'host', role: 'implementation', agentId: 'claude', state: 'waiting', plan: 'A plan', error: 'An error', createdAt: 1, updatedAt: 1 }]
  tasks[0].stage = 'ready_for_acceptance'
  expect(taskAttention(tasks[0])?.kind).toBe('question')
  await mount(); await click([...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.startsWith('Needs attention'))!)
  expect(host.querySelectorAll('.task-list > button')).toHaveLength(1)
  expect(host.querySelector('.task-list')?.textContent).toContain('An agent needs your answer')
  await click(host.querySelector('.task-list > button')!)
  expect(button('Open session to answer →')).toBeDefined()
  expect(button('Accept despite gaps').disabled).toBe(true)
})
it('supports board keyboard navigation and Escape closes only the inspector', async () => {
  await mount()
  act(() => expect(runBoardKey('next')).toBe(true))
  expect((document.activeElement as HTMLElement).dataset.taskCard).toBe('a')
  await act(async () => expect(runBoardKey('open')).toBe(true))
  expect(host.querySelector('[role="dialog"]')).not.toBeNull()
  act(() => expect(runBoardKey('next')).toBe(false))
  act(() => host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(host.querySelector('[data-task-card="a"]'))
})
it('reports conflicts and keeps the inspector open for reloading', async () => {
  api.act = vi.fn(async () => ({ ok: false as const, error: 'This task changed. Reload before applying your action.', conflict: tasks[0] }))
  await mount(); await click(host.querySelector<HTMLButtonElement>('[data-task-card="a"]')!)
  await click(button('Start task'))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('This task changed')
  expect(host.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => listener('p'))
  expect(api.read).toHaveBeenCalled()
})
