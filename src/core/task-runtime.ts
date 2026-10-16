import { randomUUID } from 'node:crypto'
import { promises as fs, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { TaskService } from './task-service'
import { launchBackgroundAgent } from './background-agent'
import type { WorkflowRuntimeDeps } from './workflow-runtime'
import { mirrorEntry } from './agent-status-mirror'
import { isLaunchShell } from '../shared/agents/pane'
import { readinessHead } from './readiness-git'
import { materializeSharedPaths } from './worktree-shared-paths'
import { IPC } from '../shared/ipc'
import { taskBoardPreference } from '../shared/tasks'
import { AGENT_CONFIG, capabilityAgentId, canControlCanvas, hasHooks, type BuiltinAgentId } from '../shared/agents/config'
import { resolveAgentConfig } from '../shared/agents/custom-agent'
import { isAgentIntegrationEnabled } from '../shared/agent-integrations'
import { resolveProjectSettings } from '../shared/project-settings'
import { computeWorktreePath, effectiveWorktreeTemplate, effectiveWorktreeBaseRef } from '../shared/worktree'

/** Desktop owner boundary. Remote peers receive neither task files nor execution controls. */
export function createTaskRuntime(d: WorkflowRuntimeDeps): TaskService {
  const identityFile = path.join(d.platform.userDataDir, 'task-host-id')
  mkdirSync(d.platform.userDataDir, { recursive: true })
  try { writeFileSync(identityFile, randomUUID(), { flag: 'wx', mode: 0o600 }) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  const hostId = readFileSync(identityFile, 'utf8').trim()
  if (!/^[a-f0-9-]{36}$/.test(hostId)) throw new Error('The local task host identity is invalid.')
  const project = async (id: string) => {
    if (d.ownsDurableState === false) throw new Error('Another app instance owns task orchestration. Use that instance to inspect or control tasks.')
    const p = (await d.workspaceStore.load({ sideline: false })).projects.find(p => p.id === id)
    if (!p?.cwd || p.remote || p.ssh || p.unavailable) throw new Error('Tasks require an available local Desktop project.')
    return p
  }
  const enabled = (id: string) => taskBoardPreference(d.settings(), id).enabled
  const checkCheckout = async (id: string, task: import('../shared/tasks').TaskRecord) => {
    const p = await project(id); const w = task.checkout
    if (!w || w.hostId !== hostId) throw new Error('This checkout belongs to another host.')
    if (!(await fs.stat(w.cwd)).isDirectory()) throw new Error('The task checkout is missing.')
    if (w.branch) {
      if (await d.gitService.repoRoot(p.cwd!) !== w.repoPath) throw new Error('The task repository has moved.')
      const list = await d.gitService.worktreeList(w.repoPath!)
      if (!list.ok || !list.entries.some(e => path.resolve(e.path) === path.resolve(w.cwd) && e.branch === w.branch && !e.prunable)) throw new Error('The task worktree is missing or has changed branch.')
    } else if (path.resolve(w.cwd) !== path.resolve(p.cwd!) && !p.nodes.some(n => task.runs.some(r => r.nodeId === n.id) && !n.ssh && !n.sshRemoteTmux && n.cwd && path.resolve(n.cwd) === path.resolve(w.cwd))) throw new Error('This checkout is not associated with a local session in this project.')
  }
  const setup = async (id: string, task: import('../shared/tasks').TaskRecord) => {
    const p = await project(id); const w = task.checkout!
    if (w.branch && w.groupId) {
      const snap = await d.workspaceStore.readProjectSettings(id)
      const defaults = resolveProjectSettings(snap?.local, snap?.shared ?? undefined)
      const shared = await materializeSharedPaths(w.repoPath!, w.cwd, defaults.worktree.sharedPaths?.value ?? [])
      if (shared.some(r => r.status === 'error' || r.status === 'skipped-unsafe')) throw new Error('A shared worktree path could not be linked safely.')
      await d.workspaceStore.editWorkflowProject(id, current => {
        if (current.nodes.some(n => n.id === w.groupId)) return
        const x = Math.max(0, ...current.nodes.filter(n => !n.parentId).map(n => n.position.x + n.size.width)) + 80
        current.nodes.push({ id: w.groupId!, kind: 'group', title: task.title, position: { x, y: 80 }, size: { width: 980, height: 620 }, color: '#10a37f', group: null,
          worktree: { repoPath: w.repoPath!, branch: w.branch!, path: w.cwd, baseRef: w.baseCommit!, createdByApp: true } })
      })
    }
    await d.projectSetupService.runAndWait({ projectId: id, projectName: p.name, rootPath: p.cwd!, worktreePath: w.branch ? w.cwd : undefined })
  }
  const service: TaskService = new TaskService({
    hostId,
    root: async id => (await project(id)).cwd!,
    checkCheckout,
    node: async (id, nodeId) => {
      const p = await project(id); const n = p.nodes.find(n => n.id === nodeId)
      if (!n || n.kind && n.kind !== 'terminal' || !n.agentId) return undefined
      return { cwd: n.cwd || p.cwd!, agentId: n.agentId, remote: !!(n.ssh || n.sshRemoteTmux) }
    },
    state: id => { const m = mirrorEntry(id); return m ? { state: m.state, verified: m.stateVerified } : undefined },
    settled: async id => { const m = mirrorEntry(id); return m?.state === 'done' && m.stateVerified === true && !m.idleInferred || !await d.ptyManager.sessionExists(id) || isLaunchShell(await d.ptyManager.paneCommand(id)) },
    validate: (agentId, accountId) => {
      if (!d.available() || d.ownsDurableState === false) throw new Error('Agent control is unavailable on this host. Check status hooks and canvas control.')
      const settings = d.settings(); const custom = settings.customAgents.find(a => a.id === agentId)
      if (!AGENT_CONFIG[agentId as BuiltinAgentId] && !custom) throw new Error('Choose an available agent.')
      if (!hasHooks(agentId) || !canControlCanvas(agentId) || !isAgentIntegrationEnabled(settings, capabilityAgentId(agentId))) throw new Error('Enable agent status hooks and canvas control before starting a task.')
      if (resolveAgentConfig(agentId, custom).promptInjectionMode === 'stdin-after-start') throw new Error('This agent cannot receive a task brief at launch.')
      if (!d.ptyManager.persistentSpawnAvailable()) throw new Error('Enable persistent sessions to run tasks in the background.')
      if (accountId && (capabilityAgentId(agentId) !== 'claude' || !settings.claudeAccounts.some(a => a.id === accountId && !a.host && !a.pending))) throw new Error('Choose an available local account.')
    },
    limit: id => taskBoardPreference(d.settings(), id).maxConcurrent,
    changed: id => { for (const client of d.platform.clientIds()) if (d.platform.isLocalClient?.(client)) d.platform.sendTo(client, IPC.tasksChanged, id) },
    prepare: async (id, task, workspace) => {
      if (!enabled(id)) throw new Error('The task board is disabled for this project.')
      const p = await project(id)
      if (task.checkout) {
        await checkCheckout(id, task); await setup(id, task)
        return task.checkout
      }
      const root = await d.gitService.repoRoot(p.cwd!)
      if (!root || workspace === 'current') {
        let baseCommit: string | undefined
        if (root) baseCommit = (await readinessHead(p.cwd!)).head
        const checkout = { cwd: p.cwd!, repoPath: root ?? undefined, baseCommit, hostId }
        await setup(id, { ...task, checkout }); return checkout
      }
      const snap = await d.workspaceStore.readProjectSettings(id)
      const defaults = resolveProjectSettings(snap?.local, snap?.shared ?? undefined)
      const values = { basePath: defaults.worktree.basePath?.value, baseRef: defaults.worktree.baseRef?.value }
      const list = await d.gitService.worktreeList(root)
      if (!list.ok) throw new Error('The repository worktrees could not be read.')
      const branch = `task/${task.id}`
      const cwd = computeWorktreePath(root, branch, effectiveWorktreeTemplate(values, d.settings().worktreePathTemplate))
      if (!cwd) throw new Error('The worktree path template is invalid.')
      const baseRef = effectiveWorktreeBaseRef(values, list.entries)
      const added = await d.gitService.worktreeAdd(root, cwd, branch, baseRef, true)
      if (!added.ok) throw new Error(added.message ?? 'The task worktree could not be created.')
      const checkout = { cwd, branch, repoPath: root, groupId: `task-group-${task.id}`, baseCommit: (await readinessHead(cwd)).head, hostId }
      // Persist the checkout before optional setup: a failed setup must not orphan a worktree.
      await service.rememberCheckout(id, task.id, checkout)
      await setup(id, { ...task, checkout })
      return checkout
    },
    launch: async (id, task, run, brief, mayDeliver) => {
      const p = await project(id)
      const accountId = run.accountId ?? (capabilityAgentId(run.agentId) === 'claude' ? p.defaultAccountId : undefined)
      service.deps.validate(run.agentId, accountId)
      await launchBackgroundAgent(d, p, { cwd: task.checkout!.cwd, groupId: task.checkout!.groupId,
        nodeId: run.nodeId, title: `${task.title} · ${run.role}`, agentId: run.agentId, accountId,
        issueRef: task.issueRef, brief, previousNodeIds: task.runs.filter(r => r.id !== run.id).map(r => r.nodeId).concat(task.legacyNodeIds),
        mayDeliver: async () => enabled(id) && d.available() && d.ownsDurableState !== false && await mayDeliver() })
    }
  })
  const register = (channel: string, fn: (...args: any[]) => unknown) => d.platform.handleWithSender(channel, (sender, id, ...args) => {
    if (!d.platform.isLocalClient?.(sender) || d.ownsDurableState === false || typeof id !== 'string' || !enabled(id)) return { ok: false, error: 'Task boards are available only for enabled local Desktop projects.', unsupported: true }
    return fn(id, ...args)
  })
  register(IPC.tasksList, id => service.list(id))
  register(IPC.tasksRead, (id, task) => service.read(id, task))
  register(IPC.tasksCreate, (id, input) => service.create(id, input))
  register(IPC.tasksAct, (id, task, revision, action) => service.act(id, task, revision, action))
  register(IPC.tasksCapture, (id, task, run) => service.capture(id, task, run))
  register(IPC.tasksReport, (id, task, run, summary, evidence) => service.report(id, task, run, summary, evidence))
  register(IPC.tasksResume, id => service.resumeQueue(id))
  register(IPC.tasksDiff, (id, task) => service.diff(id, task))
  // Recover bindings even if the board is hidden, so existing sessions can submit results.
  if (d.ownsDurableState !== false) void d.workspaceStore.load({ sideline: false }).then(async ws => { for (const p of ws.projects) if (enabled(p.id) && !p.ssh && !p.remote && p.cwd) await service.list(p.id) }).catch(e => console.error('[tasks] recovery:', e))
  return service
}
