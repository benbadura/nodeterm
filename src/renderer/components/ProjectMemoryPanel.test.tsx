// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyCheckpoint, emptyDecision, emptyMemoryProject, type MemoryView, type ProjectMemoryApi } from '@shared/project-memory'
import { ProjectMemoryDialog, ProjectMemoryPanel } from './ProjectMemoryPanel'
import { useProjectMemoryPanel } from '../state/projectMemory'
import { resetDialogStack } from './dialog-stack'

const fake = vi.hoisted(() => ({ api: {} as { projectMemory: ProjectMemoryApi; shell: { openExternal: ReturnType<typeof vi.fn> } } }))
vi.mock('../session/session', () => ({ sessionForProject: () => ({ api: fake.api, source: 'local' }) }))
vi.mock('../state/settings', () => ({ useSettings: (select: (s: unknown) => unknown) => select({ settings: { disabledAgents: [], customAgents: [] } }) }))
vi.mock('../state/modelGateway', () => ({ useModelGateway: (select: (s: unknown) => unknown) => select({ models: [] }) }))
vi.mock('../state/projects', () => ({ useProjects: { getState: () => ({ projects: [{ id: 'p', nodes: [{ id: 'original', title: 'Original discussion' }] }] }) } }))
vi.mock('./ContextMenu', () => ({ ContextMenu: () => null }))

let root: Root
let host: HTMLDivElement
let view: MemoryView
let changed: ((id: string) => void) | undefined
const proposal = { ...emptyDecision(), id: 'd', status: 'proposed' as const, title: 'Portable memory', decision: 'Use project files', rationale: 'Travel with the checkout', author: 'codex', at: 1000, sources: [{ kind: 'session' as const, location: 'original', label: 'Discussion', excerpt: 'Keep context portable.' }] }
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label)!
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  resetDialogStack()
  useProjectMemoryPanel.setState({ opened: undefined, handoff: undefined, source: undefined })
  view = { project: { ...emptyMemoryProject(), revision: 3, decisions: [proposal] }, tasks: [] }
  fake.api = { shell: { openExternal: vi.fn() }, projectMemory: {
    read: vi.fn(async () => ({ ok: true as const, value: view })),
    propose: vi.fn(async () => ({ ok: false as const, error: 'Memory changed. Reload before saving or approving.' })),
    checkpoint: vi.fn(async () => ({ ok: true as const, value: view })),
    review: vi.fn(async () => ({ ok: true as const, value: view })),
    packet: vi.fn(async () => ({ ok: true as const, value: { body: 'Approved context', taskId: 'task' } })),
    bind: vi.fn(async () => ({ ok: true as const, value: undefined })),
    prepare: vi.fn(async () => ({ ok: true as const, value: { body: '' } })),
    source: vi.fn(async () => ({ ok: false as const, error: 'Original file unavailable.' })),
    onChanged: vi.fn((cb) => { changed = cb; return () => { changed = undefined } })
  } }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); resetDialogStack(); vi.unstubAllGlobals() })
const render = async () => { await act(async () => root.render(<ProjectMemoryPanel projectId="p" nodeId="node" />)) }

describe('project memory UI', () => {
  it('shows proposed status and submits explicit approval with the current revision', async () => {
    await render()
    expect(host.textContent).toContain('1 proposals')
    expect(host.textContent).toContain('project · proposed')
    expect(fake.api.projectMemory.review).not.toHaveBeenCalled()
    await act(async () => button('Approve').click())
    expect(fake.api.projectMemory.review).toHaveBeenCalledWith('p', { nodeId: 'node' }, 'project', 'd', 'approve', 3)
  })
  it('retains the draft and captured revision when another agent changes memory', async () => {
    await render()
    await act(async () => button('Propose revision').click())
    view = { ...view, project: { ...view.project, revision: 4 } }
    await act(async () => changed?.('p'))
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(fake.api.projectMemory.propose).toHaveBeenCalledWith('p', { nodeId: 'node' }, expect.objectContaining({ title: 'Portable memory', replaces: 'd' }), 3)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Reload')
    expect(host.querySelector('form')).not.toBeNull()
  })
  it('opens the original session and keeps the saved excerpt visible', async () => {
    await render()
    await act(async () => button('Open source').click())
    expect(host.textContent).toContain('Original discussion')
    expect(host.textContent).toContain('Keep context portable.')
    await act(async () => button('Open original session').click())
    expect(useProjectMemoryPanel.getState().source).toEqual({ projectId: 'p', nodeId: 'original' })
  })
  it('saves a versioned checkpoint and displays the startup packet', async () => {
    view.task = { version: 1, id: 'task', title: 'Feature', revision: 2, decisions: [], checkpoints: [{ ...emptyCheckpoint(), id: 'c', at: 1000, author: 'codex', goal: 'Ship memory', nextStep: 'Review UI' }] }
    await render()
    await act(async () => button('Update task state').click())
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(fake.api.projectMemory.checkpoint).toHaveBeenCalledWith('p', { nodeId: 'node' }, expect.objectContaining({ goal: 'Ship memory', nextStep: 'Review UI' }), 2)
    await act(async () => button('Preview startup packet').click())
    expect(host.textContent).toContain('Approved context')
  })
  it('closes the modal with Escape and restores focus', async () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus()
    await act(async () => { useProjectMemoryPanel.getState().open('p'); root.render(<ProjectMemoryDialog />) })
    expect(document.activeElement?.getAttribute('role')).toBe('dialog')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(useProjectMemoryPanel.getState().opened).toBeUndefined()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
