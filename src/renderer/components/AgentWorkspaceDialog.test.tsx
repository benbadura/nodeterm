// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDialogStack } from './dialog-stack'
import { WorktreeDialog } from './WorktreeDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('agent workspace dialog', () => {
  let root: Root
  let host: HTMLElement
  let props: ComponentProps<typeof WorktreeDialog>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    props = {
      intent: 'create', repoPath: '/repo', existing: [], defaultBaseRef: 'main', branches: [],
      defaultPath: (_repo, branch) => `/repo.wt/${branch.replaceAll('/', '-')}`,
      busy: false, error: null, onCreate: vi.fn(), onBindExisting: vi.fn(), onCancel: vi.fn(),
      agent: {
        label: 'Codex', accountLabel: 'Work account', currentCwd: '/repo.wt/existing',
        initialMode: 'current', worktreeUnavailable: null, onCurrent: vi.fn()
      }
    }
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    resetDialogStack()
  })
  const render = () => act(() => root.render(<WorktreeDialog {...props} />))
  const submit = () => act(() => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  const field = (label: string) => [...document.querySelectorAll<HTMLLabelElement>('.bind-field')]
    .find((element) => element.textContent?.trim() === label)!.querySelector<HTMLInputElement>('input')!
  const type = (input: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  it('starts in the displayed current directory without requiring git fields', () => {
    props.repoPath = ''
    render()
    expect(document.body.textContent).toContain('/repo.wt/existing')
    expect(document.body.textContent).toContain('Work account')
    expect(document.querySelector('.bind-field')).toBeNull()
    submit()
    expect(props.agent!.onCurrent).toHaveBeenCalledOnce()
    expect(props.onCreate).not.toHaveBeenCalled()
  })

  it('requires a finished branch name and submits a new worktree with the selected base', () => {
    props.agent!.initialMode = 'new-worktree'
    render()
    expect(document.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true)
    submit()
    expect(props.onCreate).not.toHaveBeenCalled()
    type(field('Branch'), 'feature/login')
    type(field('Base'), 'origin/main')
    submit()
    expect(props.onCreate).toHaveBeenCalledWith({
      repoPath: '/repo', mode: 'new', branch: 'feature/login', baseRef: 'origin/main', path: '/repo.wt/feature-login'
    })
    expect(props.agent!.onCurrent).not.toHaveBeenCalled()
  })

  it('preserves the edited path while changing branch and workspace mode', () => {
    props.agent!.initialMode = 'new-worktree'
    render()
    type(field('Worktree path'), '/custom/task')
    type(field('Branch'), 'feature/login')
    const radios = document.querySelectorAll<HTMLInputElement>('[name="agent-workspace"]')
    act(() => radios[0].click())
    act(() => radios[1].click())
    expect(field('Worktree path').value).toBe('/custom/task')
    submit()
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ path: '/custom/task' }))
  })

  it.each(['Not supported in SSH projects yet', 'No git repository was found'])('disables worktree with a reason: %s', (reason) => {
    props.agent!.initialMode = 'new-worktree'
    props.agent!.worktreeUnavailable = reason
    render()
    expect(document.querySelectorAll<HTMLInputElement>('[name="agent-workspace"]')[1].disabled).toBe(true)
    expect(document.body.textContent).toContain(reason)
    submit()
    expect(props.agent!.onCurrent).toHaveBeenCalledOnce()
    expect(props.onCreate).not.toHaveBeenCalled()
  })

  it('blocks submission, Escape and backdrop cancellation while creation is running', () => {
    props.busy = true
    render()
    submit()
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    act(() => document.querySelector<HTMLElement>('.confirm-overlay')!.click())
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(props.agent!.onCurrent).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true)
  })

  it('restores the remembered worktree choice when the repository finishes loading', () => {
    props.agent!.initialMode = 'new-worktree'
    props.agent!.worktreeUnavailable = 'No git repository was found'
    props.repoPath = ''
    render()
    expect(document.querySelectorAll<HTMLInputElement>('[name="agent-workspace"]')[0].checked).toBe(true)
    props.agent!.worktreeUnavailable = null
    props.repoPath = '/repo'
    render()
    expect(document.querySelectorAll<HTMLInputElement>('[name="agent-workspace"]')[1].checked).toBe(true)
    type(field('Branch'), 'feature/login')
    submit()
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ repoPath: '/repo', path: '/repo.wt/feature-login' }))
    expect(props.agent!.onCurrent).not.toHaveBeenCalled()
  })

  it('keeps entered branch and path when a git error is displayed', () => {
    props.agent!.initialMode = 'new-worktree'
    render()
    type(field('Branch'), 'feature/login')
    props.error = 'The branch already exists'
    render()
    expect(document.body.textContent).toContain(props.error)
    expect(field('Branch').value).toBe('feature/login')
    act(() => document.querySelector<HTMLButtonElement>('.confirm__btn')!.click())
    expect(props.onCancel).toHaveBeenCalledOnce()
    expect(props.onCreate).not.toHaveBeenCalled()
  })
})
