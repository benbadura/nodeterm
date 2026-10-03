// Identity outlives state (device-measured bug): the phone's chat view locates a node's transcript
// by the claude `sessionId` it reads off this mirror, and the mirror used to drop a node's WHOLE
// entry — identity included — once its STATE was older than EXPIRE_MS. A conversation typed in the
// terminal and left idle overnight therefore opened on the phone as "No conversation yet" until the
// next prompt fired a hook. EXPIRE_MS is about a stale STATE ("working" from a dead session); these
// tests pin that past it the mirror keeps an IDENTITY-ONLY entry instead, bounded by node existence
// and a much longer identity TTL.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import {
  buildFile,
  filterMirrorForNodes,
  recordAgentEvent,
  flush,
  initAgentStatusMirror,
  setMirrorLiveNodesProvider,
  nodeState,
  mirrorEntry,
  workingNodes,
  sessionNameSweepEntries,
  _resetForTest,
  _snapshot,
  EXPIRE_MS,
  IDENTITY_EXPIRE_MS,
  type MirrorEntry
} from './agent-status-mirror'

function ev(partial: Partial<NormalizedAgentEvent>): NormalizedAgentEvent {
  return { nodeId: 'n1', agentId: 'claude', kind: 'state', ...partial } as NormalizedAgentEvent
}

const account = { configDir: '/home/u/.claude', accountId: null, known: true }

describe('buildFile — identity-only entries past EXPIRE_MS', () => {
  const now = IDENTITY_EXPIRE_MS + 10 * EXPIRE_MS

  it('keeps agentId/sessionId/account/name of an idle node older than 6 h, with NO state', () => {
    const doc = buildFile(
      {
        n1: {
          state: 'done',
          agentId: 'claude',
          sessionId: 'sess-1',
          account,
          name: 'refactor',
          updatedAt: now - EXPIRE_MS - 1
        }
      },
      now
    )
    const n1 = JSON.parse(JSON.stringify(doc)).nodes.n1
    expect(n1).toEqual({
      agentId: 'claude',
      sessionId: 'sess-1',
      account,
      name: 'refactor',
      updatedAt: now - EXPIRE_MS - 1
    })
    expect('state' in n1).toBe(false)
  })

  it('strips a stale "working" to identity — the rationale of EXPIRE_MS is the state, not the id', () => {
    const doc = buildFile(
      { n1: { state: 'working', agentId: 'codex', sessionId: 's', updatedAt: now - EXPIRE_MS - 1 } },
      now
    )
    expect(doc.nodes.n1.state).toBeUndefined()
    expect(doc.nodes.n1.sessionId).toBe('s')
  })

  it('still drops a stale entry that carries no identity at all', () => {
    const doc = buildFile({ n1: { state: 'working', updatedAt: now - EXPIRE_MS - 1 } }, now)
    expect(doc.nodes).toEqual({})
  })

  it('drops the identity past IDENTITY_EXPIRE_MS (the file cannot grow forever)', () => {
    const doc = buildFile(
      {
        old: { agentId: 'claude', sessionId: 'a', updatedAt: now - IDENTITY_EXPIRE_MS - 1 },
        kept: { agentId: 'claude', sessionId: 'b', updatedAt: now - IDENTITY_EXPIRE_MS + 1 }
      },
      now
    )
    expect(Object.keys(doc.nodes)).toEqual(['kept'])
  })

  it("drops a deleted node's identity when the live node set is known", () => {
    const doc = buildFile(
      {
        alive: { agentId: 'claude', sessionId: 'a', updatedAt: now - EXPIRE_MS - 1 },
        gone: { agentId: 'claude', sessionId: 'b', updatedAt: now - EXPIRE_MS - 1 },
        // A FRESH entry is never pruned by existence: a brand-new node may not be saved yet.
        fresh: { state: 'working', agentId: 'claude', sessionId: 'c', updatedAt: now - 1 }
      },
      now,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(['alive'])
    )
    expect(Object.keys(doc.nodes).sort()).toEqual(['alive', 'fresh'])
  })

  it('keeps a hibernated entry whole, state included (unchanged behavior)', () => {
    const doc = buildFile(
      { n1: { state: 'done', agentId: 'claude', sessionId: 's', hibernated: true, updatedAt: now - EXPIRE_MS - 1 } },
      now
    )
    expect(doc.nodes.n1.state).toBe('done')
    expect(doc.nodes.n1.hibernated).toBe(true)
  })

  it('the per-project SSH slice carries the identity-only entry', () => {
    const doc = buildFile(
      {
        mine: { state: 'done', agentId: 'claude', sessionId: 'sess-1', updatedAt: now - EXPIRE_MS - 1 },
        other: { agentId: 'claude', sessionId: 'x', updatedAt: now - EXPIRE_MS - 1 }
      },
      now
    )
    const slice = filterMirrorForNodes(doc, new Set(['mine']))
    expect(slice.nodes).toEqual({
      mine: { agentId: 'claude', sessionId: 'sess-1', updatedAt: now - EXPIRE_MS - 1 }
    })
  })
})

describe('live mirror — identity survives the state expiry', () => {
  let dir: string
  let file: string
  let nowSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _resetForTest()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mirror-identity-'))
    file = path.join(dir, 'agent-status.json')
    nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(1_000_000)
    initAgentStatusMirror(file)
  })
  afterEach(() => {
    nowSpy.mockRestore()
    _resetForTest()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const read = (): { nodes: Record<string, Record<string, unknown>> } =>
    JSON.parse(fs.readFileSync(file, 'utf-8'))

  it('an idle node older than 6 h keeps sessionId/agentId on disk and in memory, with no state', async () => {
    recordAgentEvent(ev({ state: 'working', newTurn: true, sessionId: 'sess-1' }))
    recordAgentEvent(ev({ state: 'done', sessionId: 'sess-1' }))
    nowSpy.mockReturnValue(1_000_000 + EXPIRE_MS + 1)
    await flush()

    expect(read().nodes.n1).toMatchObject({ agentId: 'claude', sessionId: 'sess-1' })
    expect('state' in read().nodes.n1).toBe(false)
    // Memory is stripped too: no reader of the live map may see the expired state.
    expect(nodeState('n1')).toBeUndefined()
    expect(mirrorEntry('n1')?.sessionId).toBe('sess-1')
    expect(mirrorEntry('n1')?.stateExpired).toBe(true)
  })

  it('a stale working node is no longer reported as working once stripped', async () => {
    recordAgentEvent(ev({ state: 'working', newTurn: true, sessionId: 'sess-1' }))
    nowSpy.mockReturnValue(1_000_000 + EXPIRE_MS + 1)
    await flush()
    expect(workingNodes()).toEqual([])
  })

  it('a later event re-grows the state on the kept identity and clears the expired marker', async () => {
    recordAgentEvent(ev({ state: 'done', sessionId: 'sess-1' }))
    nowSpy.mockReturnValue(1_000_000 + EXPIRE_MS + 1)
    await flush()
    recordAgentEvent(ev({ state: 'working', newTurn: true, sessionId: 'sess-1' }))
    const e = _snapshot().n1 as MirrorEntry
    expect(e.state).toBe('working')
    expect(e.stateExpired).toBeUndefined()
  })

  it("drops a deleted node's identity via the live-node provider", async () => {
    recordAgentEvent(ev({ nodeId: 'alive', state: 'done', sessionId: 'a' }))
    recordAgentEvent(ev({ nodeId: 'gone', state: 'done', sessionId: 'b' }))
    setMirrorLiveNodesProvider(() => new Set(['alive']))
    nowSpy.mockReturnValue(1_000_000 + EXPIRE_MS + 1)
    await flush()
    expect(Object.keys(read().nodes)).toEqual(['alive'])
    expect(_snapshot().gone).toBeUndefined()
  })

  it('does not ask the live-node provider when no entry is past EXPIRE_MS (it scans every project)', async () => {
    recordAgentEvent(ev({ nodeId: 'fresh', state: 'done', sessionId: 'f' }))
    const provider = vi.fn(() => new Set<string>())
    setMirrorLiveNodesProvider(provider)
    await flush()
    expect(provider).not.toHaveBeenCalled()
    expect(Object.keys(read().nodes)).toEqual(['fresh'])
    nowSpy.mockReturnValue(1_000_000 + EXPIRE_MS + 1)
    await flush()
    expect(provider).toHaveBeenCalled()
  })

  it('an UNKNOWABLE live set (provider answers undefined, or throws) prunes nothing by existence', async () => {
    recordAgentEvent(ev({ nodeId: 'a', state: 'done', sessionId: 'a' }))
    setMirrorLiveNodesProvider(() => undefined)
    nowSpy.mockReturnValue(1_000_000 + EXPIRE_MS + 1)
    await flush()
    expect(Object.keys(read().nodes)).toEqual(['a'])
    setMirrorLiveNodesProvider(() => {
      throw new Error('index not loaded')
    })
    await flush()
    expect(Object.keys(read().nodes)).toEqual(['a'])
  })

  it('the identity TTL bound drops it from disk and memory', async () => {
    recordAgentEvent(ev({ state: 'done', sessionId: 'sess-1' }))
    nowSpy.mockReturnValue(1_000_000 + IDENTITY_EXPIRE_MS + 1)
    await flush()
    expect(read().nodes).toEqual({})
    expect(_snapshot().n1).toBeUndefined()
  })

  it('the restart restore keeps the identity-only entry (and keeps it state-less)', async () => {
    recordAgentEvent(ev({ state: 'done', sessionId: 'sess-1', account }))
    await flush() // written while fresh, WITH its state
    _resetForTest()
    nowSpy.mockReturnValue(1_000_000 + EXPIRE_MS + 1)
    initAgentStatusMirror(file)

    const e = _snapshot().n1 as MirrorEntry
    expect(e).toBeDefined()
    expect(e.state).toBeUndefined()
    expect(e.sessionId).toBe('sess-1')
    expect(e.agentId).toBe('claude')
    expect(e.account).toEqual(account)
    expect(e.restored).toBe(true)
    await flush()
    expect(read().nodes.n1).toMatchObject({ sessionId: 'sess-1' })
    expect('state' in read().nodes.n1).toBe(false)
  })

  it('the restart restore drops an identity past IDENTITY_EXPIRE_MS', async () => {
    recordAgentEvent(ev({ state: 'done', sessionId: 'sess-1' }))
    await flush()
    _resetForTest()
    nowSpy.mockReturnValue(1_000_000 + IDENTITY_EXPIRE_MS + 1)
    initAgentStatusMirror(file)
    expect(_snapshot().n1).toBeUndefined()
  })
})

describe('session-name sweep scope', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    _resetForTest()
    nowSpy = vi.spyOn(Date, 'now')
  })
  afterEach(() => {
    nowSpy.mockRestore()
    _resetForTest()
  })

  it('does not walk identity-only entries (the sweep cost stays bounded by EXPIRE_MS)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mirror-sweep-'))
    try {
      nowSpy.mockReturnValue(1_000_000)
      initAgentStatusMirror(path.join(dir, 'agent-status.json'))
      recordAgentEvent(ev({ nodeId: 'old', state: 'done', sessionId: 'a' }))
      nowSpy.mockReturnValue(1_000_000 + EXPIRE_MS + 1)
      recordAgentEvent(ev({ nodeId: 'new', state: 'done', sessionId: 'b' }))
      await flush()
      expect(sessionNameSweepEntries().map((e) => e.nodeId)).toEqual(['new'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Both shells must wire the live-node provider, or the Server Edition (or the desktop) keeps a
// deleted node's identity for the whole TTL. The seam is optional, so a missing call still compiles.
describe('live-node provider wiring (both shells)', () => {
  it.each(['src/main/index.ts', 'src/server/index.ts'])('%s wires setMirrorLiveNodesProvider to the workspace store', (f) => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8').replace(/\r\n/g, '\n')
    expect(src).toMatch(/setMirrorLiveNodesProvider\(\(\) => workspaceStore\.knownNodeIds\(\)\)/)
  })
})
