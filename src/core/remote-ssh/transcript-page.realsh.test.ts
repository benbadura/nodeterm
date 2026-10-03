// The paged ⌘M transcript read's remote command, executed by a REAL /bin/sh against a real file.
//
// Generated shell is source no compiler checks (see canvas-control-shim / remote-claude-usage /
// session-memory-remote tests for the same discipline): only running it proves the arithmetic, the
// dd block alignment and the framing agree with the parser — and that a hostile path stays a path.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseTranscriptPage, transcriptPageCommand } from './transcript-window'
import { parseChatWindow } from '../transcript-reader'
import { fakePlatform } from '../platform-fake'
import { initPlatform, resetPlatformForTests } from '../platform'
import { registerTranscriptIpc } from '../transcript-ipc'
import { IPC } from '../../shared/ipc'
import type { ChatTranscriptResult } from '../../shared/types'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-page-sh-'))
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const run = (cmd: string): string =>
  execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
const write = (name: string, body: Buffer | string): string => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, body)
  return p
}
const page = (p: string, before: number | null, maxBytes: number) =>
  parseTranscriptPage(run(transcriptPageCommand(p, before, maxBytes)), before, maxBytes)

// Expected window, computed independently of the shell: [windowStart - lookbehind, end).
const expected = (file: Buffer, before: number | null, maxBytes: number) => {
  const end = before === null || before > file.length ? file.length : before
  const ws = Math.max(0, end - maxBytes)
  const start = ws > 0 ? ws - 1 : 0
  return { start, end, data: file.subarray(start, end) }
}

describe('transcriptPageCommand under /bin/sh', () => {
  // Bigger than two dd blocks (64 KiB), with multi-byte chars everywhere, so unaligned starts,
  // block-straddling windows and split characters are all exercised.
  const lines: string[] = []
  for (let i = 0; i < 3000; i++) {
    lines.push(JSON.stringify({ type: 'user', message: { content: `satır ${i} — ğüşiöç ✓` } }))
  }
  const file = Buffer.from(lines.join('\n') + '\n')

  it.each([
    [null, 65536],
    [null, 1_000_000],
    [70_001, 65536],
    [131_073, 65537],
    [10, 65536],
    [0, 65536],
    [999_999_999, 65536]
  ])('before=%s maxBytes=%s returns exactly the expected bytes', (before, maxBytes) => {
    const p = write('big.jsonl', file)
    const got = page(p, before, maxBytes)
    const want = expected(file, before, maxBytes)
    expect(got.start).toBe(want.start)
    expect(got.end).toBe(want.end)
    expect(got.size).toBe(file.length)
    expect(got.data.equals(want.data)).toBe(true)
  })

  it('pages back to the start of the file with every line seen exactly once', () => {
    const p = write('big.jsonl', file)
    const seen: string[] = []
    let before: number | null = null
    for (let guard = 0; guard < 100; guard++) {
      const w = page(p, before, 65536)
      const r = parseChatWindow(w.data, w.start)
      seen.unshift(...r.messages.map((m) => (m.parts[0] as { text: string }).text))
      if (r.olderCursor === null) break
      before = r.olderCursor
    }
    expect(seen).toEqual(Array.from({ length: 3000 }, (_, i) => `satır ${i} — ğüşiöç ✓`))
  })

  it('an empty file is an answer (size 0, no bytes), not a failure', () => {
    const p = write('empty.jsonl', '')
    const got = page(p, null, 65536)
    expect(got).toMatchObject({ start: 0, end: 0, size: 0 })
    expect(got.data.length).toBe(0)
  })

  it('a missing file fails the command (non-zero exit), never an empty page', () => {
    expect(() => run(transcriptPageCommand(path.join(dir, 'nope.jsonl'), null, 65536))).toThrow()
  })

  it('a hostile path stays one quoted word', () => {
    // Runs with cwd = dir, so an injected `touch pwned` would leave the marker right here.
    const marker = path.join(dir, 'pwned')
    const evil = write(`x'; touch pwned; echo $(touch pwned) '.jsonl`, 'hello\n')
    const got = page(evil, null, 65536)
    expect(got.data.toString()).toBe('hello\n')
    expect(fs.existsSync(marker)).toBe(false)
  })
})

// The whole remote leg of a paged read — core's `readChatPage` driving the REAL generated command —
// on the case that used to lose data: a final line bigger than the page (a pasted screenshot). The
// tail window holds no complete line, and core must grow it over ssh rather than skip the record.
describe('paged chat read over a real /bin/sh — a final line bigger than the window', () => {
  afterAll(() => resetPlatformForTests())

  it('the 300 KB last record is in the first (tail) page', async () => {
    const small = JSON.stringify({ type: 'user', message: { content: 'look at this' } })
    const big = JSON.stringify({ type: 'user', message: { content: `IMG ${'Q'.repeat(300 * 1024)}` } })
    const p = write('screenshot.jsonl', `${small}\n${big}\n`)
    const f = fakePlatform()
    initPlatform(f)
    const asked: number[] = []
    registerTranscriptIpc({
      readRemotePage: async (_q, pg) => {
        asked.push(pg.maxBytes)
        const w = page(p, pg.before, pg.maxBytes)
        return { ok: true, data: w.data, start: w.start }
      }
    })
    const res = (await f.handlers[IPC.chatReadTranscript](
      '46b36ce2-dd77-4f5e-a89e-4a0e831e83df', '/srv', undefined, 'nt-1', undefined, { maxBytes: 65536 }
    )) as ChatTranscriptResult
    expect(res.found).toBe(true)
    const texts = res.messages.map((m) => (m.parts[0] as { text: string }).text)
    expect(texts.at(-1)?.startsWith('IMG QQQ')).toBe(true)
    expect(texts.at(-1)?.length).toBe(4 + 300 * 1024)
    expect(asked[0]).toBe(65536)
    expect(asked.length).toBeGreaterThan(1)
  })
})
