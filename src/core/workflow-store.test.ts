import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WorkflowRunStore } from './workflow-store'
import { builtinWorkflows, type WorkflowRun } from '../shared/workflows'
import { projectToFile, fileToProject } from './workspace-files'
import type { Project } from '../shared/types'
import { WorkspaceStore } from './workspace-store'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { IPC } from '../shared/ipc'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-wf-store-')) })
afterEach(async () => { resetPlatformForTests(); await fs.rm(dir, { recursive: true, force: true }) })
const run = (id: string, state: WorkflowRun['state'] = 'paused', updatedAt = 1): WorkflowRun => ({
  id, projectId: 'p', groupId: `group-${id}`, issueRef: { owner: 'o', repo: 'r', number: 1 },
  template: builtinWorkflows('claude').templates[0], state, stepIndex: 0, attempts: [], createdAt: 1, updatedAt
})

describe('workflow storage boundaries', () => {
  it('merges core additions into a stale autosave and permits an explicit later removal', async () => {
    const data = path.join(dir, 'data'), cwd = path.join(dir, 'repo')
    await fs.mkdir(data); await fs.mkdir(cwd)
    const platform = fakePlatform({ userDataDir: data }); initPlatform(platform)
    const store = new WorkspaceStore(); store.registerIpc()
    const p: Project = { id: 'p', name: 'P', cwd, color: '#fff', nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }
    const stale = { version: 2 as const, activeProjectId: 'p', projects: [p] }
    await store.save(stale)
    await store.editWorkflowProject('p', project => {
      project.workflows = builtinWorkflows('claude')
      project.nodes = [...project.nodes, { id: 'stage', kind: 'terminal', title: 'Stage', color: '#fff', group: null, workflowManaged: true,
        position: { x: 20, y: 20 }, size: { width: 640, height: 400 } }]
    })
    await platform.handlers[IPC.workspaceSave](stale)
    const merged = await store.load({ sideline: false })
    expect(merged.projects[0].nodes.map(n => n.id)).toEqual(['stage'])
    expect(merged.projects[0].workflows?.templates).toHaveLength(3)
    store.acknowledgeWorkflowRemoval('p', 'stage')
    await platform.handlers[IPC.workspaceSave]({ ...merged, projects: [{ ...merged.projects[0], nodes: [] }] })
    expect((await store.load({ sideline: false })).projects[0].nodes).toEqual([])
  })
  it('round trips definitions in project.json and keeps older/malformed projects inert', () => {
    const base: Project = { id: 'p', name: 'Project', color: '#fff', cwd: '/repo', nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }
    const p = { ...base, workflows: builtinWorkflows('claude') }
    const file = projectToFile(p, 1, '2026-10-08T00:00:00Z')
    expect(fileToProject(file, base).workflows).toEqual(p.workflows)
    expect(JSON.stringify(file)).not.toContain('attempts')
    expect(fileToProject(projectToFile(base, 1, ''), base).workflows).toBeUndefined()
    expect(fileToProject({ ...file, workflows: { templates: [{ id: 'bad' }] } } as never, base).workflows).toBeUndefined()
  })
  it('atomically round trips private history with owner-only file permissions', async () => {
    const store = new WorkflowRunStore(dir)
    expect(await store.load()).toEqual([])
    await store.save([run('a')]); expect(await store.load()).toEqual([run('a')])
    const file = path.join(dir, 'orchestration-state', 'workflow-runs.json')
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(await fs.readdir(path.dirname(file))).toEqual(['workflow-runs.json'])
  })
  it('preserves unreadable or malformed history rather than authorizing a replay', async () => {
    const store = new WorkflowRunStore(dir)
    const file = path.join(dir, 'orchestration-state', 'workflow-runs.json')
    await fs.mkdir(path.dirname(file))
    const broken = '{"version":1,"runs":['
    await fs.writeFile(file, broken)
    await expect(store.load()).rejects.toThrow('left untouched')
    expect(await fs.readFile(file, 'utf8')).toBe(broken)
    await fs.writeFile(file, JSON.stringify({ version: 1, runs: [{ ...run('a'), stepIndex: 300 }] }))
    await expect(store.load()).rejects.toThrow('invalid')
  })
  it('retains every unfinished run and the latest 200 finished runs', async () => {
    const store = new WorkflowRunStore(dir)
    const history = Array.from({ length: 210 }, (_, i) => run(`done-${i}`, 'completed', i))
    await store.save([run('active'), ...history])
    const restored = await store.load()
    expect(restored).toHaveLength(201)
    expect(restored.some(r => r.id === 'active')).toBe(true)
    expect(restored.some(r => r.id === 'done-0')).toBe(false)
    expect(restored.some(r => r.id === 'done-209')).toBe(true)
  })
})
