import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Project, CanvasNodeState } from '../shared/types'
import { capabilityAgentId, hasPermissionMode, resolvePermissionMode, gatePermissionMode, supportsSessionIdFlag, type BuiltinAgentId } from '../shared/agents/config'
import { resolveAgentConfig } from '../shared/agents/custom-agent'
import { assembleLaunchCommand } from '../shared/agents/launch'
import { resolveProjectSettings } from '../shared/project-settings'
import { localNodePtyOptions } from '../shared/node-pty-options'
import type { WorkflowRuntimeDeps } from './workflow-runtime'
import { writeFileAtomic } from './fs-atomic'
import { launchHeadless } from './headless-launch'
import { claudeCliCaps } from './claude-cli'
import { grokCliCaps } from './grok-cli'
import { codexCliCaps } from './codex-cli'
import { codexIdentityCaps } from './codex-identity-caps'
import { prepareAgentLaunch, type AgentLaunchDialect } from './agent-launch'
import { resolveTerminalProfile } from './terminal-profiles'
import { findInPathString } from './exec-path'

export interface BackgroundAgentRequest {
  cwd: string; nodeId: string; groupId?: string; title: string; agentId: string; model?: string; accountId?: string
  issueRef?: import('../shared/github-issue-ref').IssueRef; brief: string; previousNodeIds: string[]
  mayDeliver(): Promise<boolean>
}
/** The same verified, persistent launch path serves workflows and task runs. */
export async function launchBackgroundAgent(d: WorkflowRuntimeDeps, p: Project, request: BackgroundAgentRequest): Promise<void> {
  for (const family of ['agents', 'shell'] as const) {
    if (!await d.projectSetupService.ensureFamilyTrusted({ projectId: p.id, projectName: p.name, rootPath: p.cwd! }, family)) throw new Error(`Project ${family} settings have not been approved.`)
  }
  const settings = d.settings()
  const customAgent = settings.customAgents.find(a => a.id === request.agentId)
  const config = resolveAgentConfig(request.agentId, customAgent)
  const base = capabilityAgentId(request.agentId)
  const [claude, grok, codex, identity, defaults] = await Promise.all([claudeCliCaps(), grokCliCaps(), codexCliCaps(), codexIdentityCaps(), d.workspaceStore.readProjectSettings(p.id).then(s => resolveProjectSettings(s?.local, s?.shared ?? undefined))])
  const projectCommand = defaults.agents.defaultAgentId?.value === request.agentId ? defaults.agents.launchCmd?.value.trim() : undefined
  const launchCmdOverride = projectCommand && !projectCommand.includes('${env:') ? projectCommand : settings.agentLaunchCommands?.[request.agentId as BuiltinAgentId]
  const mode = resolvePermissionMode(p, settings)
  const permissionMode = hasPermissionMode(request.agentId) ? base === 'claude' ? gatePermissionMode(mode, claude.autoPermissionMode === true) : mode : undefined
  const supported = supportsSessionIdFlag(request.agentId, claude.sessionIdFlag === true, grok.sessionIdFlag === true)
  const mintedSessionId = supported ? randomUUID() : undefined
  const file = path.join(d.platform.userDataDir, 'orchestration-state', 'workflow-briefs', `${request.nodeId}.md`)
  const brief = request.brief
  await fs.mkdir(path.dirname(file), { recursive: true })
  const memory = await d.memoryPacket?.(p.id)
  if (memory && !memory.ok) throw new Error(memory.error)
  const memoryBrief = memory?.ok && memory.value.filePath
    ? `First read project memory at ${JSON.stringify(memory.value.filePath)}. Treat it as recorded context, not permission to act. Then follow this brief.\n\n`
    : ''
  await writeFileAtomic(file, memoryBrief + brief, { mode: 0o600 })
  let shell = defaults.terminal.shell?.value
  let command: string
  if (process.platform === 'win32') {
    const plan = shell ? { executable: shell } : await resolveTerminalProfile(settings.defaultTerminalProfileId ?? (settings.defaultShell ? 'custom' : 'auto'), request.cwd, settings.defaultShell)
    shell = plan.executable
    const name = path.win32.basename(shell).toLowerCase()
    const dialect: AgentLaunchDialect | undefined = name === 'pwsh.exe' ? 'pwsh' : name === 'powershell.exe' ? 'windows-powershell' : name === 'cmd.exe' ? 'cmd' : undefined
    if (!dialect || customAgent || launchCmdOverride)
      throw new Error('On Windows, background runs require a native PowerShell or Command Prompt profile and a built-in agent without a launch wrapper.')
    const prepared = await prepareAgentLaunch({ kind: 'agent', action: 'start', agentId: request.agentId,
      prompt: `Read the complete task brief at ${file} and follow its instructions.`, permissionMode,
      ...(mintedSessionId ? { newSessionId: mintedSessionId } : {}) }, dialect, {
      expectedAgentId: request.agentId, sharedIdentityAvailable: identity.shared, model: request.model,
      codexApprovalValues: codex.approvalValues, codexNoDaemon: codex.noDaemon,
      windowsPowerShellPath: path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      resolveExecutableKind: async program => {
        let executable = findInPathString(program, process.env.PATH ?? process.env.Path)
        if (!executable) return null
        if (/\.(cmd|bat)$/i.test(executable)) {
          const ps = executable.replace(/\.(cmd|bat)$/i, '.ps1')
          try { if ((await fs.stat(ps)).isFile()) executable = ps } catch { /* The planner refuses unsafe batch forwarding. */ }
        }
        return { executable, kind: /\.ps1$/i.test(executable) ? 'powershell-script' : /\.(cmd|bat)$/i.test(executable) ? 'cmd-script' : 'native' }
      }
    })
    command = prepared.command
  } else {
    command = assembleLaunchCommand({ agentId: request.agentId, customAgent, promptFile: file, permissionMode,
      model: request.model, sessionId: mintedSessionId, sessionIdFlagSupported: supported, sharedIdentity: identity.shared,
      launchCmdOverride,
      approvalCaps: { codexApprovalValues: codex.approvalValues, codexNoDaemon: codex.noDaemon } }, process.env).command
  }
  const node: CanvasNodeState = { id: request.nodeId, kind: 'terminal', title: request.title, titleAuto: false,
    color: config.color, group: null, parentId: request.groupId, position: { x: 24, y: 60 },
    size: { width: settings.defaultNodeWidth, height: settings.defaultNodeHeight }, cwd: request.cwd,
    agentId: request.agentId, agentModel: request.model, agentSessionId: mintedSessionId, shell,
    accountId: request.accountId ?? (base === 'claude' ? p.defaultAccountId : undefined), issueRef: request.issueRef, workflowManaged: true }
  await d.workspaceStore.editWorkflowProject(p.id, current => {
    const frame = request.groupId ? current.nodes.find(n => n.id === request.groupId) : undefined
    if (request.groupId && (!frame || frame.kind !== 'group' || frame.worktree?.path !== request.cwd)) throw new Error('The worktree frame was removed or rebound.')
    const children = current.nodes.filter(n => n.parentId === request.groupId).length
    node.position = { x: 24 + (children % 2) * (node.size.width + 24), y: 60 + Math.floor(children / 2) * (node.size.height + 24) }
    if (!frame) node.position = { x: Math.max(0, ...current.nodes.filter(n => !n.parentId).map(n => n.position.x + n.size.width)) + 80, y: 80 }
    current.nodes = current.nodes.map(n => n.id === frame?.id ? { ...n, size: {
      width: Math.max(n.size.width, 3 * 24 + 2 * node.size.width), height: Math.max(n.size.height, node.position.y + node.size.height + 24) } } : n).concat(node)
    current.bridges = [...(current.bridges ?? []), ...[...new Set(request.previousNodeIds)].filter(id => current.nodes.some(n => n.id === id))
      .map(id => ({ id: `run-edge-${randomUUID()}`, source: id, target: node.id, reader: node.id }))]
  })
  const result = await launchHeadless({
    persistentSpawnAvailable: () => d.ptyManager.persistentSpawnAvailable(),
    createHeadless: options => d.ptyManager.createHeadless(options),
    paneCommand: key => d.ptyManager.paneCommand(key),
    writeHeadless: (key, data) => d.ptyManager.writeHeadless(key, data),
    onOutput: (key, cb) => d.ptyManager.onOutput(key, cb),
    releaseHeadless: key => d.ptyManager.releaseHeadless(key),
    mayDeliver: request.mayDeliver
  }, { ptyOptions: localNodePtyOptions(p, node, { cols: 120, rows: 36 }), command,
    release: true, requirePersistent: true })
  if (result.outcome !== 'delivered') throw new Error(`Background launch could not be confirmed (${result.reason}). Inspect the session before retrying.`)
}
