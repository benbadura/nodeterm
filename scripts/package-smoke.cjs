// Execute using the PACKAGED Electron binary and ELECTRON_RUN_AS_NODE=1.
// Never touches the user's nodeterm state or tmux server.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn, spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const { randomUUID } = require('node:crypto')
const { once } = require('node:events')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm package żółć '))
let child, client
let ownedSession = false

async function connect(state, token) {
  const socket = net.createConnection(state.endpoint)
  const pending = new Map()
  let counter = 0, buffer = '', output = ''
  socket.setEncoding('utf8')
  socket.on('data', bytes => {
    buffer += bytes
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      if (frame.type === 'data') output += frame.data
      if (frame.id && pending.has(frame.id)) {
        const request = pending.get(frame.id); pending.delete(frame.id); clearTimeout(request.timer)
        frame.ok ? request.resolve(frame.result) : request.reject(new Error(frame.error))
      }
    }
  })
  const close = error => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error) }
    pending.clear()
  }
  socket.on('error', close)
  socket.on('close', () => close(new Error('Host connection closed')))
  await once(socket, 'connect')
  const rpc = body => new Promise((resolve, reject) => {
    const id = ++counter
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${body.cmd}`)) }, 15000)
    pending.set(id, { resolve, reject, timer })
    socket.write(JSON.stringify({ ...body, id }) + '\n')
  })
  try { await rpc({ cmd: 'hello', token, protocolVersion: state.protocolVersion }) }
  catch (error) { socket.destroy(); throw error }
  return { rpc, close: () => socket.destroy(), output: () => output }
}

async function main() {
  assert(process.versions.electron, 'Use the packaged executable, not system Node')
  const resources = process.platform === 'darwin'
    ? path.resolve(path.dirname(process.execPath), '..', 'Resources')
    : path.join(path.dirname(process.execPath), 'resources')
  const asar = path.join(resources, 'app.asar')
  for (const file of ['out/main/index.js', 'out/session-host/host.cjs', 'out/main/codex-relay.js', 'out/helper/native-helper.cjs']) {
    assert(fs.existsSync(path.join(asar, file)), `Missing packaged runtime: ${file}`)
  }
  const packagedRequire = createRequire(path.join(asar, 'package.json'))
  assert.equal(typeof packagedRequire('node-pty').spawn, 'function')
  packagedRequire('smart-whisper')
  const png = await packagedRequire('sharp')({ create: { width: 2, height: 2, channels: 4, background: '#123456' } }).png().toBuffer()
  assert(png.length > 0)
  const helper = path.join(asar, 'out/helper/native-helper.cjs')
  const helperEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODETERM_NODE_ID: '', CODEX_THREAD_ID: '', NODETERM_HELPER_ARGS: '' }
  const help = spawnSync(process.execPath, [helper, 'control', 'help'], { env: helperEnv, timeout: 5000, encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert(help.stdout.includes('open-terminal'), 'Packaged helper has no command catalog')
  const staleHook = spawnSync(process.execPath, [helper, 'hook', 'claude'], {
    env: helperEnv, input: 'x'.repeat(256 * 1024), timeout: 5000, encoding: 'utf8'
  })
  assert.equal(staleHook.status, 0, staleHook.stderr)
  if (process.platform === 'win32') {
    const { nativeHelperScript } = packagedRequire(helper)
    const launcher = path.join(root, 'native helper.ps1')
    fs.writeFileSync(launcher, nativeHelperScript(process.execPath, helper, root, ['control']))
    const ps = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const native = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, 'help'], {
      env: helperEnv, timeout: 10000, encoding: 'utf8'
    })
    assert.equal(native.status, 0, native.stderr)
    assert(native.stdout.includes('open-terminal'), 'PowerShell could not reach the packaged helper')
  }
  child = spawn(process.execPath, [path.join(asar, 'out/session-host/host.cjs'), root], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true, detached: true
  })
  child.on('error', error => console.error(error.message))
  const stateFile = path.join(root, 'session-host.json')
  let state
  for (let i = 0; i < 150; i++) {
    try {
      const candidate = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (candidate.endpoint && candidate.tokenPath && fs.existsSync(candidate.tokenPath)) { state = candidate; break }
    } catch {}
    if (child.exitCode !== null) throw new Error(`Packaged host exited: ${child.exitCode}`)
    await pause(100)
  }
  assert(state, 'Packaged session host never became ready')
  const token = fs.readFileSync(state.tokenPath, 'utf8').trim()
  await assert.rejects(connect(state, 'incorrect-token'))
  client = await connect(state, token)
  const windows = process.platform === 'win32'
  const shell = windows ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh'
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'))
  const attached = await client.rpc({ cmd: 'attach', name: 'nt-package-smoke', scrollback: 100,
    spawn: { shell, args: windows ? ['-NoLogo', '-NoProfile'] : [], cwd: root, env, cols: 80, rows: 24 } })
  ownedSession = true
  assert.equal(attached.fresh, true)
  await pause(1000)
  const marker = 'NODETERM_Żółć_' + randomUUID().replaceAll('-', '')
  // The shell assembles the marker; echoing the submitted command alone cannot pass this check.
  const command = windows ? `Write-Output ('${marker.slice(0, 12)}' + '${marker.slice(12)}')`
    : `printf '%s%s\\n' '${marker.slice(0, 12)}' '${marker.slice(12)}'`
  await client.rpc({ cmd: 'sendKeys', name: 'nt-package-smoke', text: command, enter: true })
  for (let i = 0; i < 100 && !client.output().includes(marker); i++) await pause(100)
  assert(client.output().includes(marker), 'Packaged PTY did not execute input')
  await client.rpc({ cmd: 'resize', name: 'nt-package-smoke', cols: 100, rows: 30 })
  client.close(); client = null
  await pause(250)
  assert.equal(child.exitCode, null, 'Host died with its client')
  client = await connect(state, token)
  const reattached = await client.rpc({ cmd: 'attachExisting', name: 'nt-package-smoke' })
  assert.equal(reattached.fresh, false)
  assert.equal(reattached.generation, attached.generation)
  assert(reattached.screen?.includes(marker), 'Warm attachment lost its screen')
  const capture = await client.rpc({ cmd: 'capture', name: 'nt-package-smoke', full: true })
  assert(capture.text.includes(marker))
  await client.rpc({ cmd: 'killSession', name: 'nt-package-smoke', operationId: randomUUID(), expectedGeneration: attached.generation, reserveReplacement: false })
  ownedSession = false
  assert.equal((await client.rpc({ cmd: 'hasSession', name: 'nt-package-smoke' })).exists, false)
  console.log('PASS: packaged modules/helpers, Unicode PTY input/output, resize, authentication, reconnect, capture and teardown')
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  if (ownedSession && client) await client.rpc({ cmd: 'killSession', name: 'nt-package-smoke', operationId: randomUUID(), reserveReplacement: false }).catch(() => {})
  client?.close()
  if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), pause(5000)]) }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
