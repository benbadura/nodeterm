import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MirrorFile, MirrorSettings } from '../../core/agent-status-mirror'
import { initRemoteStatusPush, STATUS_EDGE_MIN_GAP_MS } from './remote-status-push'
import { buildFile, EXPIRE_MS } from '../../core/agent-status-mirror'
import type { AgentState } from '../../shared/agents/normalize'

function doc(updatedAt: number, ids: string[]): MirrorFile {
  const nodes: MirrorFile['nodes'] = {}
  for (const id of ids) nodes[id] = { state: 'working', updatedAt }
  return { v: 1, updatedAt, nodes }
}

function stateDoc(updatedAt: number, states: Record<string, AgentState | undefined>): MirrorFile {
  const nodes: MirrorFile['nodes'] = {}
  for (const [id, state] of Object.entries(states)) nodes[id] = { state, updatedAt }
  return { v: 1, updatedAt, nodes }
}

describe('initRemoteStatusPush', () => {
  let flushCb: ((d: MirrorFile) => void) | null
  let pushes: Array<{ id: string; json: string }>
  let disposer: { dispose: () => void } | null

  const deps = (over: Partial<Parameters<typeof initRemoteStatusPush>[0]> = {}) => ({
    onFlush: (cb: (d: MirrorFile) => void) => {
      flushCb = cb
      return () => {
        flushCb = null
      }
    },
    flush: vi.fn(async () => flushCb?.(doc(Date.now(), ['a1']))),
    sshProjectIds: () => ['p1'],
    nodeIdsFor: () => new Set(['a1']),
    push: async (id: string, json: string) => {
      pushes.push({ id, json })
    },
    heartbeatMs: 0,
    ...over
  })

  beforeEach(() => {
    vi.useFakeTimers()
    flushCb = null
    pushes = []
    disposer = null
  })

  afterEach(() => {
    disposer?.dispose()
    vi.useRealTimers()
  })

  it('pushes each project its own filtered slice on flush', () => {
    disposer = initRemoteStatusPush(
      deps({
        sshProjectIds: () => ['p1', 'p2'],
        nodeIdsFor: (id) => new Set(id === 'p1' ? ['a1'] : ['b1'])
      })
    )
    flushCb!(doc(1000, ['a1', 'b1', 'other']))
    expect(pushes).toHaveLength(2)
    const p1 = JSON.parse(pushes.find((p) => p.id === 'p1')!.json)
    expect(Object.keys(p1.nodes)).toEqual(['a1'])
    const p2 = JSON.parse(pushes.find((p) => p.id === 'p2')!.json)
    expect(Object.keys(p2.nodes)).toEqual(['b1'])
  })

  it("pushes an IDENTITY-ONLY entry (state expired) so the phone keeps the node's session id", () => {
    // The phone's chat view finds a node's transcript ONLY via the sessionId in this slice. Past
    // EXPIRE_MS the mirror strips the state but keeps the identity; the slice must carry it.
    const now = EXPIRE_MS * 2
    const built = buildFile(
      { a1: { state: 'done', agentId: 'claude', sessionId: 'sess-1', updatedAt: now - EXPIRE_MS - 1 } },
      now
    )
    disposer = initRemoteStatusPush(deps())
    flushCb!(built)
    const slice = JSON.parse(pushes[0].json)
    expect(slice.nodes.a1).toEqual({ agentId: 'claude', sessionId: 'sess-1', updatedAt: now - EXPIRE_MS - 1 })
  })

  it('throttles a burst into leading + one trailing push with the LATEST doc', () => {
    disposer = initRemoteStatusPush(deps({ throttleMs: 2000 }))
    flushCb!(doc(1, ['a1']))
    flushCb!(doc(2, ['a1']))
    flushCb!(doc(3, ['a1']))
    expect(pushes).toHaveLength(1)
    expect(JSON.parse(pushes[0].json).updatedAt).toBe(1)
    vi.advanceTimersByTime(2000)
    expect(pushes).toHaveLength(2)
    expect(JSON.parse(pushes[1].json).updatedAt).toBe(3)
  })

  it('a quiet window ends the throttle without a redundant trailing push', () => {
    disposer = initRemoteStatusPush(deps({ throttleMs: 2000 }))
    flushCb!(doc(1, ['a1']))
    vi.advanceTimersByTime(2000)
    expect(pushes).toHaveLength(1)
    // Next flush after the window pushes immediately again (leading edge restored).
    flushCb!(doc(9, ['a1']))
    expect(pushes).toHaveLength(2)
  })

  it('heartbeat triggers mirror flushes on the interval', () => {
    const d = deps({ heartbeatMs: 60_000 })
    disposer = initRemoteStatusPush(d)
    expect(d.flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(d.flush).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(120_000)
    expect(d.flush).toHaveBeenCalledTimes(3)
  })

  it('injects per-project settings into the pushed slice', () => {
    const settings: MirrorSettings = { claudePermissionMode: 'auto', autoSupported: true }
    disposer = initRemoteStatusPush(
      deps({
        nodeIdsFor: () => new Set(['n1']),
        settingsFor: (id: string) => ({ claudePermissionMode: 'auto', autoSupported: id === 'p1' })
      })
    )
    flushCb!({ v: 1, updatedAt: 1, nodes: { n1: { updatedAt: 1 } } })
    const slice = JSON.parse(pushes.find((p) => p.id === 'p1')!.json)
    expect(slice.settings).toEqual(settings)
    expect(Object.keys(slice.nodes)).toEqual(['n1'])
  })

  it('omits settings when settingsFor is absent or returns undefined', () => {
    disposer = initRemoteStatusPush(
      deps({
        nodeIdsFor: () => new Set(),
        settingsFor: () => undefined
      })
    )
    flushCb!({ v: 1, updatedAt: 1, nodes: {} })
    expect('settings' in JSON.parse(pushes.find((p) => p.id === 'p1')!.json)).toBe(false)
  })

  it('a throwing settingsFor never breaks the push (fails open, no settings key)', () => {
    disposer = initRemoteStatusPush(
      deps({
        nodeIdsFor: () => new Set(),
        settingsFor: () => {
          throw new Error('boom')
        }
      })
    )
    flushCb!({ v: 1, updatedAt: 1, nodes: {} })
    expect(pushes).toHaveLength(1)
    expect('settings' in JSON.parse(pushes[0].json)).toBe(false)
  })

  it('a state EDGE inside the throttle window pushes immediately (working → done)', () => {
    disposer = initRemoteStatusPush(deps({ throttleMs: 2000 }))
    flushCb!(stateDoc(1, { a1: 'working' }))
    expect(pushes).toHaveLength(1)
    vi.advanceTimersByTime(STATUS_EDGE_MIN_GAP_MS + 100)
    flushCb!(stateDoc(2, { a1: 'done' }))
    expect(pushes).toHaveLength(2)
    expect(JSON.parse(pushes[1].json).nodes.a1.state).toBe('done')
  })

  it('an edge resets the window: churn after it is throttled from the edge, not the leading push', () => {
    disposer = initRemoteStatusPush(deps({ throttleMs: 2000 }))
    flushCb!(stateDoc(1, { a1: 'working' }))
    vi.advanceTimersByTime(1500)
    flushCb!(stateDoc(2, { a1: 'blocked' })) // edge at t=1500 → new window until 3500
    expect(pushes).toHaveLength(2)
    flushCb!(stateDoc(3, { a1: 'blocked' })) // same-state churn → dirty
    vi.advanceTimersByTime(600) // t=2100: old window would have fired here
    expect(pushes).toHaveLength(2)
    vi.advanceTimersByTime(1400) // t=3500
    expect(pushes).toHaveLength(3)
    expect(JSON.parse(pushes[2].json).updatedAt).toBe(3)
  })

  it('same-state churn stays throttled exactly as before', () => {
    disposer = initRemoteStatusPush(deps({ throttleMs: 2000 }))
    flushCb!(stateDoc(1, { a1: 'working' }))
    for (let i = 2; i < 7; i++) {
      vi.advanceTimersByTime(300)
      flushCb!(stateDoc(i, { a1: 'working' }))
    }
    expect(pushes).toHaveLength(1)
    vi.advanceTimersByTime(500)
    expect(pushes).toHaveLength(2)
    expect(JSON.parse(pushes[1].json).updatedAt).toBe(6)
  })

  it('an edge in ANOTHER project does not un-throttle this one', () => {
    let states: Record<string, AgentState> = { a1: 'working', b1: 'working' }
    disposer = initRemoteStatusPush(
      deps({
        throttleMs: 2000,
        sshProjectIds: () => ['p1', 'p2'],
        nodeIdsFor: (id) => new Set(id === 'p1' ? ['a1'] : ['b1'])
      })
    )
    flushCb!(stateDoc(1, states))
    expect(pushes).toHaveLength(2)
    vi.advanceTimersByTime(1000)
    states = { a1: 'working', b1: 'done' }
    flushCb!(stateDoc(2, states))
    expect(pushes).toHaveLength(3)
    expect(pushes[2].id).toBe('p2')
  })

  it('caps flapping edges: at most one immediate edge push per min gap, trailing ships the final state', () => {
    disposer = initRemoteStatusPush(deps({ throttleMs: 2000 }))
    flushCb!(stateDoc(1, { a1: 'working' }))
    // Flap every 50 ms for 2 s → 40 edges.
    const seq: AgentState[] = []
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(50)
      const s: AgentState = i % 2 === 0 ? 'blocked' : 'working'
      seq.push(s)
      flushCb!(stateDoc(i + 2, { a1: s }))
    }
    // 2000 ms of flapping may produce at most one edge push per gap (+ the leading push).
    expect(pushes.length).toBeLessThanOrEqual(1 + Math.ceil(2000 / STATUS_EDGE_MIN_GAP_MS))
    vi.advanceTimersByTime(2000)
    const last = JSON.parse(pushes[pushes.length - 1].json)
    expect(last.nodes.a1.state).toBe(seq[seq.length - 1])
    expect(last.updatedAt).toBe(41)
  })

  it('an edge that lands inside the cap still ships via the trailing push', () => {
    disposer = initRemoteStatusPush(deps({ throttleMs: 2000 }))
    flushCb!(stateDoc(1, { a1: 'working' }))
    vi.advanceTimersByTime(10)
    flushCb!(stateDoc(2, { a1: 'done' })) // inside the cap → deferred
    expect(pushes).toHaveLength(1)
    vi.advanceTimersByTime(1990)
    expect(pushes).toHaveLength(2)
    expect(JSON.parse(pushes[1].json).nodes.a1.state).toBe('done')
  })

  it('a node appearing with a state counts as an edge', () => {
    disposer = initRemoteStatusPush(
      deps({ throttleMs: 2000, nodeIdsFor: () => new Set(['a1', 'a2']) })
    )
    flushCb!(stateDoc(1, { a1: 'working' }))
    vi.advanceTimersByTime(STATUS_EDGE_MIN_GAP_MS)
    flushCb!(stateDoc(2, { a1: 'working', a2: 'working' }))
    expect(pushes).toHaveLength(2)
  })

  it('dispose unsubscribes and stops timers', () => {
    const d = deps({ heartbeatMs: 60_000, throttleMs: 2000 })
    disposer = initRemoteStatusPush(d)
    flushCb?.(doc(1, ['a1']))
    disposer.dispose()
    disposer = null
    expect(flushCb).toBeNull()
    vi.advanceTimersByTime(300_000)
    expect(d.flush).not.toHaveBeenCalled()
    expect(pushes).toHaveLength(1)
  })
})
