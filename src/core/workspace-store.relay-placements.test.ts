// `relayNodePlacements` is what the relay host's attach decides WHERE a phone-opened session runs
// from (core/relay-attach-plan.ts). It must answer EVERY project holding the id — the same committed
// canvas opened in two folders shares node ids — with the node as THAT project recorded it and a
// local ref's portable cwd resolved, because the attach spawns in that cwd.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { testTmpDir } from './test-tmp'
import { WorkspaceStore } from './workspace-store'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'

const node = (id: string, extra: Partial<CanvasNodeState> = {}): CanvasNodeState =>
  ({ id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: id, color: '#fff', group: null, ...extra }) as CanvasNodeState
const project = (id: string, cwd: string | undefined, nodes: CanvasNodeState[]): Project => ({
  id,
  name: id,
  color: '#7aa2f7',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes,
  ...(cwd ? { cwd } : {})
})
const ws = (projects: Project[]): Workspace => ({ version: 2, activeProjectId: projects[0]?.id ?? '', projects })

beforeEach(() => {
  initPlatform(fakePlatform({ userDataDir: testTmpDir('nt-rp-ws-') }))
})
afterEach(() => resetPlatformForTests())

describe('WorkspaceStore.relayNodePlacements', () => {
  it('answers every project holding the id, with that project’s record and a resolved cwd', async () => {
    const [a, b] = [testTmpDir('nt-rp-a-'), testTmpDir('nt-rp-b-')]
    const store = new WorkspaceStore()
    await store.save(
      ws([
        project('pa', a, [node('shared', { cwd: path.join(a, 'sub'), agentId: 'claude' })]),
        project('pb', b, [node('shared', { agentId: 'codex' }), node('only-b')]),
        project('inline', undefined, [node('only-inline')])
      ])
    )
    const shared = store.relayNodePlacements('shared')
    expect(shared.map((p) => p.projectId)).toEqual(['pa', 'pb'])
    // The shared file stores `./sub`; the attach must spawn in the absolute folder.
    expect(shared[0].node.cwd).toBe(path.join(a, 'sub'))
    expect(shared[0].node.agentId).toBe('claude')
    expect(shared[1].node.agentId).toBe('codex')
    expect(shared.every((p) => p.projectServer === undefined)).toBe(true)
    expect(store.relayNodePlacements('only-inline').map((p) => p.projectId)).toEqual(['inline'])
    expect(store.relayNodePlacements('nope')).toEqual([])
  })
})
