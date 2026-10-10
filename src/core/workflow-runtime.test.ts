import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createWorkflowRuntime, type WorkflowRuntimeDeps } from './workflow-runtime'
import { WorkspaceStore } from './workspace-store'
import { GitService } from './git-service'
import { WorkflowRunStore } from './workflow-store'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { DEFAULT_SETTINGS, type Project } from '../shared/types'
import { builtinWorkflows, currentWorkflowAttempt } from '../shared/workflows'
import type { WorkflowResult, WorkflowRun } from '../shared/workflows'
import { IPC } from '../shared/ipc'

const facts = vi.hoisted(() => ({ states: new Map<string, { state: string; stateVerified: boolean }>(), launches: [] as string[] }))
vi.mock('./agent-status-mirror', () => ({ mirrorEntry: (id: string) => facts.states.get(id) }))
vi.mock('./claude-cli', () => ({ claudeCliCaps: async () => ({ autoPermissionMode: false, sessionIdFlag: true }) }))
vi.mock('./grok-cli', () => ({ grokCliCaps: async () => ({ sessionIdFlag: false }) }))
vi.mock('./codex-cli', () => ({ codexCliCaps: async () => ({ approvalValues: null, noDaemon: false }) }))
vi.mock('./codex-identity-caps', () => ({ codexIdentityCaps: async () => ({ shared: false }) }))
vi.mock('./git-env', () => ({ gitEnv: () => process.env }))
vi.mock('./headless-launch', () => ({ launchHeadless: async (deps: { mayDeliver(): Promise<boolean> }, req: { command: string }) => {
  if (!await deps.mayDeliver()) return { outcome: 'failed', reason: 'cancelled' }
  facts.launches.push(req.command)
  return { outcome: 'delivered', fresh: true }
} }))

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-workflows-'))
  vi.stubEnv('TMPDIR', root) // Apple git's xcrun cache belongs to this test's scratch directory.
  facts.launches = []; facts.states.clear()
})
afterEach(async () => { resetPlatformForTests(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }) })

describe('host workflow integration', () => {
  it.skipIf(process.platform === 'win32')('creates one real worktree, persists linked stages and never commits or pushes the run', async () => {
    const repo = path.join(root, 'repo'); await fs.mkdir(repo)
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
    git('init', '-b', 'main')
    await fs.writeFile(path.join(repo, 'code.txt'), 'base\n')
    git('add', 'code.txt'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Base')
    const head = git('rev-parse', 'HEAD')
    const platform = fakePlatform({ userDataDir: path.join(root, 'data'), isOwnerClient: id => id === 1 })
    await fs.mkdir(platform.userDataDir)
    platform.clients.push(1, 2); initPlatform(platform)
    const store = new WorkspaceStore()
    const workflows = builtinWorkflows('claude'); workflows.templates[0].steps = workflows.templates[0].steps.slice(0, 2)
    const p: Project = { id: 'project', name: 'Test', cwd: repo, nodes: [], color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, workflows }
    await store.save({ version: 2, activeProjectId: p.id, projects: [p] })
    const outcomes = new Map()
    const deps: WorkflowRuntimeDeps = { platform, workspaceStore: store, gitService: new GitService(),
      memoryPacket: vi.fn(async () => ({ ok: true as const, value: { body: 'Approved memory', filePath: path.join(repo, '.nodeterm/memory/packets/context.md') } })),
      settings: () => ({ ...DEFAULT_SETTINGS, agentIntegrations: { agents: { claude: 'enabled' } } }), available: () => true,
      outcome: id => outcomes.get(id), held: () => false,
      ptyManager: { persistentSpawnAvailable: () => true, sessionExists: async () => true, paneCommand: async () => 'zsh',
        createHeadless: vi.fn(), onOutput: () => () => {}, writeHeadless: () => true, releaseHeadless: () => {} },
      projectSetupService: { runAndWait: vi.fn(async () => {}), ensureFamilyTrusted: vi.fn(async () => true) }
    }
    const service = createWorkflowRuntime(deps)
    const result = await platform.handlers[IPC.workflowsStart](1, p.id, 'fix-bug', { owner: 'o', repo: 'r', number: 42 }) as WorkflowResult<WorkflowRun>
    expect(result.ok).toBe(true)
    await vi.waitFor(() => expect(facts.launches).toHaveLength(1))
    let run = (await service.list(p.id))[0]
    expect(run.worktree?.branch).toContain('issue-42-wf-')
    expect(git('worktree', 'list', '--porcelain').match(/worktree /g)).toHaveLength(2)
    const first = currentWorkflowAttempt(run)!.nodeId
    facts.states.set(first, { state: 'working', stateVerified: true })
    service.onAgentEvent({ nodeId: first, agentId: 'claude', kind: 'state', state: 'working', newTurn: true, verified: true })
    await service.idle()
    outcomes.set(first, { nodeId: first, outcome: 'succeeded', at: Date.now() + 1 })
    facts.states.set(first, { state: 'done', stateVerified: true })
    service.onAgentEvent({ nodeId: first, agentId: 'claude', kind: 'state', state: 'done', verified: true })
    await vi.waitFor(() => expect(facts.launches).toHaveLength(2))
    run = (await service.list(p.id))[0]
    const second = currentWorkflowAttempt(run)!.nodeId
    const current = (await store.load({ sideline: false })).projects[0]
    expect(current.nodes.filter(n => n.kind === 'terminal')).toHaveLength(2)
    expect(current.nodes.filter(n => n.kind === 'terminal').every(n => n.workflowManaged && n.cwd === run.worktree!.path && n.parentId === run.groupId)).toBe(true)
    expect(current.bridges).toContainEqual(expect.objectContaining({ source: first, target: second, reader: second }))
    const brief = await fs.readFile(path.join(platform.userDataDir, 'orchestration-state', 'workflow-briefs', `${second}.md`), 'utf8')
    expect(brief).toContain(first); expect(brief).toContain('report-outcome --outcome succeeded')
    expect(brief).toContain('GitHub issue o/r#42')
    expect(brief).toContain('First read project memory at')
    expect(brief).toContain('.nodeterm/memory/packets/context.md')
    expect(deps.memoryPacket).toHaveBeenCalledTimes(2)
    expect(facts.launches[1]).toContain('$(cat ')
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(git('rev-parse', run.worktree!.branch)).toBe(head)
    expect(platform.sent.filter(e => e.channel === IPC.workflowsChanged).every(e => e.to === 1)).toBe(true)
    const shared = await fs.readFile(path.join(repo, '.nodeterm', 'project.json'), 'utf8')
    expect(shared).toContain('"workflows"'); expect(shared).not.toContain('"attempts"')
    expect((await new WorkflowRunStore(platform.userDataDir).load())[0].attempts).toHaveLength(2)
    const refused = await platform.handlers[IPC.workflowsStart](2, p.id, 'fix-bug', { owner: 'o', repo: 'r', number: 43 })
    expect(refused).toMatchObject({ ok: false })
    expect(await platform.handlers[IPC.workflowsList](2, p.id)).toEqual([])
    service.stop()
  })
})
