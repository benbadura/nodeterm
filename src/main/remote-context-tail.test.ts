import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteContextTail, failureDelayMs, idleDelayMs, logsFailure } from './remote-context-tail'
import { RemoteFile, type RemoteFileRef } from './remote-ssh/remote-file'

const cap = 1024 * 1024
const ref: RemoteFileRef = { conn: { host: 'fixture', user: 'fixture' }, controlPath: '/unused', path: '/fixture' }
const usage = (used: number): string => JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: used } } }) + '\n'
const notification = (result: string): string => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: `<task-notification><tool-use-id>tu</tool-use-id><status>completed</status><result>${result}</result></task-notification>` }) + '\n'
const tool = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', content: 'done' }] } }) + '\n'
function harness(remote: Pick<RemoteFile, 'readContextWindow'>) {
  const send = vi.fn(), onTaskNotification = vi.fn(), onToolResult = vi.fn()
  const tail = createRemoteContextTail({ isDestroyed: () => false, webContents: { send } } as never, remote as RemoteFile, { onTaskNotification, onToolResult })
  return { tail, send, onTaskNotification, onToolResult }
}
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('remote context polling', () => {
  it('backs off failures to 60s, logs no remote error content, and recovers at the same offset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const readContextWindow = vi.fn().mockRejectedValue(new Error('SECRET transcript'))
    const h = harness({ readContextWindow })
    h.tail.track('s', ref)
    await flush()
    for (const delay of [2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      const calls = readContextWindow.mock.calls.length
      await vi.advanceTimersByTimeAsync(delay - 1000)
      expect(readContextWindow).toHaveBeenCalledTimes(calls)
      await vi.advanceTimersByTimeAsync(1000)
      expect(readContextWindow).toHaveBeenCalledTimes(calls + 1)
    }
    expect(warn.mock.calls.flat().join()).not.toContain('SECRET')
    // Eight failures, two lines: the first of the streak and the one that settles at the cap.
    expect(warn.mock.calls.map(c => c[0])).toEqual([
      '[remote-context-tail] Read for session s failed (unknown); retrying in 2000ms',
      '[remote-context-tail] Read for session s still failing after 6 attempts (unknown); retrying every 60000ms until it recovers'
    ])
    readContextWindow.mockResolvedValue({ data: Buffer.from(usage(120)), start: 0, newOffset: 200, initial: true })
    await vi.advanceTimersByTimeAsync(60000)
    expect(h.send.mock.calls.at(-1)?.[1].usedTokens).toBe(120)
    expect(warn.mock.calls.at(-1)?.[0]).toBe('[remote-context-tail] Read for session s recovered after 8 failed attempts')
    expect(warn).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(readContextWindow).toHaveBeenLastCalledWith(ref, 200, cap)
    h.tail.untrack('s')
  })

  it('serializes reads and ignores detached or replaced in-flight snapshots', async () => {
    let finish!: (value: unknown) => void
    const readContextWindow = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const h = harness({ readContextWindow } as never)
    h.tail.track('s', ref)
    const oldFinish = finish
    await vi.advanceTimersByTimeAsync(3000)
    expect(readContextWindow).toHaveBeenCalledTimes(1)
    h.tail.track('s', { ...ref, controlPath: '/new-owner' })
    oldFinish({ data: Buffer.from(usage(100)), newOffset: 100, initial: true })
    await flush()
    expect(h.send).not.toHaveBeenCalled()
    h.tail.untrack('s')
    finish({ data: Buffer.from(usage(200)), newOffset: 200, initial: true })
    await flush()
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe.skipIf(process.platform === 'win32')('real POSIX shell transcript fixture (no SSH/session access)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nt-transcript-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  function fixture(initial: string | Buffer | null) {
    const path = join(dir, "transcript ' fixture.jsonl")
    if (initial !== null) writeFileSync(path, initial)
    const transfers: number[] = []
    const reader = new RemoteFile(async args => {
      const stdout = execFileSync('/bin/sh', ['-c', args.at(-1)!], { encoding: 'utf8', maxBuffer: 2 * cap })
      transfers.push(Buffer.byteLength(stdout))
      return { code: 0, stdout }
    })
    const read = vi.spyOn(reader, 'readContextWindow')
    const h = harness(reader)
    h.tail.track('s', { ...ref, path })
    return { ...h, path, transfers, read }
  }

  it('bounds transfer for an idle >20 MiB file, starts at EOF, and never replays historical events', async () => {
    const history = notification('historical') + tool + usage(100)
    const content = Buffer.concat([Buffer.alloc(20 * cap, 10), Buffer.from(history)])
    const h = fixture(content)
    await flush()
    await expect(h.read.mock.results[0].value).resolves.toHaveProperty('newOffset', content.length)
    expect(h.send.mock.calls.at(-1)?.[1].usedTokens).toBe(100)
    expect(h.transfers[0]).toBeLessThan(1.6 * cap)
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.read.mock.calls.slice(1).every(c => c[1] === content.length)).toBe(true)
    expect(h.transfers.slice(1).every(n => n < 100)).toBe(true)
    expect(h.onTaskNotification).not.toHaveBeenCalled()
    expect(h.onToolResult).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledTimes(1)

    // Position the cap in the middle of a UTF-8 character inside a new notification.
    const event = Buffer.from(notification('yeni é 🐈'))
    const split = event.indexOf(Buffer.from('é')) + 1
    appendFileSync(h.path, Buffer.concat([Buffer.alloc(cap - split, 10), event, Buffer.from(tool + usage(200)), Buffer.alloc(18 * cap, 10)]))
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.onTaskNotification).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.onTaskNotification).toHaveBeenCalledExactlyOnceWith('s', expect.objectContaining({ result: 'yeni é 🐈' }))
    expect(h.onToolResult).toHaveBeenCalledExactlyOnceWith('s', 'tu')
    expect(h.send.mock.calls.at(-1)?.[1].usedTokens).toBe(200)
    expect(h.transfers.every(n => n < 1.6 * cap)).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.onTaskNotification).toHaveBeenCalledTimes(1)
    h.tail.untrack('s')
  })

  it('suppresses historical torn lines, resets after truncation, and handles an initially empty file', async () => {
    const h = fixture('')
    await flush()
    appendFileSync(h.path, notification('fresh') + usage(10))
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.onTaskNotification).toHaveBeenCalledTimes(1)
    const torn = notification('old').trimEnd()
    writeFileSync(h.path, torn.slice(0, -5))
    await vi.advanceTimersByTimeAsync(1000)
    appendFileSync(h.path, torn.slice(-5) + '\n' + notification('next'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.onTaskNotification.mock.calls.map(c => c[1].result)).toEqual(['fresh', 'next'])
    h.tail.untrack('s')
  })

  // Claude creates its transcript on the first prompt, but SessionStart hands the path over at
  // launch (measured on 2.1.283), so every unused remote Claude node starts here — and used to
  // walk the failure backoff to 60 s and log a line a minute for as long as it stayed unused.
  it('treats a transcript that does not exist yet as idle, then reads it from its first byte', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = fixture(null)
    await flush()
    await expect(h.read.mock.results[0].value).resolves.toMatchObject({ absent: true })
    for (let i = 0; i < 120; i++) await vi.advanceTimersByTimeAsync(1000)
    // Idle cadence (capped at 10 s), not the 60 s failure wait, and nothing logged.
    expect(h.read.mock.calls.length).toBeGreaterThan(12)
    expect(h.read.mock.calls.every(c => c[1] === null)).toBe(true)
    expect(warn).not.toHaveBeenCalled()

    // The first prompt: the file appears and its hook arrives. Everything in it is new.
    writeFileSync(h.path, notification('first turn') + tool + usage(300))
    const before = h.read.mock.calls.length
    h.tail.track('s', { ...ref, path: h.path })
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.read.mock.calls.length).toBe(before + 1)
    expect(h.send.mock.calls.at(-1)?.[1].usedTokens).toBe(300)
    expect(h.onTaskNotification).toHaveBeenCalledExactlyOnceWith('s', expect.objectContaining({ result: 'first turn' }))
    expect(h.onToolResult).toHaveBeenCalledExactlyOnceWith('s', 'tu')

    // Removed and written again (not a realistic Claude path, but the same rule): new bytes, live.
    unlinkSync(h.path)
    await vi.advanceTimersByTimeAsync(1000)
    writeFileSync(h.path, notification('rewritten') + usage(400))
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.onTaskNotification.mock.calls.map(c => c[1].result)).toEqual(['first turn', 'rewritten'])
    expect(warn).not.toHaveBeenCalled()
    h.tail.untrack('s')
  })
})

describe('a file that appears after it was missing', () => {
  it('is history again when it arrives bigger than the bootstrap window', async () => {
    const readContextWindow = vi.fn()
      .mockResolvedValue({ data: Buffer.alloc(0), start: 5000, newOffset: 5000, initial: false })
      .mockResolvedValueOnce({ data: Buffer.alloc(0), start: 0, newOffset: 0, initial: false, absent: true })
      .mockResolvedValueOnce({ data: Buffer.from(notification('copied in') + usage(50)), start: 4000, newOffset: 5000, initial: true })
    const h = harness({ readContextWindow })
    try {
      h.tail.track('s', ref)
      await flush()
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.send.mock.calls.at(-1)?.[1].usedTokens).toBe(50)
      // Bytes before `start` were never seen: this is someone else's history, not a new turn.
      expect(h.onTaskNotification).not.toHaveBeenCalled()
    } finally { h.tail.untrack('s') }
  })
})

describe('failure log and wait', () => {
  it('logs the first failure and the one that reaches the cap, and nothing in between', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(failureDelayMs)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000])
    expect(Array.from({ length: 30 }, (_, i) => i + 1).filter(logsFailure)).toEqual([1, 6])
  })

  it('names the observed status, never the reply', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reader = new RemoteFile(async () => ({ code: 255, stdout: 'SECRET banner' }))
    const h = harness(reader)
    try {
      h.tail.track('0123456789abcdef', ref)
      await flush()
      expect(warn.mock.calls[0][0]).toBe('[remote-context-tail] Read for session 01234567 failed (exit 255); retrying in 2000ms')
    } finally { h.tail.untrack('0123456789abcdef') }
  })

  it('a hook for the session skips the rest of the failure wait, keeping the streak', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const readContextWindow = vi.fn().mockRejectedValue(new Error('down'))
    const h = harness({ readContextWindow })
    try {
      h.tail.track('s', ref)
      await flush()
      for (const delay of [2000, 4000, 8000, 16000, 32000]) await vi.advanceTimersByTimeAsync(delay)
      expect(readContextWindow).toHaveBeenCalledTimes(6) // now 60 s away
      h.tail.track('s', { ...ref, conn: { ...ref.conn } })
      await vi.advanceTimersByTimeAsync(1000)
      expect(readContextWindow).toHaveBeenCalledTimes(7)
      // Still failing: straight back to the capped wait, not to 2 s.
      await vi.advanceTimersByTimeAsync(59_000)
      expect(readContextWindow).toHaveBeenCalledTimes(7)
      await vi.advanceTimersByTimeAsync(1000)
      expect(readContextWindow).toHaveBeenCalledTimes(8)
    } finally { h.tail.untrack('s') }
  })
})

describe('session windows with bounded remote reads', () => {
  it('updates and removes the override without new bytes, replaying only on request', async () => {
    const readContextWindow = vi.fn()
      .mockResolvedValue({ data: Buffer.alloc(0), newOffset: 200, initial: false })
      .mockResolvedValueOnce({ data: Buffer.from(usage(16000)), newOffset: 200, initial: true })
    const { tail, send } = harness({ readContextWindow })
    try {
      tail.track('env', ref, 32000)
      await flush()
      expect(send.mock.calls.at(-1)![1]).toMatchObject({ windowTokens: 32000, usedPercent: 50, windowSource: 'session-env' })
      tail.track('env', { ...ref, conn: { ...ref.conn } }, 32000)
      tail.track('env', ref)
      await vi.advanceTimersByTimeAsync(1000)
      expect(send).toHaveBeenCalledTimes(1)
      tail.replay('env')
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls.at(-1)![1]).toMatchObject({ windowTokens: 32000, windowSource: 'session-env' })
      tail.track('env', ref, 64000)
      await flush()
      expect(send.mock.calls.at(-1)![1]).toMatchObject({ windowTokens: 64000, usedPercent: 25, windowSource: 'session-env' })
      tail.track('env', ref, null)
      await flush()
      const estimate = send.mock.calls.at(-1)![1].windowTokens
      expect(send.mock.calls.at(-1)![1]).toMatchObject({ windowSource: 'estimate' })
      // Even when the denominator is unchanged, the observation's provenance must update.
      tail.track('env', ref, estimate)
      await flush()
      expect(send.mock.calls.at(-1)![1]).toMatchObject({ windowTokens: estimate, windowSource: 'session-env' })
      expect(readContextWindow.mock.calls.slice(1).every(c => c[1] === 200)).toBe(true)
    } finally { tail.untrack('env') }
  })

  it.each([
    { ...ref, path: '/abs/new.jsonl' },
    { ...ref, controlPath: '/new-owner' },
    { ...ref, conn: { ...ref.conn, host: 'new-host' } }
  ])('replaces the generation for changed reference %j, rejecting stale reads', async replacement => {
    let finishOld!: (value: unknown) => void
    const readContextWindow = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValue({ data: Buffer.from(usage(16000)), newOffset: 200, initial: true })
    const { tail, send } = harness({ readContextWindow })
    try {
      tail.track('replaced', ref, 32000)
      tail.track('replaced', replacement)
      await flush()
      expect(readContextWindow).toHaveBeenLastCalledWith(replacement, null, cap)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][1]).toMatchObject({ usedTokens: 16000, windowSource: 'estimate' })
      finishOld({ data: Buffer.from(usage(1)), newOffset: 100, initial: true })
      await flush()
      tail.replay('replaced')
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls.at(-1)![1]).toMatchObject({ usedTokens: 16000, windowSource: 'estimate' })
    } finally { tail.untrack('replaced') }
  })

  it('applies the latest window when an existing read completes', async () => {
    let finish!: (value: unknown) => void
    const readContextWindow = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const { tail, send } = harness({ readContextWindow } as never)
    try {
      tail.track('s', ref, 32000)
      tail.track('s', ref, 64000)
      expect(readContextWindow).toHaveBeenCalledTimes(1)
      finish({ data: Buffer.from(usage(16000)), newOffset: 200, initial: true })
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][1]).toMatchObject({ windowTokens: 64000, windowSource: 'session-env' })
    } finally { tail.untrack('s') }
  })
})

it('passes only live SSH result IDs to the correlated answer consumer', async () => {
  const result = (id: string) => JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: id, content: 'User declined to answer questions' }
  ] } }) + '\n'
  const readContextWindow = vi.fn()
    .mockResolvedValueOnce({ data: Buffer.from(result('historical')), start: 0, newOffset: 100, initial: true })
    .mockResolvedValueOnce({ data: Buffer.from(result('other') + result('ask')), start: 100, newOffset: 300, initial: false })
  const h = harness({ readContextWindow })
  try {
    h.tail.track('session', ref)
    await flush()
    expect(h.onToolResult).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.onToolResult.mock.calls).toEqual([['session', 'other'], ['session', 'ask']])
  } finally { h.tail.untrack('session') }
})

describe('idle backoff', () => {
  const idleRemote = () => vi.fn()
    .mockResolvedValue({ data: Buffer.alloc(0), newOffset: 4096, initial: false })
    .mockResolvedValueOnce({ data: Buffer.from(usage(100)), newOffset: 4096, initial: true })

  it('idleDelayMs keeps 1 s polling for the first three empty reads, then backs off to 10 s', () => {
    expect([1, 2, 3].map(idleDelayMs)).toEqual([0, 0, 0])
    expect(idleDelayMs(4)).toBe(2000)
    expect(idleDelayMs(5)).toBe(4000)
    expect(idleDelayMs(6)).toBe(8000)
    expect(idleDelayMs(7)).toBe(10_000)
    expect(idleDelayMs(50)).toBe(10_000)
  })

  it('stops reading every second once the transcript has been idle', async () => {
    const readContextWindow = idleRemote()
    const { tail } = harness({ readContextWindow })
    try {
      tail.track('s1', ref)
      await flush()
      for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(1000)
      // Unbacked-off polling would read 31 times (the immediate read plus one per tick).
      expect(readContextWindow.mock.calls.length).toBeLessThan(15)
    } finally { tail.untrack('s1') }
  })

  it('a read that returns data resets the streak', async () => {
    const readContextWindow = idleRemote()
    const { tail } = harness({ readContextWindow })
    try {
      tail.track('s1', ref)
      await flush()
      for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(1000)
      // Backed off: the next read lands only once idleUntil passes. Make it carry data.
      readContextWindow.mockResolvedValueOnce({ data: Buffer.from(usage(200)), newOffset: 8192, initial: false })
      const backedOff = readContextWindow.mock.calls.length
      while (readContextWindow.mock.calls.length === backedOff) await vi.advanceTimersByTimeAsync(1000)
      expect(tail.offsetFor('s1')).toBe(8192)
      const before = readContextWindow.mock.calls.length
      await vi.advanceTimersByTimeAsync(3000)
      // Streak reset: back to one read per tick for the next three empty reads.
      expect(readContextWindow.mock.calls.length - before).toBe(3)
    } finally { tail.untrack('s1') }
  })

  it('track() of the same ref resets the backoff (a hook arrived)', async () => {
    const readContextWindow = idleRemote()
    const { tail } = harness({ readContextWindow })
    try {
      tail.track('s1', ref)
      await flush()
      for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(1000)
      // Land just after a backed-off read so the next one is ~10 s away.
      let before = readContextWindow.mock.calls.length
      while (readContextWindow.mock.calls.length === before) await vi.advanceTimersByTimeAsync(1000)
      before = readContextWindow.mock.calls.length
      tail.track('s1', { ...ref, conn: { ...ref.conn } })
      await vi.advanceTimersByTimeAsync(1100)
      expect(readContextWindow.mock.calls.length - before).toBe(1)
    } finally { tail.untrack('s1') }
  })

  it('a failed read keeps the failure backoff, not the idle one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const readContextWindow = idleRemote()
    const { tail } = harness({ readContextWindow })
    try {
      tail.track('s1', ref)
      await flush()
      readContextWindow.mockRejectedValueOnce(new Error('down'))
      await vi.advanceTimersByTimeAsync(1000)
      const before = readContextWindow.mock.calls.length
      await vi.advanceTimersByTimeAsync(1000)
      expect(readContextWindow.mock.calls.length).toBe(before)
      await vi.advanceTimersByTimeAsync(1000)
      expect(readContextWindow.mock.calls.length).toBe(before + 1)
    } finally { tail.untrack('s1') }
  })

  it('offsetFor reports the last read offset', async () => {
    const readContextWindow = idleRemote()
    const { tail } = harness({ readContextWindow })
    try {
      expect(tail.offsetFor('s1')).toBeNull()
      tail.track('s1', ref)
      await flush()
      expect(tail.offsetFor('s1')).toBe(4096)
      expect(tail.offsetFor('unknown')).toBeNull()
      expect(tail.offsetFor(undefined)).toBeNull()
    } finally { tail.untrack('s1') }
  })
})
