// The bounded `opencode export <id>` both readers share (Context Link's flat lines and the ⌘M chat
// view). What this pins is the TRI-STATE the chat view needs and Context Link never did: a session
// opencode positively reports as missing is a clean miss (`absent`), while every other failure —
// no binary, a crash, a timeout, an oversized export — is a failed read. Measured on opencode
// 1.18.25: an unknown id exits 1 with an empty stdout and `Session not found: <id>` on stderr.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runOpencodeExportAt } from './opencode-export'

/** A stand-in `opencode` running `script` under this Node: a cmd shim on Windows (the shape npm
 *  installs there), an executable sh script elsewhere. Same helper as the Context Link test. */
function writeFakeOpencode(dir: string, script: string): string {
  const js = path.join(dir, 'opencode.js')
  fs.writeFileSync(js, script)
  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'opencode.cmd')
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`)
    return cmd
  }
  const sh = path.join(dir, 'opencode')
  fs.writeFileSync(sh, `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`, { mode: 0o755 })
  return sh
}

const SID = 'ses_0a1b2c3d4ffeSynthetic000001'

describe('runOpencodeExportAt — the tri-state', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-opencode-export-tri-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('passes exactly `export <id>` on argv and returns stdout', async () => {
    const bin = writeFakeOpencode(
      dir,
      "process.stderr.write('Exporting session: x\\n'); process.stdout.write(JSON.stringify(process.argv.slice(2)))\n"
    )
    const out = await runOpencodeExportAt(bin, SID, 10_000)
    expect(out.ok).toBe(true)
    expect(out.ok && JSON.parse(out.stdout)).toEqual(['export', SID])
  })

  it('reads the measured "Session not found" exit as a clean miss', async () => {
    // Verbatim shape of 1.18.25's answer, ANSI colouring included.
    const bin = writeFakeOpencode(
      dir,
      `process.stderr.write('Exporting session: ${SID}\\n\\x1b[91m\\x1b[1mError: \\x1b[0mSession not found: ${SID}\\n'); process.exit(1)\n`
    )
    expect(await runOpencodeExportAt(bin, SID, 10_000)).toEqual({ ok: false, absent: true })
  })

  it('a "not found" naming ANOTHER id is not evidence about this one', async () => {
    const bin = writeFakeOpencode(dir, "process.stderr.write('Session not found: ses_other\\n'); process.exit(1)\n")
    expect(await runOpencodeExportAt(bin, SID, 10_000)).toEqual({ ok: false })
  })

  it('the not-found line under any exit status but the measured 1 is not a clean miss', async () => {
    const bin = writeFakeOpencode(dir, `process.stderr.write('Session not found: ${SID}\\n'); process.exit(2)\n`)
    expect(await runOpencodeExportAt(bin, SID, 10_000)).toEqual({ ok: false })
  })

  it('any other failure is a failed read, never absence', async () => {
    const bin = writeFakeOpencode(dir, "process.stderr.write('database is locked\\n'); process.exit(1)\n")
    expect(await runOpencodeExportAt(bin, SID, 10_000)).toEqual({ ok: false })
  })

  it('a not-found message with output on stdout is not a clean miss', async () => {
    const bin = writeFakeOpencode(
      dir,
      `process.stdout.write('{}'); process.stderr.write('Session not found: ${SID}\\n'); process.exit(1)\n`
    )
    expect(await runOpencodeExportAt(bin, SID, 10_000)).toEqual({ ok: false })
  })

  it('a wedged CLI is killed at the timeout and reads as a failure', async () => {
    const bin = writeFakeOpencode(dir, 'setTimeout(() => {}, 60000)\n')
    const t0 = Date.now()
    expect(await runOpencodeExportAt(bin, SID, 300)).toEqual({ ok: false })
    expect(Date.now() - t0).toBeLessThan(10_000)
  })

  it('runs outside the app cwd (os.tmpdir), so opencode never bootstraps inside a repo', async () => {
    // Run from inside a repo, an export writes `<repo>/.git/opencode`. Sessions resolve by their
    // global id, so the cwd carries no meaning for the read.
    const bin = writeFakeOpencode(dir, 'process.stdout.write(process.cwd())\n')
    const out = await runOpencodeExportAt(bin, SID, 10_000)
    expect(out.ok && fs.realpathSync(out.stdout)).toBe(fs.realpathSync(os.tmpdir()))
  })

  it('a binary that does not exist is a failure', async () => {
    expect(await runOpencodeExportAt(path.join(dir, 'nope'), SID, 10_000)).toEqual({ ok: false })
  })
})
