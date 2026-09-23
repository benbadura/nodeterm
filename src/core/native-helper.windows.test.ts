import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { nativeHelperScript, nativeHookCommand } from './native-helper-install'

const dirs: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())) }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`
function run(source: string, input: string, env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      { env: { ...process.env, NODETERM_NODE_ID: '', NODETERM_HOOK_ENDPOINT: '', ...env } })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native helper timed out')) }, 10000)
    child.stdout.on('data', b => { output += b.toString() })
    child.stderr.on('data', b => { output += b.toString() })
    child.once('error', e => { clearTimeout(timer); reject(e) })
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output }) })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
function wrapper(args: string[], executable = process.execPath) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nt helper żółć ' & "))
  dirs.push(root)
  const file = path.join(root, 'helper.ps1')
  const bundle = path.resolve('out/helper/native-helper.cjs')
  expect(fs.existsSync(bundle), 'Run npm run helper:build first').toBe(true)
  fs.writeFileSync(file, nativeHelperScript(executable, bundle, root, args))
  return { file, root }
}
describe.skipIf(process.platform !== 'win32')('native PowerShell helper process', () => {
  it('drains large hook stdin with no session and after runtime removal', async () => {
    for (const exe of [process.execPath, 'C:\\missing-nodeterm.exe']) {
      const { file } = wrapper(['hook', 'claude'], exe)
      expect((await run(nativeHookCommand(file), 'x'.repeat(256 * 1024))).code).toBe(0)
    }
  }, 25000)
  it('preserves Unicode, quotes, empty strings and metacharacters through Windows PowerShell 5.1', async () => {
    const { file, root } = wrapper(['control'])
    const received: URLSearchParams[] = []
    const server = http.createServer(async (req, res) => {
      let body = ''; for await (const b of req) body += b.toString()
      received.push(new URLSearchParams(body)); res.end('ok')
    })
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const endpoint = path.join(root, 'endpoint.env')
    fs.writeFileSync(endpoint, `NODETERM_HOOK_PORT=${(server.address() as { port: number }).port}\n`)
    const value = 'Żółć "quoted" \'apostrophe\' & $HOME %PATH% !\nsecond line'
    const result = await run(`& ${quote(file)} sticky --node node-1 ${quote('--text=' + value)} '--label='`, '', {
      NODETERM_NODE_ID: 'node-1', NODETERM_CANVAS_CONTROL: '1', NODETERM_HOOK_ENDPOINT: endpoint
    })
    expect(result.code, result.output).toBe(0)
    expect(received).toHaveLength(1)
    expect(received[0].get('arg.text')).toBe(value)
    expect(received[0].get('arg.label')).toBe('')
  }, 15000)
  it('forwards hook stdin verbatim and completes a permission answer', async () => {
    const { file, root } = wrapper(['hook', 'claude'])
    const payload = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_input: { text: 'żółć\n"quoted" & $x' } })
    const requests: URLSearchParams[] = []
    const server = http.createServer(async (req, res) => {
      let body = ''; for await (const b of req) body += b.toString()
      const fields = new URLSearchParams(body)
      requests.push(fields)
      const pendingId = fields.get('nodeterm_pending_id')!
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(pendingId)) { res.writeHead(400); res.end(); return }
      fs.writeFileSync(path.join(root, '.nodeterm', 'pending', `${pendingId}.answer`), 'allow\n')
      res.end('ok')
    })
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const endpoint = path.join(root, 'endpoint.env')
    fs.writeFileSync(endpoint, `NODETERM_HOOK_PORT=${(server.address() as { port: number }).port}\n`)
    const result = await run(nativeHookCommand(file), payload, {
      USERPROFILE: root, HOME: root, NODETERM_NODE_ID: 'node.1', NODETERM_HOOK_ENDPOINT: endpoint,
      NODETERM_PERM_WAIT_SECS: '5'
    })
    expect(result.code, result.output).toBe(0)
    expect(JSON.parse(result.output).hookSpecificOutput.decision.behavior).toBe('allow')
    expect(requests[0].get('payload')).toBe(payload)
    expect(requests.at(-1)?.get('nodeterm_answered')).toBe('allow')
    expect(fs.readdirSync(path.join(root, '.nodeterm', 'pending'))).toEqual([])
  }, 15000)
})
