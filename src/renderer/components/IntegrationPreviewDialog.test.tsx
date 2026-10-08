// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IntegrationPreviewDialog } from './IntegrationPreviewDialog'
import { resetDialogStack } from './dialog-stack'
import type { IntegrationPreviewApi, PreviewReport } from '@shared/integration-preview'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLElement | undefined
afterEach(() => { act(() => root?.unmount()); host?.remove(); resetDialogStack() })

function mockApi() {
  let listener: ((report: PreviewReport) => void) | undefined
  const unsubscribe = vi.fn()
  const api: IntegrationPreviewApi = {
    inspect: vi.fn(async (_id, base) => ({
      available: true, defaultBaseRef: base ?? 'main', branches: ['main', 'one', 'two', 'three'],
      suggestions: [{ label: 'Node.js · npm', source: 'package.json', setupCommand: 'npm ci', testCommand: 'npm run test' }]
    })),
    start: vi.fn(async () => ({ ok: true, runId: 'run' })),
    get: vi.fn(async () => null), listReports: vi.fn(async () => []),
    cancel: vi.fn(async () => true), retryCleanup: vi.fn(async () => true),
    onEvent: (_id, cb) => { listener = cb; return unsubscribe }
  }
  return { api, emit: (r: PreviewReport) => listener?.(r), unsubscribe }
}
async function mount(api: IntegrationPreviewApi, onClose = vi.fn()) {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root!.render(<IntegrationPreviewDialog projectId="project" api={api} onClose={onClose} />))
}
function select(label: string, value: string) {
  const element = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!
  act(() => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })) })
}
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)! }
function report(patch: Partial<PreviewReport> = {}): PreviewReport {
  return {
    runId: 'run', projectId: 'project', seq: 1, phase: 'testing', startedAt: '2026-10-08T12:00:00Z',
    options: { baseRef: 'main', branches: ['one', 'two'], setupCommand: '', testCommand: 'npm run test', timeoutMinutes: 10 },
    branches: [{ name: 'one', sha: 'a'.repeat(40) }, { name: 'two', sha: 'b'.repeat(40) }],
    mergedBranches: ['one', 'two'], conflicts: [], cleanup: 'pending', logs: { git: '', setup: '', tests: '' }, ...patch
  }
}

describe('IntegrationPreviewDialog', () => {
  it('requires two branches, preserves their order and submits the reviewed commands', async () => {
    const { api } = mockApi()
    await mount(api)
    expect(button('Run preview').disabled).toBe(true)
    select('Add branch', 'one'); select('Add branch', 'two')
    expect(button('Run preview').disabled).toBe(false)
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Move two up"]')!.click())
    await act(async () => button('Run preview').click())
    expect(api.start).toHaveBeenCalledWith('project', expect.objectContaining({
      baseRef: 'main', branches: ['two', 'one'], setupCommand: 'npm ci', testCommand: 'npm run test', timeoutMinutes: 10
    }))
  })

  it('recovers progress, ignores stale snapshots and shows conflicts with pending branches', async () => {
    const mock = mockApi()
    await mount(mock.api)
    act(() => mock.emit(report()))
    expect(button('Cancel run')).toBeDefined()
    await act(async () => button('Cancel run').click())
    expect(mock.api.cancel).toHaveBeenCalledWith('project', 'run')
    act(() => mock.emit(report({ seq: 3, phase: 'finished', outcome: 'conflict', conflicts: ['shared.txt'], mergedBranches: ['one'], currentBranch: 'two', cleanup: 'done' })))
    act(() => mock.emit(report({ seq: 2 })))
    expect(document.querySelector('[role="status"]')!.textContent).toBe('Merge conflict')
    expect(document.body.textContent).toContain('shared.txt')
    expect([...document.querySelectorAll('.integration-preview__progress .reached')].map((e) => e.textContent)).not.toContain('Test')
    expect(button('Run again')).toBeDefined()
    act(() => root!.unmount()); root = undefined
    expect(mock.unsubscribe).toHaveBeenCalled()
    mock.api.listReports = vi.fn(async () => [report({ seq: 4, phase: 'finished', outcome: 'passed', cleanup: 'done' })])
    await mount(mock.api)
    expect(document.querySelector('[role="status"]')!.textContent).toBe('Tests passed')
  })

  it('keeps custom commands when changing the base and drops that base from selected branches', async () => {
    const mock = mockApi()
    await mount(mock.api)
    select('Add branch', 'one'); select('Add branch', 'two')
    const input = document.querySelector<HTMLTextAreaElement>('[aria-label="Test command"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'custom-tests')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => select('Base branch', 'one'))
    expect(input.value).toBe('custom-tests')
    expect(document.querySelectorAll('.integration-preview__branches li')).toHaveLength(1)
  })

  it('closes the dialog without cancelling the run, and explains unsupported environments', async () => {
    const mock = mockApi()
    const close = vi.fn()
    await mount(mock.api, close)
    act(() => mock.emit(report()))
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(close).toHaveBeenCalledOnce()
    expect(mock.api.cancel).not.toHaveBeenCalled()
    act(() => root!.unmount()); root = undefined
    mock.api.inspect = vi.fn(async () => ({ available: false, reason: 'Local Desktop only', branches: [], defaultBaseRef: '', suggestions: [] }))
    await mount(mock.api)
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('Local Desktop only')
    expect(button('Run preview')).toBeUndefined()
  })
})
