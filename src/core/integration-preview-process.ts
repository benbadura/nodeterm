import { execFile, spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { createSetupOutputStream } from './setup-output-stream'
import { gitEnv } from './git-env'
import { shellPathNow } from './exec-path'

export function previewProcessEnv(cwd?: string): NodeJS.ProcessEnv {
  const env = gitEnv()
  // A canvas agent may inherit Git's repository/index overrides. Every preview chooses its own cwd.
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  env.GIT_TERMINAL_PROMPT = '0'
  const loginPath = shellPathNow()
  if (loginPath) {
    const pathKey = process.platform === 'win32' ? Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path' : 'PATH'
    env[pathKey] = loginPath
  }
  if (cwd) {
    env.CI = '1'
    delete env.VIRTUAL_ENV
    env.UV_PROJECT_ENVIRONMENT = `${cwd}/.venv`
    env.CARGO_TARGET_DIR = `${cwd}/target`
  }
  return env
}

export function previewShell(command: string, windows = process.platform === 'win32'): { executable: string; args: string[]; windowsVerbatimArguments?: boolean } {
  return windows
    ? { executable: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true }
    : { executable: 'sh', args: ['-lc', command] }
}

export interface PreviewProcessResult {
  exitCode: number
  out: string
  err: string
  timedOut: boolean
}

/** Bounded output, one completion, and whole-tree cancellation on both Desktop platforms. */
export function runPreviewProcess(opts: {
  executable: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs: number
  onChunk?: (text: string) => void
  onPid?: (pid: number | undefined) => void
  windowsVerbatimArguments?: boolean
}): Promise<PreviewProcessResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) return resolve({ exitCode: 143, out: '', err: '', timedOut: false })
    const child = spawn(opts.executable, opts.args, {
      cwd: opts.cwd, env: opts.env ?? previewProcessEnv(),
      windowsVerbatimArguments: opts.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32'
    })
    let done = false
    let timedOut = false
    let out = ''
    let err = ''
    const decoderOut = new StringDecoder('utf8')
    const decoderErr = new StringDecoder('utf8')
    const stream = createSetupOutputStream(opts.onChunk ?? (() => {}))
    const killTree = () => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {})
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ }
      }
    }
    const timer = setTimeout(() => { timedOut = true; killTree() }, opts.timeoutMs)
    timer.unref?.()
    opts.signal?.addEventListener('abort', killTree, { once: true })
    const append = (which: 'out' | 'err', text: string) => {
      // Structured Git reads are small; avoid retaining unbounded test output twice.
      if (which === 'out') out = (out + text).slice(0, 1024 * 1024)
      else err = (err + text).slice(0, 1024 * 1024)
      stream.append(text)
    }
    const finish = (code: number) => {
      if (done) return
      done = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', killTree)
      append('out', decoderOut.end())
      append('err', decoderErr.end())
      stream.flush()
      // Background children with redirected output must not outlive the preview command.
      killTree()
      opts.onPid?.(undefined)
      resolve({ exitCode: code, out, err, timedOut })
    }
    child.once('spawn', () => opts.onPid?.(child.pid))
    child.stdout?.on('data', (b: Buffer) => append('out', decoderOut.write(b)))
    child.stderr?.on('data', (b: Buffer) => append('err', decoderErr.write(b)))
    child.once('error', (e) => { append('err', `${e.message}\n`); finish(127) })
    child.once('close', (code) => finish(code ?? 1))
  })
}
