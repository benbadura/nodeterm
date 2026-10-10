import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasNodeState, GitResult, NodeKind } from '@shared/types'
import { EMPTY_NAMING_OUTPUT, NAMING_NODE_KINDS } from '@shared/node-naming'
import { nameAllNodes, namingContext, namingDescendants, summarizeBulkNaming } from './bulkNaming'
import { useSessionNaming } from '../state/sessionNaming'

const node = (id: string, kind: NodeKind = 'terminal', patch: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, kind, title: `Manual ${id}`, position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
  color: '#fff', group: null, ...patch
})

function harness(nodes: CanvasNodeState[]) {
  const current = new Map(nodes.map((n) => [n.id, n]))
  const pty = {
    generateName: vi.fn(async () => ({ ok: true, message: 'Terminal Purpose' })),
    generateGroupName: vi.fn(async () => ({ ok: true, message: 'Group Purpose' })),
    generateNodeName: vi.fn(async () => ({ ok: true, message: 'Node Purpose' }))
  }
  const rename = vi.fn((id: string, title: string) => {
    current.set(id, { ...current.get(id)!, title, titleAuto: false })
  })
  const finish = vi.fn((id: string) => useSessionNaming.getState().set(id, false))
  const io = { pty, current: (id: string) => current.get(id), rename,
    tryStart: (id: string) => useSessionNaming.getState().tryStart(id), finish }
  return { current, pty, rename, finish, io }
}

beforeEach(() => useSessionNaming.setState({ byId: {}, batchProjectId: null }))

describe('Name All with AI', () => {
  it('renames every persistent kind, including manual titles and grouped children, but not fan-out cards', async () => {
    const nodes = [...NAMING_NODE_KINDS].map((kind) => node(kind, kind as NodeKind))
    nodes.push(node('child', 'terminal', { parentId: 'group' }), node('sub', 'subagent'), node('loop', 'loop'))
    const h = harness(nodes)
    const result = await nameAllNodes(nodes, h.io)
    expect(result).toMatchObject({ total: 12, completed: 12, changed: 12, failed: 0, skipped: 0 })
    expect(h.rename).not.toHaveBeenCalledWith('sub', expect.anything())
    expect(h.rename).not.toHaveBeenCalledWith('loop', expect.anything())
    expect(h.pty.generateGroupName).toHaveBeenCalledWith(['child'], '')
    expect(h.current.get('child')).toMatchObject({ parentId: 'group', titleAuto: false })
    expect(useSessionNaming.getState().byId).toEqual({})
  })

  it('uses metadata for empty terminals/groups, preserves account binding and avoids a remote spawn cwd', async () => {
    const nodes = [node('t', 'terminal', { cwd: '/remote/project', accountId: 'managed', ssh: { host: 'remote' } as never }),
      node('g', 'group'), node('g2', 'group'), node('kid', 'terminal', { parentId: 'g2' })]
    const h = harness(nodes)
    h.pty.generateName.mockResolvedValue({ ok: false, message: EMPTY_NAMING_OUTPUT })
    h.pty.generateGroupName.mockResolvedValue({ ok: false, message: EMPTY_NAMING_OUTPUT })
    const result = await nameAllNodes(nodes, h.io)
    expect(result.changed).toBe(4)
    expect(h.pty.generateNodeName).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'terminal', details: expect.stringContaining('/remote/project')
    }), '', 'managed')
    expect(h.pty.generateNodeName).toHaveBeenCalledWith(expect.objectContaining({ kind: 'group', title: 'Manual g' }), '', undefined)
  })

  it('limits simultaneous requests to two and continues after both returned and thrown failures', async () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')]
    const h = harness(nodes)
    const releases: Array<(r: GitResult) => void> = []
    let running = 0
    let peak = 0
    h.pty.generateName.mockImplementation(async () => {
      peak = Math.max(peak, ++running)
      try { return await new Promise<GitResult>((resolve) => releases.push(resolve)) }
      finally { running-- }
    })
    const work = nameAllNodes(nodes, h.io)
    expect(releases).toHaveLength(2)
    releases[0]({ ok: false, message: 'Authentication failed' })
    await vi.waitFor(() => expect(releases).toHaveLength(3))
    releases[1]({ ok: true, message: 'Updated Name' })
    await vi.waitFor(() => expect(releases).toHaveLength(4))
    releases[2]({ ok: true, message: 'Another Name' })
    releases[3]({ ok: true, message: 'Last Name' })
    expect(await work).toMatchObject({ changed: 3, failed: 1, completed: 4 })
    expect(peak).toBe(2)
    h.pty.generateName.mockRejectedValueOnce(new Error('Disconnected'))
    expect(await nameAllNodes([node('a')], h.io)).toMatchObject({ failed: 1 })
    expect(useSessionNaming.getState().byId).toEqual({})
  })

  it('keeps manual edits, skips removed/locked nodes and does not apply identical names', async () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')]
    const h = harness(nodes)
    useSessionNaming.getState().tryStart('c')
    h.pty.generateName.mockImplementation(async () => {
      h.current.set('a', { ...nodes[0], title: 'Edited While Naming' })
      h.current.delete('b')
      return { ok: true, message: 'Manual d' }
    })
    const result = await nameAllNodes(nodes, h.io)
    expect(result).toMatchObject({ skipped: 4, changed: 0, failed: 0 })
    expect(h.current.get('a')?.title).toBe('Edited While Naming')
    expect(h.rename).not.toHaveBeenCalled()
    expect(useSessionNaming.getState().byId).toEqual({ c: true })
  })

  it('keeps the original project target when the visible project changes', async () => {
    const original = [node('a')]
    const h = harness(original)
    const other = new Map([['a', node('a', 'terminal', { title: 'Other Project' })]])
    let visible = h.current
    h.pty.generateName.mockImplementation(async () => {
      visible = other
      return { ok: true, message: 'Original Project Name' }
    })
    await nameAllNodes(original, h.io)
    expect(h.current.get('a')?.title).toBe('Original Project Name')
    expect(visible.get('a')?.title).toBe('Other Project')
  })

  it('does not disguise CLI errors as a metadata fallback and reports them', async () => {
    const nodes = [node('a')]
    const h = harness(nodes)
    h.pty.generateName.mockResolvedValue({ ok: false, message: 'Sign in again' })
    const result = await nameAllNodes(nodes, h.io)
    expect(h.pty.generateNodeName).not.toHaveBeenCalled()
    expect(summarizeBulkNaming(result)).toContain('0 renamed, 0 skipped, 1 failed')
    expect(summarizeBulkNaming(result)).toContain('Sign in again')
  })
})

describe('naming context and locks', () => {
  it('includes nested group members once even in a corrupt cycle', () => {
    const nodes = [node('g', 'group', { parentId: 'inner' }), node('inner', 'group', { parentId: 'g' }),
      node('t', 'terminal', { parentId: 'inner' })]
    expect(namingDescendants(nodes, 'g').map((n) => n.id)).toEqual(['inner', 't'])
    expect(namingContext(nodes[0], nodes).details).toContain('terminal: Manual t')
  })

  it('uses note text, file/URL and trigger/run metadata without opening resources', () => {
    const n = node('note', 'sticky', { text: 'Release checklist', filePath: '/tmp/report', url: 'https://example.com',
      runConfig: { name: 'Tests' } as never, trigger: { payload: 'Review release' } as never })
    const context = namingContext(n, [n])
    for (const text of ['Release checklist', '/tmp/report', 'https://example.com', 'Tests', 'Review release']) {
      expect(context.details).toContain(text)
    }
  })

  it('shares the node lock between all entry points and prevents overlapping batches across project switches', () => {
    const s = useSessionNaming.getState()
    expect(s.tryStart('a')).toBe(true)
    expect(s.tryStart('a')).toBe(false)
    s.set('a', false)
    expect(s.tryStart('a')).toBe(true)
    expect(s.tryStartBatch('one')).toBe(true)
    expect(s.tryStartBatch('two')).toBe(false)
    s.finishBatch()
    expect(s.tryStartBatch('two')).toBe(true)
  })
})
