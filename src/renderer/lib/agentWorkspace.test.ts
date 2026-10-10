import { describe, expect, it, vi } from 'vitest'
import { createAgentWorktree } from './agentWorkspace'

const value = { repoPath: '/repo', mode: 'new' as const, branch: 'feature/task', baseRef: 'main', path: '/repo.wt/task' }
const options = { projectId: 'p', target: () => ({ groupId: null }) }

function deps() {
  return {
    worktreeAdd: vi.fn(async () => ({ ok: true, message: '' })),
    activeProjectId: () => 'p',
    isCurrent: vi.fn(() => true),
    attach: vi.fn(() => 'group'),
    openAgent: vi.fn(() => true)
  }
}

describe('manual agent creation in a worktree', () => {
  it('opens the agent in the bound group before attach yields', async () => {
    const d = deps()
    const order: string[] = []
    d.attach.mockImplementation(() => {
      order.push('attach')
      queueMicrotask(() => order.push('render'))
      return 'group'
    })
    d.openAgent.mockImplementation(() => { order.push('agent'); return true })
    expect(await createAgentWorktree(d, value, options)).toMatchObject({ ok: true, agentCreated: true })
    expect(order).toEqual(['attach', 'agent', 'render'])
    expect(d.openAgent).toHaveBeenCalledWith('group')
  })

  it('creates no group or agent when git rejects the branch or path', async () => {
    const d = deps()
    d.worktreeAdd.mockResolvedValue({ ok: false, message: 'branch already exists' })
    expect(await createAgentWorktree(d, value, options)).toMatchObject({ ok: false, reason: 'git' })
    expect(d.attach).not.toHaveBeenCalled()
    expect(d.openAgent).not.toHaveBeenCalled()
  })

  it('does not launch early, or bind a dismissed request after a switch away and back', async () => {
    const d = deps()
    let complete!: (value: { ok: boolean; message: string }) => void
    d.worktreeAdd.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    const pending = createAgentWorktree(d, value, options)
    expect(d.openAgent).not.toHaveBeenCalled()
    d.isCurrent.mockReturnValue(false)
    complete({ ok: true, message: '' })
    expect(await pending).toMatchObject({ ok: false, reason: 'project-changed', worktree: { path: value.path } })
    expect(d.attach).not.toHaveBeenCalled()
    expect(d.openAgent).not.toHaveBeenCalled()
  })

  it('retains the worktree binding when the account gate refuses the agent', async () => {
    const d = deps()
    d.openAgent.mockReturnValue(false)
    expect(await createAgentWorktree(d, value, options)).toMatchObject({ ok: true, groupId: 'group', agentCreated: false })
    expect(d.attach).toHaveBeenCalledOnce()
  })

  it('reports transport rejection so the form can be retried', async () => {
    const d = deps()
    d.worktreeAdd.mockRejectedValue(new Error('E_DISCONNECTED'))
    expect(await createAgentWorktree(d, value, options)).toMatchObject({ ok: false, reason: 'git', message: 'E_DISCONNECTED' })
    expect(d.openAgent).not.toHaveBeenCalled()
  })
})
