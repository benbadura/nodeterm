import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentNode, flowToNodeStates, nodeStatesToFlow } from './workspace'
import { prepareMemoryCommand } from '@shared/memory-launch'
import { useSettings } from './settings'
import { DEFAULT_SETTINGS } from '@shared/types'

const runtime = vi.hoisted(() => ({ source: 'local', browser: false }))
vi.mock('../session/session', () => ({ sessionForProject: () => ({ source: runtime.source }) }))
vi.mock('../bridge/runtime', () => ({ isBrowserRuntime: () => runtime.browser }))
beforeEach(() => { runtime.source = 'local'; runtime.browser = false; useSettings.setState({ settings: DEFAULT_SETTINGS }) })

describe('fresh session memory integration', () => {
  it('retains a deferred recipe across cold restore and prepares current context only at delivery', async () => {
    const node = createAgentNode('claude', 0, '/repo', undefined, 'Original request', undefined, undefined, 'plan', 'project')
    const restored = nodeStatesToFlow(flowToNodeStates([node]))[0]
    const prepare = vi.fn(async () => ({ ok: true as const, value: { body: 'Current approved decisions', filePath: '/repo/.nodeterm/memory/packets/new.md' } }))
    expect(prepare).not.toHaveBeenCalled()
    const command = await prepareMemoryCommand(restored.data.pendingLaunch!.command, restored.id, prepare)
    expect(command).toContain('/repo/.nodeterm/memory/packets/new.md')
    expect(command).toContain('Original request')
    expect(command).toContain('--permission-mode plan')
    expect(command).not.toContain('# nodeterm-memory')
    expect(prepare).toHaveBeenCalledWith(node.id)
  })
  it.each(['relay', 'server', 'browser', 'resume'])('does not add local memory to %s sessions', async (kind) => {
    runtime.source = kind === 'relay' || kind === 'server' ? kind : 'local'
    runtime.browser = kind === 'browser'
    const node = createAgentNode('claude', 0, '/repo', undefined, 'Request', undefined, undefined, undefined, 'project', undefined, undefined, kind === 'resume' ? 'existing-session' : undefined)
    const prepare = vi.fn()
    const command = node.data.initialCommand as string
    expect(await prepareMemoryCommand(command, node.id, prepare)).toBe(command)
    expect(prepare).not.toHaveBeenCalled()
  })
})
