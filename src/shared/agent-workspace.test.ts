import { describe, expect, it } from 'vitest'
import { agentWorkspaceMode, rememberAgentWorkspaceMode, sanitizeAgentWorkspacePreferences } from './agent-workspace'

describe('manual agent workspace preferences', () => {
  it('defaults missing and malformed preferences to the current directory', () => {
    for (const raw of [undefined, null, true, [], { p: 'other' }, { p: true }]) {
      expect(agentWorkspaceMode(raw, 'p')).toBe('current')
    }
    expect(agentWorkspaceMode({}, 'toString')).toBe('current')
  })

  it('remembers each project independently without mutating the previous snapshot', () => {
    const first = rememberAgentWorkspaceMode(undefined, 'p1', 'new-worktree')
    const second = rememberAgentWorkspaceMode(first, 'p2', 'current')
    expect(first).toEqual({ p1: 'new-worktree' })
    expect(agentWorkspaceMode(second, 'p1')).toBe('new-worktree')
    expect(agentWorkspaceMode(second, 'p2')).toBe('current')
    expect(agentWorkspaceMode(second, 'p3')).toBe('current')
    const restored = JSON.parse(JSON.stringify(second))
    expect(agentWorkspaceMode(restored, 'p1')).toBe('new-worktree')
  })

  it('keeps valid choices while dropping unknown values', () => {
    expect(sanitizeAgentWorkspacePreferences({ a: 'current', b: 'new-worktree', c: 'auto', '': 'current' }))
      .toEqual({ a: 'current', b: 'new-worktree' })
  })
})
