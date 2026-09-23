import { helpVerbList } from './canvas-control-core'
// Standalone client used by packaged native launchers. No Electron/core service initialization.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { parseEndpointEnv } from './agents/hook-endpoint-parse'
import { isSafeNodeId } from './agents/node-auth-token'
import { MANAGED_SCRIPT_REVISION } from './agents/hooks/managed-script'

export function parseHelperArgs(argv: string[]): { verb: string; args: Record<string, string> } {
  const [verb = 'list', ...rest] = argv
  const args: Record<string, string> = Object.create(null)
  let positional = false
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i]
    if (value.startsWith('--')) {
      const eq = value.indexOf('=')
      const key = value.slice(2, eq < 0 ? undefined : eq)
      args[key] = eq >= 0 ? value.slice(eq + 1) : rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : ''
    } else if (value === '-n') {
      args.n = rest[++i] ?? ''
    } else if (!positional) {
      positional = true
      if (['show-image', 'show-video'].includes(verb)) args.path = value
      else if (['write', 'close', 'rename', 'color', 'branch', 'send', 'reply', 'sticky'].includes(verb)) args.node = value
    }
  }
  if (!/^[a-z][a-z-]*$/.test(verb)) throw new Error('Invalid helper command.')
  return { verb, args }
}
function read(file: string): string { try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' } }

/** Match the sh client's account-scoped recovery; records are data, never executed. */
export function recoverHelperIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.NODETERM_NODE_ID || !env.CODEX_THREAD_ID || !env.NODETERM_HELPER_IDENTITY_ROOT) return env
  const safe = (s: string) => /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..'
  if (!safe(env.CODEX_THREAD_ID)) return env
  const root = env.NODETERM_HELPER_IDENTITY_ROOT
  const scope = env.NODETERM_CODEX_ACCOUNT_ID
  if (scope && !safe(scope)) return env
  let scopes = scope ? [scope] : ['']
  if (!scope) {
    try { scopes = scopes.concat(fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && safe(d.name)).map(d => d.name)) } catch { /* no records */ }
  }
  const records = scopes.flatMap(account => {
    const data: Record<string, string> = Object.create(null)
    for (const line of read(path.join(root, account, env.CODEX_THREAD_ID!)).split('\n')) {
      const i = line.indexOf('=')
      if (i > 0 && !(line.slice(0, i) in data)) data[line.slice(0, i)] = line.slice(i + 1)
    }
    if (!isSafeNodeId(data.nodeId) || !path.isAbsolute(data.endpoint || '') || /[\r\n\0]/.test(data.endpoint) ||
      (data.accountId ?? '') !== account) return []
    return [data]
  })
  if (records.length !== 1) return env
  const record = records[0]
  return { ...env, NODETERM_NODE_ID: record.nodeId, NODETERM_HOOK_ENDPOINT: record.endpoint,
    NODETERM_AGENT_ID: record.agentId ?? 'codex',
    NODETERM_CANVAS_CONTROL: record.agentId === undefined ? '1' : record.canvasControl === '1' ? '1' : '' }
}
export interface HelperEndpoint { file: string; env: Record<string, string> }
export function helperEndpoints(env: NodeJS.ProcessEnv, home = os.homedir()): HelperEndpoint[] {
  const files = [env.NODETERM_HOOK_ENDPOINT,
    env.APPDATA && path.join(env.APPDATA, 'node-terminal', 'hook-endpoint.env'),
    path.join(home, '.nodeterm-server', 'hook-endpoint.env'),
    path.join(home, '.config', 'node-terminal', 'hook-endpoint.env'),
    path.join(home, 'Library', 'Application Support', 'node-terminal', 'hook-endpoint.env')]
  try {
    const dir = path.join(home, '.nodeterm')
    const remote = fs.readdirSync(dir).filter(f => /^hook-endpoint-.*\.env$/.test(f))
      .map(f => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    files.push(...remote)
  } catch { /* no remote endpoints */ }
  return [...new Set(files.filter((f): f is string => !!f))].flatMap(file => {
    const body = read(file)
    return body ? [{ file, env: parseEndpointEnv(body.replace(/\r\n/g, '\n')) }] : []
  }).slice(0, 4)
}
export function postHelper(endpoint: HelperEndpoint, nodeId: string, route: string, fields: Record<string, string>,
  timeout: number, socket = !!endpoint.env.NODETERM_HOOK_SOCK): Promise<{ status: number; body: string }> {
  const env = endpoint.env
  const port = Number(env.NODETERM_HOOK_PORT)
  if (!socket && (!Number.isInteger(port) || port < 1 || port > 65535)) return Promise.reject(new Error('No local endpoint.'))
  const tokenDir = env.NODETERM_NODE_TOKEN_DIR || path.join(path.dirname(endpoint.file), 'node-tokens')
  const token = isSafeNodeId(nodeId) ? read(path.join(tokenDir, nodeId)).split('\n')[0] : ''
  const body = new URLSearchParams({ ...fields, nodeId }).toString()
  return new Promise((resolve, reject) => {
    const request = http.request({
      ...(socket ? { socketPath: env.NODETERM_HOOK_SOCK } : { hostname: '127.0.0.1', port }),
      method: 'POST', path: route,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/plain',
        'Content-Length': Buffer.byteLength(body), 'X-Nodeterm-Hook-Token': env.NODETERM_HOOK_TOKEN || '',
        'X-Nodeterm-Node-Token': token, 'X-Nodeterm-Hook-Client': String(MANAGED_SCRIPT_REVISION) }
    }, response => {
      let output = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        output += chunk
        if (Buffer.byteLength(output) > 8 * 1024 * 1024) request.destroy(new Error('Helper response too large.'))
      })
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode || 500, body: output }))
    })
    const deadline = setTimeout(() => request.destroy(new Error('Local endpoint timed out.')), timeout)
    request.on('close', () => clearTimeout(deadline))
    request.on('error', reject)
    request.end(body)
  })
}
export async function sendHelper(env: NodeJS.ProcessEnv, route: string, fields: Record<string, string>, timeout: number) {
  const deadline = Date.now() + (route.startsWith('/hook/') ? 4500 : timeout)
  for (const endpoint of helperEndpoints(env)) {
    const transports = endpoint.env.NODETERM_HOOK_SOCK ? [true, false] : [false]
    for (const socket of transports) {
      if (!socket && !endpoint.env.NODETERM_HOOK_PORT) continue
      const remaining = Math.min(timeout, deadline - Date.now())
      if (remaining <= 0) throw new Error('Local endpoint timed out.')
      try {
        const response = await postHelper(endpoint, env.NODETERM_NODE_ID!, route,
          { ...fields, version: endpoint.env.NODETERM_HOOK_VERSION || '2' }, remaining, socket)
        // An HTTP answer, including a refusal, is final. Never replay a denied mutation elsewhere.
        return response
      } catch (error) {
        // Mutating control requests may have reached the server before a response was lost.
        // Fail over only when the OS positively reports that no listener was reached.
        const code = (error as NodeJS.ErrnoException).code
        if (route.startsWith('/control/') && code !== 'ECONNREFUSED' && code !== 'ENOENT') throw error
      }
    }
  }
  throw new Error('Could not reach nodeterm (control endpoint unreachable). Reopen nodeterm and retry.')
}
async function stdin(): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 8 * 1024 * 1024) tooLarge = true
    if (!tooLarge) chunks.push(bytes)
  }
  return tooLarge ? '' : Buffer.concat(chunks).toString('utf8')
}
export async function runNativeHelper(argv: string[], original = process.env): Promise<number> {
  const [mode, ...args] = argv
  const env = recoverHelperIdentity(original)
  if (mode === 'hook') {
    // Always drain before inspecting identity or JSON, including stale/uninstalled sessions.
    const payload = await stdin()
    if (!payload || !isSafeNodeId(env.NODETERM_NODE_ID)) return 0
    const agent = args[0]
    if (!['claude', 'codex', 'gemini', 'grok', 'copilot'].includes(agent)) return 0
    let data: { hook_event_name?: string }
    try { data = JSON.parse(payload) } catch { return 0 }
    const seconds = Math.min(120, Math.max(0, Number(env.NODETERM_PERM_WAIT_SECS) || 0))
    const pending = agent === 'claude' && data.hook_event_name === 'PermissionRequest' && seconds > 0
      ? `${env.NODETERM_NODE_ID!.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160)}-${Date.now()}-${randomUUID()}` : ''
    const dir = path.join(os.homedir(), '.nodeterm', 'pending')
    const requestFile = path.join(dir, `${pending}.json`)
    const answerFile = path.join(dir, `${pending}.answer`)
    const fields = { payload, nodeterm_pending_id: pending }
    try {
      if (pending) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        fs.writeFileSync(requestFile, payload, { mode: 0o600, flag: 'wx' })
      }
      const response = await sendHelper(env, `/hook/${agent}`, fields, 1500)
      if (response.status < 200 || response.status >= 300 || !pending) return 0
      const until = Date.now() + seconds * 1000
      while (Date.now() < until) {
        if (fs.existsSync(answerFile)) {
          const decision = read(answerFile)
          if (decision === 'allow' || decision === 'deny') {
            await sendHelper(env, `/hook/${agent}`, { ...fields, nodeterm_answered: decision }, 1000).catch(() => {})
            process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest',
              decision: { behavior: decision, ...(decision === 'deny' ? { message: 'Denied from nodeterm.' } : {}) } } }) + '\n')
          }
          break
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    } catch { /* Hook infrastructure must never block an agent prompt. */ }
    finally {
      if (pending) for (const file of [requestFile, answerFile]) { try { fs.rmSync(file, { force: true }) } catch { /* best effort */ } }
    }
    return 0
  }
  if (mode === 'control' && ['help', '-h', '--help'].includes(args[0])) {
    process.stdout.write(`nodeterm canvas control\nVerbs: ${helpVerbList()}\nFlags: --flag value or --flag=value\n`)
    return 0
  }
  if (mode !== 'control' && mode !== 'context') throw new Error('Unknown helper mode.')
  if (!isSafeNodeId(env.NODETERM_NODE_ID)) throw new Error('Not a nodeterm session.')
  if (mode === 'control' && !env.NODETERM_CANVAS_CONTROL) throw new Error('Canvas control is not available in this session.')
  const parsed = parseHelperArgs(args)
  const fields = Object.fromEntries(Object.entries(parsed.args).map(([k, v]) => [`arg.${k}`, v]))
  const response = await sendHelper(env, `/${mode === 'control' ? 'control' : 'context-link'}/${parsed.verb}`, fields,
    mode === 'control' ? 130000 : 30000)
  process.stdout.write(response.body)
  return response.status >= 200 && response.status < 300 ? 0 : 1
}
