import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { parseHelperArgs, recoverHelperIdentity, sendHelper } from './native-helper'
import { nativeHookCommand, nativeHelperScript } from './native-helper-install'
import { normalizeHookCommand, mergeManagedHook } from './agents/hooks/install-helper'
const dirs: string[] = []
const servers: http.Server[] = []
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-helper-')); dirs.push(d); return d }
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())) }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
describe('native helper', () => {
  it('preserves text flags including newlines, leading dashes, equals and negative values', () => {
    expect(parseHelperArgs(['sticky', 'node-1', '--text=--hello=world\nżółć', '--create', '--count', '-2'])).toEqual({
      verb: 'sticky', args: { node: 'node-1', text: '--hello=world\nżółć', create: '', count: '-2' }
    })
    expect(() => parseHelperArgs(['../control/write'])).toThrow()
  })
  it('retains a recognizable ownership marker through encoded Windows commands', () => {
    const command = nativeHookCommand('C:\\Users\\A $ & B\\.nodeterm\\agent-hooks\\claude.ps1')
    expect(normalizeHookCommand(command)).toContain('agent-hooks/claude.sh')
    const old = { hooks: { Stop: [{ hooks: [{ type: 'command', command: "sh '/old/agent-hooks/claude.sh'" }] },
      { hooks: [{ type: 'command', command: 'my-own-hook' }] }] } }
    const merged = mergeManagedHook(old, command, ['Stop'])
    expect(merged.hooks?.Stop).toHaveLength(2)
    expect(merged.hooks?.Stop?.[0].hooks?.[0].command).toBe('my-own-hook')
    expect(mergeManagedHook(merged, command, ['Stop'])).toEqual(merged)
    expect(command).not.toContain('A $ & B')
    expect(nativeHelperScript('C:\\nodeterm.exe', 'C:\\app.asar\\helper.cjs', 'C:\\data', ['hook', 'claude'])).toContain('ReadToEnd()')
    const packaged = nativeHelperScript('C:\\nodeterm.exe', 'C:\\app.asar\\helper.cjs', 'C:\\data', ['control'])
    expect(packaged).toContain("$helperContainer = 'C:\\app.asar'")
    expect(packaged).not.toContain('Test-Path -LiteralPath $helper)')
  })
  it('recovers only one matching account-scoped identity', () => {
    const root = tmp()
    fs.writeFileSync(path.join(root, 'thread-1'), `nodeId=node-1\nendpoint=${path.join(root, 'hook-endpoint.env')}\nagentId=codex\ncanvasControl=0\n`)
    const env = { CODEX_THREAD_ID: 'thread-1', NODETERM_HELPER_IDENTITY_ROOT: root }
    expect(recoverHelperIdentity(env).NODETERM_NODE_ID).toBe('node-1')
    expect(recoverHelperIdentity(env).NODETERM_CANVAS_CONTROL).toBe('')
    fs.mkdirSync(path.join(root, 'other'))
    fs.writeFileSync(path.join(root, 'other', 'thread-1'), `accountId=other\nnodeId=node-2\nendpoint=${path.join(root, 'hook-endpoint.env')}\n`)
    expect(recoverHelperIdentity(env).NODETERM_NODE_ID).toBeUndefined()
    expect(recoverHelperIdentity({ ...env, CODEX_THREAD_ID: '..' }).NODETERM_NODE_ID).toBeUndefined()
  })
  it('sends credentials in headers, payload in body and refuses to replay an HTTP denial', async () => {
    const root = tmp()
    fs.mkdirSync(path.join(root, 'node-tokens'))
    fs.writeFileSync(path.join(root, 'node-tokens', 'node-1'), 'per-node-token\n')
    const received: { headers: http.IncomingHttpHeaders; body: string }[] = []
    const server = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk
      received.push({ headers: req.headers, body })
      res.writeHead(403); res.end('refused')
    })
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const endpoint = path.join(root, 'hook-endpoint.env')
    fs.writeFileSync(endpoint, `NODETERM_HOOK_PORT='${port}'\nNODETERM_HOOK_TOKEN='bearer'\n`)
    const result = await sendHelper({ NODETERM_NODE_ID: 'node-1', NODETERM_HOOK_ENDPOINT: endpoint }, '/control/write', { 'arg.text': 'żółć\n& hi' }, 1000)
    expect(result).toEqual({ status: 403, body: 'refused' })
    expect(received).toHaveLength(1)
    expect(received[0].headers['x-nodeterm-node-token']).toBe('per-node-token')
    expect(received[0].headers['x-nodeterm-hook-token']).toBe('bearer')
    expect(new URLSearchParams(received[0].body).get('arg.text')).toBe('żółć\n& hi')
    expect(received[0].body).not.toContain('bearer')
  })
  it('re-reads rotated credentials on each event and falls back from a missing socket', async () => {
    const root = tmp()
    const tokens: string[] = []
    const server = http.createServer((req, res) => {
      tokens.push(String(req.headers['x-nodeterm-hook-token'])); res.end('ok')
    })
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const endpoint = path.join(root, 'hook-endpoint.env')
    const socket = process.platform === 'win32' ? `\\\\.\\pipe\\nt-missing-${path.basename(root)}` : path.join(root, 'missing.sock')
    for (const token of ['first', 'rotated']) {
      fs.writeFileSync(endpoint, `NODETERM_HOOK_SOCK='${socket}'\nNODETERM_HOOK_PORT=${port}\nNODETERM_HOOK_TOKEN=${token}\n`)
      expect(await sendHelper({ NODETERM_NODE_ID: 'node-1', NODETERM_HOOK_ENDPOINT: endpoint },
        '/control/list', {}, 1000)).toEqual({ status: 200, body: 'ok' })
    }
    expect(tokens).toEqual(['first', 'rotated'])
  })
  it('never replays a control mutation after the listener loses its reply', async () => {
    const root = tmp()
    let requests = 0
    const server = http.createServer(async (req) => {
      for await (const _chunk of req) { /* consume the mutation before losing its response */ }
      requests++; req.socket.destroy()
    })
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const endpoint = path.join(root, 'hook-endpoint.env')
    fs.writeFileSync(endpoint, `NODETERM_HOOK_PORT=${(server.address() as { port: number }).port}\n`)
    await expect(sendHelper({ NODETERM_NODE_ID: 'node-1', NODETERM_HOOK_ENDPOINT: endpoint },
      '/control/sticky', { 'arg.text': 'once only' }, 1000)).rejects.toThrow()
    expect(requests).toBe(1)
  })
})
