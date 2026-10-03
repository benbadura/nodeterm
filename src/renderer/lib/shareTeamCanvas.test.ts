import { describe, expect, it, vi } from 'vitest'
import type { CanvasNodeState, HandedOffTo } from '@shared/types'
import {
  SHARE_FOCUS_WAIT_MS,
  SHARE_SAVE_FAILED,
  followSharedProject,
  shareFocusStep,
  shareProjectDeps,
  shareCanvas,
  shareTerminals,
  type ShareCanvasOps
} from './shareTeamCanvas'

const PROJ = { id: 'ssh-1', server: { host: 'box', user: 'alice' } }

const node = (over: Partial<CanvasNodeState> & { id: string }): CanvasNodeState => ({
  kind: 'terminal',
  position: { x: 0, y: 0 },
  size: { width: 1, height: 1 },
  title: over.id,
  color: '#fff',
  group: null,
  ...over
})

describe('shareTerminals', () => {
  it('takes terminal nodes only (a legacy node without a kind is one), with what is known of each agent', () => {
    const nodes = [
      node({ id: 'a', title: 'Claude', agentId: 'claude', agentSessionId: 'minted', accountId: 'acc' }),
      node({ id: 'b', title: '' }),
      { ...node({ id: 'legacy' }), kind: undefined as unknown as CanvasNodeState['kind'] },
      node({ id: 's', kind: 'sticky' }),
      node({ id: 'g', kind: 'group' })
    ]
    const out = shareTerminals(nodes, { a: { sessionId: 'hooked', state: 'done' } }, PROJ)
    expect(out).toEqual([
      // The hook-fed id wins over the minted one: /clear and --fork-session mint a new one in-CLI.
      { nodeId: 'a', title: 'Claude', agentId: 'claude', sessionId: 'hooked', accountId: 'acc', state: 'done' },
      // An untitled node is listed by its id.
      { nodeId: 'b', title: 'b' },
      { nodeId: 'legacy', title: 'legacy' }
    ])
  })

  it('falls back to the persisted session id when no hook reported one', () => {
    const out = shareTerminals([node({ id: 'a', agentId: 'claude', agentSessionId: 'minted' })], {}, PROJ)
    expect(out[0].sessionId).toBe('minted')
    expect('state' in out[0]).toBe(false)
  })

  it('carries the status store agent beside the node own one, and only when the store knows one', () => {
    const out = shareTerminals(
      [node({ id: 'hand' }), node({ id: 'made', agentId: 'claude' })],
      { hand: { agentId: 'codex', state: 'working' }, made: { state: 'done' } },
      PROJ
    )
    expect(out[0]).toEqual({ nodeId: 'hand', title: 'hand', liveAgentId: 'codex', state: 'working' })
    expect(out[1]).toEqual({ nodeId: 'made', title: 'made', agentId: 'claude', state: 'done' })
  })

  it('marks a remote-tmux terminal on another host (a host attachment); same host and plain ssh are not', () => {
    const out = shareTerminals(
      [
        node({ id: 'own', ssh: { host: 'box', user: 'alice' }, sshRemoteTmux: true }),
        // The project's own host under another login is still served by the project's master.
        node({ id: 'own-other-user', ssh: { host: 'box', user: 'bob' }, sshRemoteTmux: true }),
        node({ id: 'att', ssh: { host: 'prod', user: 'alice' }, sshRemoteTmux: true }),
        node({ id: 'plain-ssh', ssh: { host: 'prod', user: 'alice' } })
      ],
      {},
      PROJ
    )
    expect(out.filter((n) => n.otherHost).map((n) => n.nodeId)).toEqual(['att'])
  })
})

describe('shareCanvas', () => {
  it('lists every node id of the project (notes and frames too) beside its terminals', () => {
    const c = shareCanvas([node({ id: 't' }), node({ id: 's', kind: 'sticky' }), node({ id: 'g', kind: 'group' })], {}, PROJ)
    expect(c.terminals.map((n) => n.nodeId)).toEqual(['t'])
    expect(c.nodeIds).toEqual(['t', 's', 'g'])
  })
})

type FakeOps = ShareCanvasOps & { calls: string[]; mark: HandedOffTo | undefined; closed: boolean }

function ops(over: Partial<ShareCanvasOps> = {}): FakeOps {
  const calls: string[] = []
  const o: FakeOps = {
    calls,
    mark: undefined,
    closed: false,
    commit: () => void calls.push('commit'),
    save: async () => {
      calls.push('save')
      return true
    },
    setHandedOffTo: (v: HandedOffTo | undefined) => {
      calls.push(v ? `mark:${v.hostId ?? '-'}` : 'unmark')
      o.mark = v
    },
    isClosed: () => o.closed,
    close: () => {
      calls.push('close')
      o.closed = true
    },
    reopen: () => {
      calls.push('reopen')
      o.closed = false
    },
    join: (code: string, focus: string): 'started' | 'busy' | null => {
      calls.push(`join:${code}:${focus}`)
      return 'started'
    },
    followTab: (id: string) => void calls.push(`follow:${id}`),
    now: () => 42,
    ...over
  }
  return o
}

describe('shareProjectDeps', () => {
  it('prepare commits the live canvas, then awaits the save', async () => {
    const o = ops()
    await shareProjectDeps(o).prepare()
    expect(o.calls).toEqual(['commit', 'save'])
  })

  it('every step that saves fails when the save did not land', async () => {
    const o = ops({ save: async () => false })
    const d = shareProjectDeps(o)
    await expect(d.prepare()).rejects.toThrow(SHARE_SAVE_FAILED)
    await expect(d.markPending()).rejects.toThrow(SHARE_SAVE_FAILED)
    await expect(d.release()).rejects.toThrow(SHARE_SAVE_FAILED)
    await expect(d.restore()).rejects.toThrow(SHARE_SAVE_FAILED)
    await expect(d.markHandedOff({ hostId: 'H', projectId: 'P' })).rejects.toThrow(SHARE_SAVE_FAILED)
  })

  it('markPending sets the in-progress mark (no host yet) and saves', async () => {
    const o = ops()
    await shareProjectDeps(o).markPending()
    expect(o.mark).toEqual({ at: 42 })
    expect(o.calls).toEqual(['mark:-', 'save'])
  })

  it('release only closes and saves: the mark is already set', async () => {
    const o = ops()
    await shareProjectDeps(o).release()
    expect(o.calls).toEqual(['close', 'save'])
  })

  it('restore clears the mark, reopens a closed project, and saves', async () => {
    const o = ops()
    o.mark = { at: 1 }
    o.closed = true
    await shareProjectDeps(o).restore()
    expect(o.calls).toEqual(['unmark', 'reopen', 'save'])
    expect(o.mark).toBeUndefined()
    expect(o.isClosed()).toBe(false)
  })

  it('restore on a project that was never closed only clears the mark (nothing is reopened or switched to)', async () => {
    const o = ops()
    o.mark = { at: 1 }
    await shareProjectDeps(o).restore()
    expect(o.calls).toEqual(['unmark', 'save'])
  })

  it('markHandedOff records the team and the server project, stamped now', async () => {
    const o = ops()
    await shareProjectDeps(o).markHandedOff({ hostId: 'H', projectId: 'P' })
    expect(o.mark).toEqual({ hostId: 'H', projectId: 'P', at: 42 })
    expect(o.calls).toEqual(['mark:H', 'save'])
  })

  it('a join that started lands by itself; a busy one (the team is live here) follows the shared tab', () => {
    const started = ops()
    shareProjectDeps(started).join('CODE', 'P9')
    expect(started.calls).toEqual(['join:CODE:P9'])
    const busy = ops({ join: () => 'busy' })
    shareProjectDeps(busy).join('CODE', 'P9')
    expect(busy.calls).toEqual(['follow:P9'])
    const none = ops({ join: () => null })
    shareProjectDeps(none).join('CODE', 'P9')
    expect(none.calls).toEqual([])
  })
})

describe('shareFocusStep', () => {
  it('switches once the tab is open, waits while it is not, and stops when there or moved away', () => {
    expect(shareFocusStep('T', 'A', { activeId: 'A', targetOpen: true })).toBe('switch')
    expect(shareFocusStep('T', 'A', { activeId: 'A', targetOpen: false })).toBe('wait')
    expect(shareFocusStep('T', 'A', { activeId: 'T', targetOpen: true })).toBe('stop')
    // The user went elsewhere themselves: never pulled back.
    expect(shareFocusStep('T', 'A', { activeId: 'B', targetOpen: false })).toBe('stop')
  })
})

describe('followSharedProject', () => {
  function harness(initial: { activeId: string; targetOpen: boolean }) {
    let view = { ...initial }
    const listeners = new Set<() => void>()
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
    const switchTo = vi.fn((id: string) => {
      view = { ...view, activeId: id }
    })
    const deps = {
      targetId: 'T',
      read: () => view,
      subscribe: (l: () => void) => {
        listeners.add(l)
        return () => void listeners.delete(l)
      },
      switchTo,
      setTimer: (fn: () => void, ms: number) => {
        const t = { fn, ms, cleared: false }
        timers.push(t)
        return t
      },
      clearTimer: (t: unknown) => {
        ;(t as { cleared: boolean }).cleared = true
      }
    }
    const change = (next: Partial<typeof view>): void => {
      view = { ...view, ...next }
      for (const l of [...listeners]) l()
    }
    return { deps, switchTo, change, listeners, timers }
  }

  it('switches at once when the tab is already open, and watches nothing', () => {
    const h = harness({ activeId: 'A', targetOpen: true })
    followSharedProject(h.deps)
    expect(h.switchTo).toHaveBeenCalledWith('T')
    expect(h.listeners.size).toBe(0)
    expect(h.timers).toHaveLength(0)
  })

  it('switches when the share event opens the tab, then stops watching', () => {
    const h = harness({ activeId: 'A', targetOpen: false })
    followSharedProject(h.deps)
    expect(h.switchTo).not.toHaveBeenCalled()
    expect(h.timers[0].ms).toBe(SHARE_FOCUS_WAIT_MS)
    h.change({ targetOpen: true })
    expect(h.switchTo).toHaveBeenCalledTimes(1)
    expect(h.listeners.size).toBe(0)
    expect(h.timers[0].cleared).toBe(true)
    h.change({ activeId: 'A' })
    expect(h.switchTo).toHaveBeenCalledTimes(1)
  })

  it('gives up when the user switches projects themselves', () => {
    const h = harness({ activeId: 'A', targetOpen: false })
    followSharedProject(h.deps)
    h.change({ activeId: 'B' })
    h.change({ targetOpen: true })
    expect(h.switchTo).not.toHaveBeenCalled()
    expect(h.listeners.size).toBe(0)
  })

  it('gives up after the wait, and when stopped by its caller', () => {
    const h = harness({ activeId: 'A', targetOpen: false })
    followSharedProject(h.deps)
    h.timers[0].fn()
    h.change({ targetOpen: true })
    expect(h.switchTo).not.toHaveBeenCalled()
    expect(h.listeners.size).toBe(0)

    const k = harness({ activeId: 'A', targetOpen: false })
    const stop = followSharedProject(k.deps)
    stop()
    k.change({ targetOpen: true })
    expect(k.switchTo).not.toHaveBeenCalled()
    expect(k.timers[0].cleared).toBe(true)
  })
})
