import { promises as fs } from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testTmpDir } from './test-tmp'
import { ProjectMemoryService, registerProjectMemory, type MemoryResolver } from './project-memory'
import { emptyCheckpoint, emptyDecision, MEMORY_PACKET_MAX, type MemoryResult } from '../shared/project-memory'
import type { CorePlatform } from './platform'

let root: string
let resolver: MemoryResolver
let service: ProjectMemoryService
const selection = { nodeId: 'agent-a' }
function value<T>(r: MemoryResult<T>): T { if (!r.ok) throw new Error(r.error); return r.value }
const decision = () => ({ ...emptyDecision(), title: 'Use local storage', decision: 'Store decisions alongside the project.', rationale: 'Keep context portable.', constraints: 'Local Desktop only.', alternatives: 'A private database was rejected.', sources: [{ kind: 'file' as const, location: 'design.md', label: 'Design discussion', excerpt: 'Keep it with the repository.' }] })
const checkpoint = () => ({ ...emptyCheckpoint(), goal: 'Ship durable project memory', completed: 'Storage implemented', remaining: 'Review UI', attempts: 'An in-memory store lost state after restart.', nextStep: 'Test the handoff.', sources: decision().sources })
beforeEach(() => {
  root = testTmpDir('project-memory-')
  resolver = {
    project: (p, nodeId) => p === 'p' ? { root, ...(nodeId ? { node: { cwd: root, title: 'Memory task', author: 'codex' } } : {}) } : undefined,
    projectForNode: (n) => n.startsWith('agent-') ? 'p' : undefined
  }
  service = new ProjectMemoryService(resolver)
})

describe('project decision memory and task handoff', () => {
  it('hands approved decisions and state to another agent after restart and moving the folder', async () => {
    let view = value(await service.propose('p', selection, decision(), 0, 'codex'))
    expect(value(await service.prepare('agent-a')).body).toBe('')
    view = value(await service.review('p', selection, 'project', view.project.decisions[0].id, 'approve', view.project.revision))
    view = value(await service.checkpoint('p', selection, checkpoint(), 0, 'codex'))
    const taskId = view.task!.id
    value(await service.bind('p', taskId, 'agent-b'))
    const moved = path.join(testTmpDir('project-memory-moved-'), 'renamed')
    await fs.rename(root, moved); root = moved
    service = new ProjectMemoryService(resolver)
    const next = value(await service.read('p', { nodeId: 'agent-b' }))
    expect(next.task?.id).toBe(taskId)
    expect(next.task?.checkpoints[0].author).toBe('codex')
    const packet = value(await service.prepare('agent-b'))
    expect(packet.body).toContain('Ship durable project memory')
    expect(packet.body).toContain('Test the handoff.')
    expect(packet.body).toContain('Use local storage')
    expect(packet.body).toContain('in-memory store lost state')
    expect(packet.filePath?.startsWith(moved)).toBe(true)
    expect(await fs.readFile(packet.filePath!, 'utf8')).toBe(packet.body)
    expect(value(await service.read('p')).tasks).toHaveLength(1)
    const missing = await service.source('p', decision().sources[0])
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('unavailable') })
    expect(next.project.decisions[0].sources[0].excerpt).toContain('repository')
  })
  it('preserves approvals until a replacement is approved, and retains withdrawn/rejected history', async () => {
    let v = value(await service.propose('p', {}, decision(), 0))
    const first = v.project.decisions[0].id
    v = value(await service.review('p', {}, 'project', first, 'approve', v.project.revision))
    v = value(await service.propose('p', {}, { ...decision(), title: 'Revision', replaces: first }, v.project.revision))
    expect(v.project.decisions[0].status).toBe('approved')
    const second = v.project.decisions[1].id
    v = value(await service.review('p', {}, 'project', second, 'approve', v.project.revision))
    expect(v.project.decisions.map((d) => d.status)).toEqual(['superseded', 'approved'])
    expect(await service.review('p', {}, 'project', second, 'withdraw', 0)).toMatchObject({ ok: false, error: expect.stringContaining('Reload') })
    v = value(await service.review('p', {}, 'project', second, 'withdraw', v.project.revision))
    v = value(await service.propose('p', {}, decision(), v.project.revision))
    v = value(await service.review('p', {}, 'project', v.project.decisions[2].id, 'reject', v.project.revision))
    expect(v.project.decisions.map((d) => d.status)).toEqual(['superseded', 'withdrawn', 'rejected'])
  })
  it('serializes simultaneous writes and refuses stale checkpoints without losing history', async () => {
    value(await service.checkpoint('p', selection, checkpoint(), 0, 'codex'))
    const other = new ProjectMemoryService(resolver)
    const results = await Promise.all([service.checkpoint('p', selection, { ...checkpoint(), completed: 'A' }, 1), other.checkpoint('p', selection, { ...checkpoint(), completed: 'B' }, 1)])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(value(await service.read('p', selection)).task?.checkpoints).toHaveLength(2)
  })
  it('isolates task decisions, rejects rebinding, and does not invent missing state', async () => {
    let v = value(await service.propose('p', selection, { ...decision(), scope: 'task' }, 0))
    v = value(await service.review('p', selection, 'task', v.task!.decisions[0].id, 'approve', v.task!.revision))
    expect(value(await service.packet('p', selection)).body).toContain('not recorded')
    const other = value(await service.packet('p', { nodeId: 'agent-c' }))
    expect(other.body).not.toContain('Use local storage')
    expect(await service.bind('p', other.taskId!, 'agent-a')).toMatchObject({ ok: false })
    expect(await service.read('p', { taskId: 'foreign-task' })).toMatchObject({ ok: false })
  })
  it('reads bounded source previews and blocks traversal and symlink escape', async () => {
    await fs.writeFile(path.join(root, 'design.md'), 'The original source.')
    expect(value(await service.source('p', decision().sources[0]))).toContain('original source')
    const outside = testTmpDir('memory-source-outside-')
    await fs.writeFile(path.join(outside, 'secret'), 'not project data')
    await fs.symlink(path.join(outside, 'secret'), path.join(root, 'linked.md'))
    expect(await service.source('p', { ...decision().sources[0], location: 'linked.md' })).toMatchObject({ ok: false, error: expect.stringContaining('outside') })
    expect(await service.propose('p', {}, { ...decision(), sources: [{ ...decision().sources[0], location: '../secret' }] }, 0)).toMatchObject({ ok: false })
  })
  it('does not overwrite corrupt storage or follow memory directory symlinks', async () => {
    const directory = path.join(root, '.nodeterm', 'memory')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'project.json'), '{broken')
    expect(await service.propose('p', {}, decision(), 0)).toMatchObject({ ok: false })
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe('{broken')
    root = testTmpDir('project-memory-symlink-')
    await fs.mkdir(path.join(root, '.nodeterm'))
    await fs.symlink(directory, path.join(root, '.nodeterm', 'memory'))
    expect(await service.read('p')).toMatchObject({ ok: false, error: expect.stringContaining('symlinks') })
  })
  it('resolves an immutable Git source even after the working copy is removed', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, TMPDIR: root } }).trim()
    git('init')
    await fs.writeFile(path.join(root, 'design.md'), 'Original decision rationale')
    git('add', 'design.md')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Source')
    const commit = git('rev-parse', 'HEAD')
    await fs.unlink(path.join(root, 'design.md'))
    const source = { ...decision().sources[0], location: 'design.md:1', commit }
    expect(value(await service.source('p', source))).toContain('Original decision rationale')
    const view = value(await service.propose('p', {}, { ...decision(), sources: [source] }, 0))
    expect(view.project.decisions[0].sources[0].commit).toBe(commit)
    expect(await service.source('p', { ...source, commit: '--help' })).toMatchObject({ ok: false })
    expect(await service.source('p', { ...source, commit: '0'.repeat(40) })).toMatchObject({ ok: false, error: expect.stringContaining('saved excerpt') })
  })
  it('keeps packet budget bounded, includes only approved records, and marks omissions', async () => {
    for (let i = 0; i < 15; i++) {
      let v = value(await service.read('p'))
      v = value(await service.propose('p', {}, { ...decision(), title: `Decision ${i}`, decision: 'details '.repeat(450), constraints: 'constraints '.repeat(250) }, v.project.revision))
      value(await service.review('p', {}, 'project', v.project.decisions.at(-1)!.id, 'approve', v.project.revision))
    }
    const revision = value(await service.read('p')).project.revision
    value(await service.propose('p', {}, { ...decision(), title: 'UNAPPROVED SECRET' }, revision))
    value(await service.checkpoint('p', selection, checkpoint(), 0))
    const packet = value(await service.packet('p', selection))
    expect(packet.body.length).toBeLessThanOrEqual(MEMORY_PACKET_MAX)
    expect(packet.body).toContain('omitted')
    expect(packet.body).not.toContain('UNAPPROVED SECRET')
    expect(packet.body).toContain('Test the handoff.')
  })
  it('verifies agent identity and never accepts an approval action or foreign task from input', async () => {
    expect(await service.control('p', 'agent-a', { action: 'read' }, false)).toMatchObject({ ok: false })
    const file = path.join(root, 'proposal.json')
    await fs.writeFile(file, JSON.stringify({ expectedRevision: 0, decision: { ...decision(), status: 'approved', author: 'User' }, taskId: 'foreign' }))
    expect(await service.control('p', 'agent-a', { action: 'propose', file }, true)).toMatchObject({ ok: true })
    expect(value(await service.read('p')).project.decisions[0]).toMatchObject({ status: 'proposed', author: 'codex' })
    expect(await service.control('p', 'agent-a', { action: 'approve' }, true)).toMatchObject({ ok: false })
    expect(await service.read('ssh')).toMatchObject({ ok: false, unsupported: true })
  })
  it('denies memory IPC, including review, to nonlocal clients', async () => {
    const handlers = new Map<string, (...args: any[]) => any>()
    registerProjectMemory({ handleWithSender: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn), isLocalClient: (sender: unknown) => sender === 'desktop' } as unknown as CorePlatform, service)
    const spy = vi.spyOn(service, 'review')
    expect(await handlers.get('project-memory:review')!('relay', 'p', {}, 'project', 'id', 'approve', 0)).toMatchObject({ ok: false, unsupported: true })
    expect(spy).not.toHaveBeenCalled()
    expect(await handlers.get('project-memory:read')!('desktop', 'p')).toMatchObject({ ok: true })
  })
})
