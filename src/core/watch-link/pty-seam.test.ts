import { describe, it, expect, vi } from 'vitest'
import { createWatchPty, watchRemoteFor, watchRemoteRecords, type WatchPtyManager, type WatchRemoteRecords } from './pty-seam'
import { sshAttachmentId } from '../../shared/ssh'
import type { PtyCreateResult } from '../../shared/types'

function fakeManager(over: Partial<Record<keyof WatchPtyManager, unknown>> = {}) {
  const m = {
    joinAsWatcher: vi.fn(async (_c: number, _o: object): Promise<PtyCreateResult> => ({ sessionId: 's1', tmuxClient: true }) as PtyCreateResult),
    sessionSize: vi.fn((_s: string): { cols: number; rows: number } | null => ({ cols: 120, rows: 40 })),
    kill: vi.fn(),
    captureVisible: vi.fn(async () => ({ screen: 'x', cursor: { x: 1, y: 2 } })),
    syncWatcherClientSize: vi.fn(async () => true),
    hasSession: vi.fn(() => true),
    watcherInputRoute: vi.fn((_s: string): string => 'tmux'),
    controlInput: vi.fn(async (_s: string, _c: unknown) => true)
  }
  return Object.assign(m, over) as typeof m
}

describe('createWatchPty — the WatchPty seam both shells wire (R39)', () => {
  it('joins with the host ids only (never a size), and reports the JOINED session size and tmux-ness', async () => {
    const m = fakeManager()
    const pty = createWatchPty(m as unknown as WatchPtyManager)
    expect(await pty.join(7, 'n1', 'v-1')).toEqual({ sessionId: 's1', cols: 120, rows: 40, altScreen: true, input: 'tmux' })
    expect(m.joinAsWatcher).toHaveBeenCalledWith(7, { persistKey: 'n1', viewerId: 'v-1' })
    expect(m.sessionSize).toHaveBeenCalledWith('s1')
    expect(m.kill).not.toHaveBeenCalled()
  })

  it('altScreen is true only for a tmux client', async () => {
    const m = fakeManager({ joinAsWatcher: vi.fn(async () => ({ sessionId: 's1' })) })
    expect(await createWatchPty(m as unknown as WatchPtyManager).join(7, 'n1', 'v-1')).toMatchObject({ altScreen: false })
  })

  it('no session: null, nothing to leave', async () => {
    const m = fakeManager({ joinAsWatcher: vi.fn(async () => ({ sessionId: '', unavailable: 'join-only' })) })
    expect(await createWatchPty(m as unknown as WatchPtyManager).join(7, 'n1', 'v-1')).toBeNull()
    expect(m.kill).not.toHaveBeenCalled()
  })

  it('a joined session whose size is unknown is REFUSED — never an 80x24 guess — and left, not leaked', async () => {
    const m = fakeManager({ sessionSize: vi.fn(() => null) })
    expect(await createWatchPty(m as unknown as WatchPtyManager).join(7, 'n1', 'v-1')).toBeNull()
    expect(m.kill).toHaveBeenCalledWith(7, 's1', 'v-1')
  })

  it('an unavailable answer that still names a session is refused and left', async () => {
    const m = fakeManager({ joinAsWatcher: vi.fn(async () => ({ sessionId: 's1', unavailable: 'ssh' })) })
    expect(await createWatchPty(m as unknown as WatchPtyManager).join(7, 'n1', 'v-1')).toBeNull()
    expect(m.kill).toHaveBeenCalledWith(7, 's1', 'v-1')
    expect(m.sessionSize).not.toHaveBeenCalled()
  })

  it("a remote node's fields come from the shell's own records, requireRemote included", async () => {
    const m = fakeManager()
    const sshRemote = { conn: { host: 'h' } as never, controlPath: '/cp', remoteCwd: '~' }
    const pty = createWatchPty(m as unknown as WatchPtyManager, (nodeId) =>
      nodeId === 'r1' ? { requireRemote: true, sshRemote } : nodeId === 'r2' ? { requireRemote: true } : {}
    )
    await pty.join(7, 'r1', 'v-1')
    await pty.join(7, 'r2', 'v-2')
    expect(m.joinAsWatcher.mock.calls).toEqual([
      [7, { persistKey: 'r1', viewerId: 'v-1', sshRemote, requireRemote: true }],
      [7, { persistKey: 'r2', viewerId: 'v-2', requireRemote: true }]
    ])
  })

  it('leave, capture, size sync and liveness go to the matching PtyManager member', async () => {
    const m = fakeManager()
    const pty = createWatchPty(m as unknown as WatchPtyManager)
    pty.leave(7, 's1', 'v-1')
    expect(m.kill).toHaveBeenCalledWith(7, 's1', 'v-1')
    expect(await pty.captureVisible('s1')).toEqual({ screen: 'x', cursor: { x: 1, y: 2 } })
    expect(await pty.syncSize('s1')).toBe(true)
    expect(m.syncWatcherClientSize).toHaveBeenCalledWith('s1')
    expect(pty.alive('s1')).toBe(true)
    m.hasSession.mockReturnValue(false)
    expect(pty.alive('s1')).toBe(false)
  })

  // Control: the join reports how a controller's input reaches the JOINED session's pane (the route
  // PtyManager decides — Zellij and an unknown session answer `none`), and input goes to the pane.
  it("a join carries the joined session's input route, read from PtyManager", async () => {
    for (const route of ['tmux', 'ssh', 'write', 'none']) {
      const m = fakeManager({ watcherInputRoute: vi.fn(() => route) })
      expect(await createWatchPty(m as unknown as WatchPtyManager).join(7, 'n1', 'v-1')).toMatchObject({ input: route })
      expect(m.watcherInputRoute).toHaveBeenCalledWith('s1')
    }
    // A refused join never asks.
    const none = fakeManager({ sessionSize: vi.fn(() => null) })
    await createWatchPty(none as unknown as WatchPtyManager).join(7, 'n1', 'v-1')
    expect(none.watcherInputRoute).not.toHaveBeenCalled()
  })

  it("input goes to PtyManager.controlInput for that session, and its answer comes back as it is", async () => {
    const m = fakeManager()
    const pty = createWatchPty(m as unknown as WatchPtyManager)
    expect(await pty.input('s1', { kind: 'keys', data: 'ls\r' })).toBe(true)
    expect(m.controlInput.mock.calls[0].slice(0, 2)).toEqual(['s1', { kind: 'keys', data: 'ls\r' }])
    m.controlInput.mockResolvedValueOnce(false)
    expect(await pty.input('s1', { kind: 'paste', text: 'x' })).toBe(false)
    expect(m.controlInput.mock.calls[1].slice(0, 2)).toEqual(['s1', { kind: 'paste', text: 'x' }])
  })

  it("the link host's isCurrent predicate reaches controlInput unchanged (asked right before the step runs)", async () => {
    const m = fakeManager()
    const pty = createWatchPty(m as unknown as WatchPtyManager)
    const isCurrent = (): boolean => false
    await pty.input('s1', { kind: 'keys', data: 'a' }, isCurrent)
    expect(m.controlInput).toHaveBeenCalledWith('s1', { kind: 'keys', data: 'a' }, isCurrent)
  })
})

// Final review, Minor 4: a watcher join must never reach the LOCAL socket for a node whose session
// lives in a HOST's tmux — an SSH project's node, and also a remote-tmux node in a LOCAL project
// (`ssh` + `sshRemoteTmux` on the node), whose master is the project's host attachment.
describe('watchRemoteFor — where a watcher join goes, from the shell\'s own records', () => {
  const server = { host: 'box', user: 'alice' }
  const other = { host: 'other', user: 'bob', port: 2222 }
  const ref = (conn: object, controlPath: string, remoteCwd?: string) => ({ conn: conn as never, controlPath, remoteCwd })
  function records(o: {
    sshProject?: string
    copies?: { projectId: string; projectServer?: unknown; ssh?: unknown; sshRemoteTmux?: unknown }[]
    refs?: Record<string, ReturnType<typeof ref>>
  }): WatchRemoteRecords & { asked: string[] } {
    const asked: string[] = []
    return {
      asked,
      sshProjectIdForNode: () => o.sshProject,
      nodeCopies: () => o.copies ?? [],
      refFor: (id) => {
        asked.push(id)
        return o.refs?.[id]
      }
    }
  }

  it('an SSH project\'s node: requireRemote, over that project\'s master when it is up', () => {
    expect(watchRemoteFor('n1', records({ sshProject: 'p-ssh', refs: { 'p-ssh': ref(server, '/cm/1', '/srv') } }))).toEqual({
      requireRemote: true,
      sshRemote: { conn: server, controlPath: '/cm/1', remoteCwd: '/srv' }
    })
    expect(watchRemoteFor('n1', records({ sshProject: 'p-ssh' }))).toEqual({ requireRemote: true })
  })

  it('a remote-tmux node in a LOCAL project: requireRemote, over its host attachment (`sshAttachmentId`)', () => {
    const attachment = sshAttachmentId('p-local', other as never)
    const r = records({
      copies: [{ projectId: 'p-local', ssh: other, sshRemoteTmux: true }],
      refs: { [attachment]: ref(other, '/cm/2') }
    })
    expect(watchRemoteFor('n1', r)).toEqual({
      requireRemote: true,
      sshRemote: { conn: other, controlPath: '/cm/2', remoteCwd: '~' }
    })
    expect(r.asked).toEqual([attachment])
  })

  it('an unheld remote-tmux node whose master is down still never joins the LOCAL socket', () => {
    expect(watchRemoteFor('n1', records({ copies: [{ projectId: 'p-local', ssh: other, sshRemoteTmux: true }] }))).toEqual({
      requireRemote: true
    })
    // `sshRemoteTmux` alone (a binding that lost its host) is remote all the same — the renderer's rule.
    expect(watchRemoteFor('n1', records({ copies: [{ projectId: 'p-local', ssh: { user: 'x' }, sshRemoteTmux: true }] }))).toEqual({
      requireRemote: true
    })
  })

  it("a remote-tmux node on its own project's host goes over the PROJECT's master (`sshConnectionIdForProject`)", () => {
    const r = records({
      copies: [{ projectId: 'p-x', projectServer: server, ssh: { host: 'box', user: 'someone-else' }, sshRemoteTmux: true }],
      refs: { 'p-x': ref(server, '/cm/3', '/home/alice') }
    })
    expect(watchRemoteFor('n1', r)).toEqual({
      requireRemote: true,
      sshRemote: { conn: server, controlPath: '/cm/3', remoteCwd: '/home/alice' }
    })
  })

  it('a local node, and a standalone ssh terminal node (its ssh runs in LOCAL tmux), are local', () => {
    expect(watchRemoteFor('n1', records({}))).toEqual({})
    expect(watchRemoteFor('n1', records({ copies: [{ projectId: 'p-local' }] }))).toEqual({})
    expect(watchRemoteFor('n1', records({ copies: [{ projectId: 'p-local', ssh: other }] }))).toEqual({})
    expect(watchRemoteFor('n1', records({ copies: [{ projectId: 'p-local', ssh: other, sshRemoteTmux: 'true' }] }))).toEqual({})
  })

  it('any copy that says remote-tmux makes the join remote (fail closed), and the first copy with a live master serves it', () => {
    const attachment = sshAttachmentId('p-b', other as never)
    const r = records({
      copies: [
        { projectId: 'p-a' },
        { projectId: 'p-b', ssh: other, sshRemoteTmux: true }
      ],
      refs: { [attachment]: ref(other, '/cm/4') }
    })
    expect(watchRemoteFor('n1', r)).toMatchObject({ requireRemote: true, sshRemote: { controlPath: '/cm/4' } })
  })

  it("both shells read the records the same way: the workspace store's own copies, each with its project's server", () => {
    const canvases = [
      { id: 'p-a', nodes: [{ id: 'n1' }] },
      { id: 'p-b', nodes: [{ id: 'n2' }, { id: 'n1', ssh: other, sshRemoteTmux: true }] }
    ]
    let scans = 0
    const store = {
      sshProjectIdForNode: (id: string) => (id === 'n-ssh' ? 'p-ssh' : undefined),
      projectIdsForNode: (id: string) => (id === 'n1' ? ['p-a', 'p-b'] : []),
      persistedCanvases: () => {
        scans++
        return canvases as never
      },
      projectTargetInfo: (id: string) => (id === 'p-b' ? { ssh: { server, remoteCwd: '~' }, name: 'B' } : { name: id })
    }
    const asked: string[] = []
    const recs = watchRemoteRecords(store, (id) => {
      asked.push(id)
      return undefined
    })
    expect(recs.sshProjectIdForNode('n-ssh')).toBe('p-ssh')
    expect(recs.nodeCopies('n1')).toEqual([
      { projectId: 'p-a', projectServer: undefined, ssh: undefined, sshRemoteTmux: undefined },
      { projectId: 'p-b', projectServer: server, ssh: other, sshRemoteTmux: true }
    ])
    // A node no project holds costs no scan of every project file.
    scans = 0
    expect(recs.nodeCopies('nowhere')).toEqual([])
    expect(scans).toBe(0)
    expect(watchRemoteFor('n1', recs)).toEqual({ requireRemote: true })
    expect(asked).toEqual([sshAttachmentId('p-b', other as never)])
  })

  it('records that throw read as remote-unknown: requireRemote, never the local socket', () => {
    const bad: WatchRemoteRecords = {
      sshProjectIdForNode: () => {
        throw new Error('index not loaded')
      },
      nodeCopies: () => [],
      refFor: () => undefined
    }
    expect(watchRemoteFor('n1', bad)).toEqual({ requireRemote: true })
  })
})
