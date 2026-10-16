import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createTaskRuntime } from './task-runtime'
import { WorkspaceStore } from './workspace-store'
import { GitService } from './git-service'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { DEFAULT_SETTINGS, type Project } from '../shared/types'
import { latestTaskRun, type TaskReply } from '../shared/tasks'
import { IPC } from '../shared/ipc'
import type { TaskService } from './task-service'

const facts = vi.hoisted(() => ({ launches: [] as Array<{ node: string; cwd: string }>, states: new Map() }))
vi.mock('./agent-status-mirror', () => ({ mirrorEntry: (id: string) => facts.states.get(id) }))
vi.mock('./claude-cli', () => ({ claudeCliCaps: async () => ({ autoPermissionMode: false, sessionIdFlag: true }) }))
vi.mock('./grok-cli', () => ({ grokCliCaps: async () => ({ sessionIdFlag: false }) }))
vi.mock('./codex-cli', () => ({ codexCliCaps: async () => ({ approvalValues: null, noDaemon: false }) }))
vi.mock('./codex-identity-caps', () => ({ codexIdentityCaps: async () => ({ shared: false }) }))
vi.mock('./git-env', () => ({ gitEnv: () => process.env }))
vi.mock('./headless-launch', () => ({ launchHeadless: async (deps: { mayDeliver(): Promise<boolean> }, req: { ptyOptions: { persistKey: string; cwd: string } }) => {
  if (!await deps.mayDeliver()) return { outcome: 'failed', reason: 'cancelled' }
  facts.launches.push({ node: req.ptyOptions.persistKey, cwd: req.ptyOptions.cwd })
  return { outcome: 'delivered', fresh: true }
} }))
const unwrap = <T,>(r: TaskReply<T>): T => { if (!r.ok) throw new Error(r.error); return r.value }
let root: string, service: TaskService | undefined
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-task-runtime-')); facts.states.clear(); facts.launches = [] })
afterEach(async () => { service?.stop(); await service?.idle(); resetPlatformForTests(); await fs.rm(root, { recursive: true, force: true }) })

it('isolates work in a real worktree, retries setup in that checkout, and gates every API to local enabled clients', async () => {
  const repo = path.join(root, 'repo'); await fs.mkdir(repo)
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-b', 'main'); await fs.writeFile(path.join(repo, 'code.txt'), 'base\n'); git('add', 'code.txt'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Base')
  const head = git('rev-parse', 'HEAD'); await fs.writeFile(path.join(repo, 'code.txt'), 'dirty main\n')
  const platform = fakePlatform({ userDataDir: path.join(root, 'data'), isLocalClient: id => id === 1 }); initPlatform(platform); platform.clients.push(1, 2)
  await fs.mkdir(platform.userDataDir)
  const store = new WorkspaceStore()
  const project: Project = { id: 'project', name: 'Test', cwd: repo, nodes: [], color: '#fff', viewport: { x: 0, y: 0, zoom: 1 } }
  await store.save({ version: 2, activeProjectId: project.id, projects: [project] })
  let enabled = true, setupFails = true
  const setup = vi.fn(async () => { if (setupFails) throw new Error('Setup needs attention') })
  service = createTaskRuntime({ platform, workspaceStore: store, gitService: new GitService(),
    settings: () => ({ ...DEFAULT_SETTINGS, taskBoards: { project: { enabled, maxConcurrent: 1 } }, agentIntegrations: { agents: { claude: 'enabled' } } }), available: () => true,
    outcome: () => undefined, held: () => false,
    ptyManager: { persistentSpawnAvailable: () => true, sessionExists: async () => false, paneCommand: async () => 'zsh', createHeadless: vi.fn(), onOutput: () => () => {}, writeHeadless: () => true, releaseHeadless: () => {} },
    projectSetupService: { runAndWait: setup, ensureFamilyTrusted: vi.fn(async () => true) }
  })
  let task = unwrap(await service.create(project.id, { title: 'Implement in isolation' }))
  unwrap(await service.act(project.id, task.id, task.revision, { type: 'start', requestId: 'first', agentId: 'claude', workspace: 'worktree' }))
  await vi.waitFor(async () => expect(latestTaskRun(unwrap(await service!.read(project.id, task.id)).task)?.state).toBe('failed'))
  task = unwrap(await service.read(project.id, task.id)).task
  expect(task.checkout?.cwd).not.toBe(repo)
  expect(await fs.readFile(path.join(task.checkout!.cwd, 'code.txt'), 'utf8')).toBe('base\n')
  expect(git('worktree', 'list', '--porcelain').match(/worktree /g)).toHaveLength(2)
  setupFails = false
  unwrap(await service.act(project.id, task.id, task.revision, { type: 'start', requestId: 'retry', agentId: 'claude', workspace: 'worktree' }))
  await vi.waitFor(() => expect(facts.launches).toHaveLength(1))
  task = unwrap(await service.read(project.id, task.id)).task
  expect(task.runs).toHaveLength(2); expect(facts.launches[0].cwd).toBe(task.checkout!.cwd)
  expect(git('worktree', 'list', '--porcelain').match(/worktree /g)).toHaveLength(2)
  const saved = (await store.load({ sideline: false })).projects[0]
  const node = saved.nodes.find(n => n.id === latestTaskRun(task)!.nodeId)!
  expect(node).toMatchObject({ cwd: task.checkout!.cwd, workflowManaged: true, parentId: task.checkout!.groupId })
  const brief = await fs.readFile(path.join(platform.userDataDir, 'orchestration-state/workflow-briefs', `${node.id}.md`), 'utf8')
  expect(brief).toContain('task --action snapshot'); expect(brief).toContain('The user accepts the result.')
  expect(await platform.handlers[IPC.tasksList](2, project.id)).toMatchObject({ ok: false, unsupported: true })
  expect(platform.sent.filter(e => e.channel === IPC.tasksChanged).every(e => e.to === 1)).toBe(true)
  enabled = false
  expect(await platform.handlers[IPC.tasksList](1, project.id)).toMatchObject({ ok: false })
  expect((await fs.readdir(path.join(repo, '.nodeterm/tasks'))).filter(n => n.endsWith('.json'))).toEqual([`${task.id}.json`])
  expect(git('rev-parse', 'HEAD')).toBe(head)
  expect(await fs.readFile(path.join(repo, 'code.txt'), 'utf8')).toBe('dirty main\n')
  expect(await service.capture(project.id, task.id, 'first')).toMatchObject({ ok: false })
})
