import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testTmpDir } from './test-tmp'
import { previewShell, runPreviewProcess } from './integration-preview-process'

describe('integration preview process execution', () => {
  it('selects the native command shell', () => {
    expect(previewShell('echo hello', false)).toEqual({ executable: 'sh', args: ['-lc', 'echo hello'] })
    expect(previewShell('echo hello', true).args).toEqual(['/d', '/s', '/c', '"echo hello"'])
    expect(previewShell('echo "hello world"', true).windowsVerbatimArguments).toBe(true)
  })
  it('distinguishes timeouts and kills children that keep output pipes open', async () => {
    const cwd = testTmpDir('preview-process-')
    const pidFile = path.join(cwd, 'child.pid')
    const script = `const {spawn}=require('child_process'); const fs=require('fs'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:['ignore',process.stdout,process.stderr]}); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setTimeout(()=>{},30000)`
    const result = await runPreviewProcess({ executable: process.execPath, args: ['-e', script], cwd, timeoutMs: 400 })
    expect(result.timedOut).toBe(true)
    const pid = Number(await fs.readFile(pidFile, 'utf8'))
    // A just-killed child may briefly be a zombie; it must stop running and release the pipes.
    expect(result.exitCode).not.toBe(0)
    if (process.platform !== 'win32') {
      const { execFileSync } = await import('node:child_process')
      let state = ''
      try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim() } catch { /* Gone. */ }
      expect(state === '' || state.startsWith('Z')).toBe(true)
    }
  })
  it('caps streamed logs without losing the exit code and handles missing binaries', async () => {
    const cwd = testTmpDir('preview-process-')
    let log = ''
    const result = await runPreviewProcess({
      executable: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(700000)); process.exitCode=9'], cwd, timeoutMs: 3000,
      onChunk: (text) => { log += text }
    })
    expect(result.exitCode).toBe(9)
    expect(log).toContain('[output truncated')
    expect(log.length).toBeLessThan(513 * 1024)
    const missing = await runPreviewProcess({ executable: path.join(cwd, 'does-not-exist'), args: [], cwd, timeoutMs: 3000 })
    expect(missing.exitCode).toBe(127)
    expect(missing.err).toContain('ENOENT')
  })
  it('does not spawn a process when cancelled before execution', async () => {
    const abort = new AbortController()
    abort.abort()
    const result = await runPreviewProcess({ executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', signal: abort.signal, timeoutMs: 1000 })
    expect(result.exitCode).toBe(143)
  })
})
