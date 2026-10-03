#!/usr/bin/env node

/**
 * Local field diagnostic for Nodeterm agent sessions. Scanning does not mutate Nodeterm state;
 * the explicit `--append` option writes the metadata-only report chosen by the caller.
 *
 * It joins four independently useful facts:
 *   - the node's persisted launch record (workspace/project files),
 *   - the tmux pane identity (root shell PID, tty, cwd and shallow command),
 *   - the tty foreground process group (the exact agent PID, separate from the shell PID),
 *   - a whitelist of non-secret tmux environment values used by model respawning.
 *
 * Screen text is captured so the interactive `--screens` report can show what the TUI actually
 * displays, but it is NEVER appended to a log. Conversation text does not belong in a durable
 * diagnostics file. This is deliberately a repo-local admin tool, not a canvas-control verb: an
 * agent-facing API that returned every pane would bypass context-link access boundaries.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_SOCKET = 'node-terminal'
const SESSION_PREFIX = 'nt-'
const PANE_SEPARATOR = '\u001f'
const PANE_FORMAT = [
  '#{session_name}',
  '#{pane_pid}',
  '#{pane_tty}',
  '#{pane_current_command}',
  '#{pane_current_path}'
].join(PANE_SEPARATOR)

const SAFE_ENV_KEYS = [
  'NODETERM_AGENT_ID',
  'NODETERM_NODE_ID',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'
]

const EXPECTED_PROCESS = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  opencode: 'opencode',
  grok: 'grok',
  copilot: 'copilot',
  antigravity: 'agy'
}

const SHELL_NAMES = new Set([
  'bash',
  'dash',
  'fish',
  'ksh',
  'nu',
  'pwsh',
  'sh',
  'tcsh',
  'xonsh',
  'zsh'
])

// Interpreters whose next non-option argv slot is the executable script. Keep this narrow: an
// arbitrary argument named `claude` (for example `rg claude README.md`) is not proof that Claude
// owns the foreground process group.
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl'])

const SCREEN_SIGNALS = [
  ['awaiting-confirmation', /ready to code\?|would you like to proceed\?|do you want to proceed/i],
  ['permission-prompt', /allow .*\?|approve|bypass permissions|manual(?:ly)? approve/i],
  ['resume-error', /no conversation found|could not (?:find|resume).*session|invalid session/i],
  ['authentication-error', /authentication (?:failed|error)|invalid api key|unauthorized/i],
  ['command-error', /command not found|not recognized as an internal or external command/i]
]

function defaultUserDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'node-terminal')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'node-terminal')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'node-terminal')
}

function baseName(value) {
  return path.basename(String(value || '')).replace(/^-/, '').toLowerCase()
}

function positiveInt(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 5_000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || String(result.stderr || '').trim() || `exit ${result.status}`
    return { ok: false, stdout: String(result.stdout || ''), error: detail }
  }
  return { ok: true, stdout: String(result.stdout || ''), error: '' }
}

export function parsePaneList(stdout) {
  const panes = []
  for (const line of String(stdout || '').split('\n')) {
    if (!line) continue
    const [session, rawShellPid, tty, paneCommand, ...cwdParts] = line.split(PANE_SEPARATOR)
    const shellPid = positiveInt(rawShellPid)
    if (!session || !shellPid || !tty) continue
    panes.push({
      session,
      nodeId: session.startsWith(SESSION_PREFIX) ? session.slice(SESSION_PREFIX.length) : undefined,
      shellPid,
      tty,
      paneCommand: paneCommand || '',
      cwd: cwdParts.join(PANE_SEPARATOR)
    })
  }
  return panes
}

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/

export function parseProcessList(stdout) {
  const rows = []
  for (const line of String(stdout || '').split('\n')) {
    const match = PS_ROW.exec(line)
    if (!match) continue
    const pid = positiveInt(match[1])
    const pgid = positiveInt(match[2])
    if (!pid || !pgid) continue
    rows.push({ pid, pgid, stat: match[3], command: match[4], args: match[5] })
  }
  return rows
}

function tokens(args) {
  return String(args || '')
    .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
    ?.map((value) => value.replace(/"([^"]*)"|'([^']*)'/g, (_all, double, single) => double ?? single ?? '')) ?? []
}

function processScore(row, expected) {
  if (!expected) return 0
  const want = expected.toLowerCase()
  const argv = tokens(row.args)
  if (baseName(row.command) === want) return 100
  if (baseName(argv[0]) === want) return 90
  const head = baseName(argv[0])
  const script = argv[1]
  if (INTERPRETERS.has(head) && script && !script.startsWith('-')) {
    const scriptName = baseName(script).replace(/\.(?:js|mjs|cjs)$/i, '')
    if (scriptName === want) return 80
  }
  return 0
}

/** Kernel-backed process classification from one pane tty's `ps` output. */
export function classifyProcesses(rows, shellPid, expectedAgent) {
  const foreground = rows.filter((row) => row.stat.includes('+'))
  const foregroundPgid = foreground[0]?.pgid
  const foregroundGroup = foregroundPgid
    ? foreground.filter((row) => row.pgid === foregroundPgid)
    : []
  const expected = EXPECTED_PROCESS[expectedAgent]
  const candidates = expected
    ? foregroundGroup
        .map((row) => ({ row, score: processScore(row, expected) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.row.pid - b.row.pid)
    : []
  const agent = candidates[0]?.row
  const leader = foregroundGroup.find((row) => row.pid === row.pgid)
  const shell = rows.find((row) => row.pid === shellPid)
  const shellForeground = !!shell && shell.stat.includes('+')

  let state = 'unknown'
  if (agent) state = 'agent-running'
  else if (!expectedAgent) state = 'plain-terminal'
  else if (!expected) {
    state = leader && leader.pid !== shellPid && !SHELL_NAMES.has(baseName(leader.command))
      ? 'custom-agent-unverified'
      : 'unknown'
  } else if (shellForeground || (leader?.pid === shellPid && SHELL_NAMES.has(baseName(leader.command)))) {
    state = 'shell-only'
  } else if (foregroundGroup.length > 0) {
    state = 'unexpected-foreground'
  }

  return {
    state,
    shellPid,
    agentPid: agent?.pid,
    foregroundPgid,
    foreground: foregroundGroup.map((row) => ({ pid: row.pid, command: row.command }))
  }
}

export function extractModelArg(args) {
  const argv = tokens(args)
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--model' || argv[i] === '-m') && argv[i + 1]) return argv[i + 1]
    if (argv[i].startsWith('--model=')) return argv[i].slice('--model='.length)
  }
  return undefined
}

export function screenSignals(screen) {
  return SCREEN_SIGNALS.filter(([, pattern]) => pattern.test(screen)).map(([name]) => name)
}

function tokenCount(value) {
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(String(value || '').trim())
  if (!match) return undefined
  const scale = match[2].toLowerCase() === 'm' ? 1_000_000 : match[2].toLowerCase() === 'k' ? 1_000 : 1
  const count = Number(match[1]) * scale
  return Number.isFinite(count) && count > 0 ? Math.round(count) : undefined
}

/** Latest denominator visible in an agent TUI's `Ctx … used/window` status line. */
export function parseScreenContextWindow(screen) {
  const matches = [
    ...String(screen || '').matchAll(/(?:^|\n)\s*Ctx\b[^\n]*?\b[\d.]+[kKmM]?\s*\/\s*([\d.]+[kKmM]?)\b/g)
  ]
  return tokenCount(matches.at(-1)?.[1])
}

export function cleanScreen(screen, maxLines = 80) {
  const clean = String(screen || '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[^\x09\x0a\x20-\x7e\u00a0-\uffff]/g, '')
  return clean
    .split('\n')
    .slice(-Math.max(1, maxLines))
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
}

function readJson(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// Mirrors `isInlineProjectFileId` in core/workspace-files.ts. workspace.json is hand-editable, so
// an inline-project id must cross the same path jail before it names a file under userData.
function isInlineProjectFileId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) && !id.includes('..')
}

/** Read only the launch metadata needed by the scan; never mutates or migrates workspace files. */
export function loadWorkspaceNodes(userDataDir) {
  const indexPath = path.join(userDataDir, 'workspace.json')
  const indexRead = readJson(indexPath)
  if (!indexRead.value) return { nodes: new Map(), projects: 0, errors: [`${indexPath}: ${indexRead.error}`] }

  const nodes = new Map()
  const errors = []
  const entries = Array.isArray(indexRead.value.entries) ? indexRead.value.entries : []
  for (const entry of entries) {
    let project
    let source = indexPath
    // A cwd-less v3 project stores its authoritative content in
    // `userData/inline-projects/<id>.json`; `entry.project` is only the one-release compatibility
    // cache. Match WorkspaceStore.loadV3: a valid data file wins, and a missing/corrupt one falls
    // back to that cache. Never let a hand-edited id escape the inline-projects directory.
    if (entry.dataFile === true && !entry.cwd && !entry.ssh && isInlineProjectFileId(entry.id)) {
      const dataFile = path.join(userDataDir, 'inline-projects', `${entry.id}.json`)
      const dataRead = readJson(dataFile)
      if (dataRead.value?.version === 1 && Array.isArray(dataRead.value.nodes)) {
        project = dataRead.value
        source = dataFile
      } else {
        errors.push(`${dataFile}: ${dataRead.error || 'invalid project file'}`)
      }
    }
    if (!project) project = entry.project
    if (!project && entry.cwd) {
      source = path.join(entry.cwd, '.nodeterm', 'project.json')
      const projectRead = readJson(source)
      project = projectRead.value
      if (!project) {
        errors.push(`${source}: ${projectRead.error}`)
        continue
      }
    }
    if (!project && entry.cache) project = entry.cache
    if (!project || !Array.isArray(project.nodes)) continue
    for (const node of project.nodes) {
      if (!node || typeof node.id !== 'string') continue
      nodes.set(node.id, {
        id: node.id,
        kind: node.kind,
        title: typeof node.title === 'string' ? node.title : node.id,
        projectId: entry.id,
        projectName: entry.name,
        projectClosed: entry.closed === true,
        source,
        agentId: typeof node.agentId === 'string' ? node.agentId : undefined,
        agentModel: typeof node.agentModel === 'string' ? node.agentModel : undefined,
        agentLaunchModel: typeof node.agentLaunchModel === 'string' ? node.agentLaunchModel : undefined,
        agentLaunchContextWindow: positiveInt(node.agentLaunchContextWindow)
      })
    }
  }
  return { nodes, projects: entries.length, errors }
}

function readSafeEnvironment(tmuxBin, socket, session) {
  const env = {}
  for (const key of SAFE_ENV_KEYS) {
    const result = command(tmuxBin, ['-L', socket, 'show-environment', '-t', `=${session}`, key])
    if (!result.ok) continue
    const line = result.stdout.trim().split('\n')[0]
    if (line?.startsWith(`${key}=`)) env[key] = line.slice(key.length + 1)
  }
  return env
}

function readProcesses(tty) {
  const result = command('ps', [
    '-ww',
    '-o', 'pid=',
    '-o', 'pgid=',
    '-o', 'stat=',
    '-o', 'comm=',
    '-o', 'args=',
    '-t', tty
  ])
  return result.ok ? parseProcessList(result.stdout) : []
}

function readScreen(tmuxBin, socket, session, maxLines) {
  const result = command(tmuxBin, [
    '-L', socket,
    'capture-pane', '-p',
    // `show-environment -t =name` accepts tmux's exact-session syntax; `capture-pane` parses its
    // target as a PANE and treats the '=' literally. `name:` is the unambiguous session target.
    '-t', `${session}:`,
    '-S', `-${Math.max(1, maxLines)}`
  ])
  return result.ok ? cleanScreen(result.stdout, maxLines) : ''
}

function modelOfProcess(rows, pid) {
  if (!pid) return undefined
  const row = rows.find((candidate) => candidate.pid === pid)
  return row ? extractModelArg(row.args) : undefined
}

function addFinding(findings, severity, code, detail) {
  findings.push({ severity, code, detail })
}

/** Compare persisted intent with live kernel/tmux facts. */
export function auditSession({ pane, node, env, process, processModel, screenWindow, signals = [] }) {
  const findings = []
  const expectedAgent = node?.agentId || env.NODETERM_AGENT_ID
  const expectedModel = node?.agentLaunchModel || node?.agentModel
  const launchWindow = node?.agentLaunchContextWindow
  const envWindow = positiveInt(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)

  if (!node) addFinding(findings, 'warn', 'orphan-session', 'live tmux session has no persisted node')
  if (env.NODETERM_NODE_ID && env.NODETERM_NODE_ID !== pane.nodeId) {
    addFinding(findings, 'error', 'node-id-mismatch', `env=${env.NODETERM_NODE_ID} tmux=${pane.nodeId}`)
  }
  if (node?.agentId && env.NODETERM_AGENT_ID && env.NODETERM_AGENT_ID !== node.agentId) {
    addFinding(findings, 'error', 'agent-id-mismatch', `env=${env.NODETERM_AGENT_ID} record=${node.agentId}`)
  }
  if (expectedAgent && EXPECTED_PROCESS[expectedAgent]) {
    if (process.state === 'shell-only') {
      addFinding(findings, 'error', 'agent-not-running', 'pane is alive but its foreground owner is the shell')
    } else if (process.state !== 'agent-running') {
      addFinding(findings, 'error', 'agent-not-proven', `foreground state=${process.state}`)
    }
  }
  if (expectedModel && processModel && expectedModel !== processModel) {
    addFinding(findings, 'error', 'model-mismatch', `process=${processModel} record=${expectedModel}`)
  }
  if (expectedAgent === 'claude' && launchWindow && launchWindow > 200_000) {
    if (!envWindow) {
      addFinding(findings, 'error', 'context-window-env-missing', `record=${launchWindow}`)
    } else if (envWindow !== launchWindow) {
      addFinding(findings, 'error', 'context-window-mismatch', `env=${envWindow} record=${launchWindow}`)
    }
  }
  if (launchWindow && screenWindow && screenWindow !== launchWindow) {
    addFinding(
      findings,
      'error',
      'screen-context-window-mismatch',
      `screen=${screenWindow} record=${launchWindow}`
    )
  }
  for (const signal of signals) {
    if (signal === 'resume-error' || signal === 'authentication-error' || signal === 'command-error') {
      addFinding(findings, 'error', `screen-${signal}`, 'terminal screen contains this failure signal')
    }
  }

  return {
    expectedAgent,
    expectedModel,
    launchWindow,
    envWindow,
    findings
  }
}

function findTmux(explicit) {
  const candidates = [explicit, process.env.NODETERM_TMUX_BIN, '/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', 'tmux']
    .filter(Boolean)
  for (const candidate of [...new Set(candidates)]) {
    if (command(candidate, ['-V']).ok) return candidate
  }
  return undefined
}

export function scanAgentSessions(options = {}) {
  const tmuxBin = findTmux(options.tmuxBin)
  const scannedAt = new Date().toISOString()
  const userDataDir = options.userDataDir || defaultUserDataDir()
  const workspace = loadWorkspaceNodes(userDataDir)
  if (!tmuxBin) {
    return {
      scannedAt,
      ok: false,
      tmuxBin: null,
      socket: options.socket || DEFAULT_SOCKET,
      workspaceProjects: workspace.projects,
      workspaceAgents: [...workspace.nodes.values()].filter((node) => node.agentId).length,
      errors: [...workspace.errors, 'tmux binary not found'],
      sessions: []
    }
  }

  const socket = options.socket || DEFAULT_SOCKET
  const listed = command(tmuxBin, ['-L', socket, 'list-panes', '-a', '-F', PANE_FORMAT])
  if (!listed.ok) {
    return {
      scannedAt,
      ok: false,
      tmuxBin,
      socket,
      workspaceProjects: workspace.projects,
      workspaceAgents: [...workspace.nodes.values()].filter((node) => node.agentId).length,
      errors: [...workspace.errors, listed.error],
      sessions: []
    }
  }

  const selected = options.nodeIds ? new Set(options.nodeIds) : null
  const sessions = []
  for (const pane of parsePaneList(listed.stdout)) {
    if (!pane.nodeId || (selected && !selected.has(pane.nodeId))) continue
    const node = workspace.nodes.get(pane.nodeId)
    const env = readSafeEnvironment(tmuxBin, socket, pane.session)
    const expectedAgent = node?.agentId || env.NODETERM_AGENT_ID
    if (!expectedAgent) continue
    const rows = readProcesses(pane.tty)
    const process = classifyProcesses(rows, pane.shellPid, expectedAgent)
    const processModel = modelOfProcess(rows, process.agentPid)
    const screen = readScreen(tmuxBin, socket, pane.session, options.screenLines || 80)
    const signals = screenSignals(screen)
    const screenWindow = parseScreenContextWindow(screen)
    const audit = auditSession({ pane, node, env, process, processModel, screenWindow, signals })
    sessions.push({
      nodeId: pane.nodeId,
      session: pane.session,
      title: node?.title,
      projectId: node?.projectId,
      projectName: node?.projectName,
      cwd: pane.cwd,
      tty: pane.tty,
      paneCommand: pane.paneCommand,
      shellPid: pane.shellPid,
      agentPid: process.agentPid,
      processState: process.state,
      foregroundPgid: process.foregroundPgid,
      foreground: process.foreground,
      expectedAgent: audit.expectedAgent,
      launchModel: audit.expectedModel,
      processModel,
      launchWindow: audit.launchWindow,
      envWindow: audit.envWindow,
      screenWindow,
      compactPercent: positiveInt(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE),
      screenSignals: signals,
      findings: audit.findings,
      screen
    })
  }

  sessions.sort((a, b) => {
    const aBad = a.findings.some((finding) => finding.severity === 'error') ? 1 : 0
    const bBad = b.findings.some((finding) => finding.severity === 'error') ? 1 : 0
    return bBad - aBad || a.nodeId.localeCompare(b.nodeId)
  })
  return {
    scannedAt,
    ok: true,
    tmuxBin,
    socket,
    workspaceProjects: workspace.projects,
    workspaceAgents: [...workspace.nodes.values()].filter((node) => node.agentId).length,
    errors: workspace.errors,
    sessions
  }
}

function statusOf(session) {
  if (session.findings.some((finding) => finding.severity === 'error')) return 'ERROR'
  if (session.findings.length > 0) return 'WARN'
  return 'OK'
}

function windowText(session) {
  if (!session.launchWindow && !session.envWindow && !session.screenWindow) return '-'
  return `${session.launchWindow ?? '?'}/${session.envWindow ?? '?'}/${session.screenWindow ?? '?'}`
}

export function formatReport(report, options = {}) {
  const errorCount = report.sessions.reduce(
    (count, session) => count + session.findings.filter((finding) => finding.severity === 'error').length,
    0
  )
  const lines = [
    `[agent-scan] ${report.scannedAt} socket=${report.socket} liveAgents=${report.sessions.length} ` +
      `workspaceAgents=${report.workspaceAgents} errors=${errorCount}`
  ]
  for (const error of report.errors) lines.push(`[agent-scan] WARN ${error}`)
  for (const session of report.sessions) {
    lines.push(
      `[agent-scan] ${statusOf(session)} ${session.nodeId} ` +
        `agent=${session.expectedAgent} shellPid=${session.shellPid} agentPid=${session.agentPid ?? '-'} ` +
        `model=${session.processModel ?? session.launchModel ?? '-'} window(record/env/screen)=${windowText(session)} ` +
        `title=${JSON.stringify(session.title ?? '')}`
    )
    for (const finding of session.findings) {
      lines.push(`  ${finding.severity.toUpperCase()} ${finding.code}: ${finding.detail}`)
    }
    if (session.screenSignals.length > 0) lines.push(`  screen signals: ${session.screenSignals.join(', ')}`)
    if (options.screens) {
      lines.push(`--- screen ${session.nodeId} ---`)
      lines.push(session.screen || '(empty/unavailable)')
      lines.push(`--- end screen ${session.nodeId} ---`)
    }
  }
  return lines.join('\n')
}

export function reportLogLines(report) {
  // One bounded, grep-friendly JSON object per line. Screen text is discarded before this point;
  // durable logs carry only facts and named findings, never another session's conversation.
  return [
    `[agent-scan] scan ${JSON.stringify({
      scannedAt: report.scannedAt,
      ok: report.ok,
      socket: report.socket,
      workspaceProjects: report.workspaceProjects,
      workspaceAgents: report.workspaceAgents,
      liveAgents: report.sessions.length,
      errorFindings: report.sessions.reduce(
        (count, session) => count + session.findings.filter((finding) => finding.severity === 'error').length,
        0
      ),
      errors: report.errors
    })}`,
    ...report.sessions.map(({ screen: _screen, foreground, ...session }) =>
      `[agent-scan] session ${JSON.stringify({ ...session, foregroundCount: foreground.length })}`
    )
  ]
}

function appendReport(file, report) {
  const target = path.resolve(file)
  const lines = reportLogLines(report)
  fs.appendFileSync(target, `${lines.join('\n')}\n`, { mode: 0o600 })
  return target
}

export function parseCliArgs(argv) {
  const options = { screenLines: 80 }
  const take = (i, flag) => {
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--screens') options.screens = true
    else if (arg === '--json') options.json = true
    else if (arg === '--fail-on-findings') options.failOnFindings = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--node') options.nodeIds = take(i++, arg).split(',').filter(Boolean)
    else if (arg === '--socket') options.socket = take(i++, arg)
    else if (arg === '--tmux') options.tmuxBin = take(i++, arg)
    else if (arg === '--user-data') options.userDataDir = take(i++, arg)
    else if (arg === '--append') options.append = take(i++, arg)
    else if (arg === '--screen-lines') {
      const value = positiveInt(take(i++, arg))
      if (!value) throw new Error('--screen-lines must be a positive integer')
      options.screenLines = value
    }
    else if (arg === '--watch') options.watchSeconds = Number(take(i++, arg))
    else if (arg === '--count') {
      const value = positiveInt(take(i++, arg))
      if (!value) throw new Error('--count must be a positive integer')
      options.count = value
    }
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (options.watchSeconds !== undefined && (!Number.isFinite(options.watchSeconds) || options.watchSeconds <= 0)) {
    throw new Error('--watch must be a positive number of seconds')
  }
  return options
}

const HELP = `Usage: npm run diagnose:agents -- [options]

Scan Nodeterm-owned tmux agent panes without mutating Nodeterm state.
Process inspection requires POSIX ps and is not supported on native Windows.

  --node <id[,id]>       scan only these node ids
  --screens              include recent terminal screen text on stdout (never in appended logs)
  --screen-lines <n>     lines captured per screen (default 80)
  --append <path>        write by appending a metadata-only header and one JSONL record per session
  --watch <seconds>      repeat until interrupted
  --count <n>            stop a watch after n scans
  --json                 print JSON (includes screens only with --screens)
  --fail-on-findings     exit 2 when any error finding is present
  --socket <name>        tmux socket (default node-terminal)
  --tmux <path>          explicit tmux binary
  --user-data <path>     Electron userData directory
`

async function main() {
  let options
  try {
    options = parseCliArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[agent-scan] ${error instanceof Error ? error.message : String(error)}`)
    console.error(HELP)
    process.exitCode = 1
    return
  }
  if (options.help) {
    process.stdout.write(HELP)
    return
  }

  let scans = 0
  let hadFindings = false
  let hadScanFailure = false
  do {
    const report = scanAgentSessions(options)
    const printable = options.json
      ? JSON.stringify(
          options.screens ? report : { ...report, sessions: report.sessions.map(({ screen: _screen, ...s }) => s) },
          null,
          2
        )
      : formatReport(report, options)
    process.stdout.write(`${printable}\n`)
    if (options.append) console.error(`[agent-scan] appended metadata to ${appendReport(options.append, report)}`)
    hadScanFailure ||= !report.ok
    hadFindings ||= report.sessions.some((session) =>
      session.findings.some((finding) => finding.severity === 'error')
    )
    scans++
    if (!options.watchSeconds || (options.count && scans >= options.count)) break
    await new Promise((resolve) => setTimeout(resolve, options.watchSeconds * 1000))
  } while (true)

  if (hadScanFailure) process.exitCode = 1
  else if (options.failOnFindings && hadFindings) process.exitCode = 2
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) await main()
