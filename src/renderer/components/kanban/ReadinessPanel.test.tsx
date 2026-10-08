// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadinessApi, ReadinessReport, ReadinessView } from '@shared/task-readiness'
import { ReadinessPanel } from './ReadinessPanel'
import { CardModal } from './CardModal'
import { useTaskReadiness } from '../../state/taskReadiness'
import { resetDialogStack } from '../dialog-stack'
import type { ProjectKanban } from '@shared/types'

const fake = vi.hoisted(() => ({ api: {} as { readiness: ReadinessApi; shell: { openExternal: ReturnType<typeof vi.fn> }; pty: {} }, mounts: 0, unmounts: 0 }))
vi.mock('../../session/session', () => ({ useSession: () => ({ api: fake.api }), sessionForProject: () => ({ source: 'local' }) }))
vi.mock('./ModalTerminal', () => ({ ModalTerminal: ({ covered }: { covered: boolean }) => {
  useEffect(() => { fake.mounts++; return () => { fake.unmounts++ } }, [])
  return <div data-terminal="mounted" data-covered={covered} />
} }))
vi.mock('../../nodes/TerminalNode', () => ({ nodeUploadScope: () => 'p', wakeHibernatedNode: vi.fn() }))
vi.mock('./BoardLogPanel', () => ({ BoardLogPanel: () => null }))
vi.mock('./CardMetaBar', () => ({ CardMetaBar: () => null }))
vi.mock('./CardPullRequests', () => ({ CardPullRequests: () => null }))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))
vi.mock('../PortsChip', () => ({ PortsChip: () => null }))

let host: HTMLDivElement
let root: Root
let view: ReadinessView
let changed: ((projectId: string, nodeId: string) => void) | undefined
const snapshot = { id: 's1', at: 100, head: 'a'.repeat(40), fingerprint: 'b'.repeat(64), checkout: '/repo', baseCommit: 'c'.repeat(40), files: ['src/app.ts'], criteriaRevision: 1, acceptance: [{ id: 'c1', text: 'Expected behavior' }] }
const savedReport: ReadinessReport = { id: 'r1', at: 200, author: 'codex', source: 'agent', snapshot, acceptance: [{ id: 'c1', text: 'Expected behavior' }], criteria: [{ id: 'c1', status: 'met', note: 'Checked' }], tests: { status: 'recorded', items: [{ command: 'npm test', status: 'passed', summary: '12 tests passed', exitCode: 0 }] }, review: { status: 'recorded', items: [{ summary: 'No issues found', outcome: 'passed', findings: [] }] }, preview: { status: 'recorded', items: [{ label: 'Open preview', url: 'http://localhost:3000/' }] } }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fake.mounts = 0; fake.unmounts = 0
  resetDialogStack()
  changed = undefined
  view = { criteria: savedReport.acceptance, criteriaRevision: 1, baseCommit: snapshot.baseCommit, reports: [], total: 0, freshness: 'none' }
  fake.api = {
    pty: {}, shell: { openExternal: vi.fn() },
    readiness: {
      read: vi.fn(async () => ({ ok: true as const, value: view })),
      check: vi.fn(async () => ({ ok: true as const, value: view })),
      criteria: vi.fn(async () => ({ ok: true as const, value: undefined })),
      capture: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      report: vi.fn(async () => ({ ok: true as const, value: undefined })),
      onChanged: vi.fn((cb) => { changed = cb; return () => { changed = undefined } })
    }
  }
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { onMarkdownToggle: () => () => {} }
  useTaskReadiness.setState({ byKey: {}, requestedNode: null })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; resetDialogStack(); vi.unstubAllGlobals() })
async function render(): Promise<void> { await act(async () => root.render(<ReadinessPanel projectId="p" nodeId="n" />)) }
const button = (label: string): HTMLButtonElement => [...document.querySelectorAll('button')].find((b) => b.textContent === label)!

describe('task readiness panel', () => {
  it('shows absence, current evidence, preview and code-change invalidation', async () => {
    await render()
    expect(host.textContent).toContain('No report yet')
    expect(host.textContent).toContain('No results recorded yet')
    view = { ...view, reports: [savedReport], total: 1, freshness: 'current' }
    await act(async () => changed?.('p', 'n'))
    expect(host.textContent).toContain('Agent report')
    expect(host.textContent).toContain('12 tests passed')
    expect(host.textContent).toContain('src/app.ts')
    await act(async () => host.querySelector('a')!.click())
    expect(fake.api.shell.openExternal).toHaveBeenCalledWith('http://localhost:3000/')
    view = { ...view, freshness: 'stale', reason: 'Code changed' }
    await act(async () => changed?.('p', 'n'))
    expect(host.textContent).toContain('Needs refresh')
    expect(host.textContent).toContain('Code changed')
    expect(fake.api.readiness.report).not.toHaveBeenCalled()
  })

  it('captures before manual evidence and does not copy an earlier passing result', async () => {
    view = { ...view, reports: [savedReport], total: 1, freshness: 'current' }
    await render()
    await act(async () => button('Capture code and start a new report').click())
    expect(fake.api.readiness.capture).toHaveBeenCalledWith('p', 'n')
    expect(host.textContent).toContain('New user report')
    const form = host.querySelector('form')!
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(fake.api.readiness.report).toHaveBeenCalledWith('p', 'n', expect.objectContaining({ snapshotId: 's1', criteria: [{ id: 'c1', status: 'unknown', note: '' }], tests: { status: 'missing', items: [] } }))
  })

  it('keeps the captured checklist stable while someone edits requirements', async () => {
    await render()
    await act(async () => button('Capture code and start a new report').click())
    view = { ...view, criteria: [{ id: 'c2', text: 'New requirement' }, { id: 'c3', text: 'Another requirement' }], criteriaRevision: 2 }
    await act(async () => changed?.('p', 'n'))
    const form = host.querySelector('form')!
    expect(form.textContent).toContain('Expected behavior')
    expect(form.textContent).not.toContain('New requirement')
  })

  it('uses the requirements returned by capture when the displayed checklist is outdated', async () => {
    await render()
    fake.api.readiness.capture = vi.fn(async () => ({ ok: true as const, value: { ...snapshot, criteriaRevision: 2, acceptance: [{ id: 'c2', text: 'Updated before capture' }] } }))
    await act(async () => button('Capture code and start a new report').click())
    expect(host.querySelector('form')!.textContent).toContain('Updated before capture')
    expect(host.querySelector('form')!.textContent).not.toContain('Expected behavior')
  })

  it('shows history and explicit missing or not-applicable evidence', async () => {
    const older = { ...savedReport, id: 'older', tests: { status: 'not-applicable' as const, reason: 'Docs only', items: [] }, preview: { status: 'missing' as const, items: [] } }
    view = { ...view, reports: [savedReport, older], total: 2, freshness: 'current' }
    await render()
    expect(host.textContent).toContain('Previous reports (1)')
    expect(host.textContent).toContain('Not applicable — Docs only')
    expect(host.textContent).toContain('Missing evidence')
  })

  it('surfaces read failures without retaining a current badge', async () => {
    fake.api.readiness.check = vi.fn(async () => ({ ok: false as const, error: 'Unreadable repository' }))
    await render()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Unreadable repository')
    expect(host.textContent).not.toContain('Current code')
  })
})

describe('readiness tab terminal continuity', () => {
  const board: ProjectKanban = { columns: [], assignments: [] }
  async function modal(): Promise<void> {
    await act(async () => root.render(<CardModal session={{ id: 'n', title: 'Task', kind: 'terminal', color: '#fff', spawn: {} }} projectId="p" board={board} columnTitle={null} onChangeBoard={vi.fn()} onClose={vi.fn()} onOpenCanvas={vi.fn()} onRename={vi.fn()} onEditSticky={vi.fn()} onBrowserNav={vi.fn()} onSetIcon={vi.fn()} />))
  }
  it('switches to readiness and back without detaching the mounted terminal', async () => {
    await modal()
    const terminal = document.querySelector('[data-terminal]')
    expect(fake.mounts).toBe(1)
    await act(async () => button('Readiness').click())
    expect(document.body.textContent).toContain('Task readiness')
    expect(document.querySelector('[data-terminal]')).toBe(terminal)
    expect(terminal?.getAttribute('data-covered')).toBe('true')
    await act(async () => button('Capture code and start a new report').click())
    const draft = document.querySelector('form')
    await act(async () => button('Session').click())
    expect(document.querySelector('[data-terminal]')).toBe(terminal)
    expect(fake.unmounts).toBe(0)
    expect(fake.mounts).toBe(1)
    await act(async () => button('Readiness').click())
    expect(document.querySelector('form')).toBe(draft)
  })
  it('opens readiness directly when requested by a chip', async () => {
    useTaskReadiness.getState().request('n')
    await modal()
    expect(button('Readiness').getAttribute('aria-selected')).toBe('true')
    expect(document.body.textContent).toContain('Task readiness')
    expect(useTaskReadiness.getState().requestedNode).toBeNull()
  })
})
