// Review fixes for the opencode ⌘M reader: the stat change gate + bounded parsed cache, the
// background-refresh spacing, and the page-size contract (`page.maxBytes`, an oversized newest
// message). Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  createOpencodeChatCache,
  createOpencodeExportGate,
  opencodeDataDir,
  opencodeDbFingerprint,
  readOpencodeChat
} from './opencode-chat'
import { normalizeChatPage } from '../shared/chat-page'
import type { OpencodeExportOutcome } from './opencode-export'
import type { ChatMessage } from '../shared/types'

const SID = 'ses_0a1b2c3d4ffeSynthetic000001'
const doc = (messages: unknown[]): string =>
  JSON.stringify({ info: { id: SID }, messages }, null, 2) + '\n'
const msg = (i: number, role: 'user' | 'assistant', t: string) => ({
  info: { id: `msg_${i}`, sessionID: SID, role, time: { created: i } },
  parts: [{ id: `prt_${i}`, type: 'text', text: t }]
})
const textOf = (m: ChatMessage) => (m.parts[0] as { text: string }).text

describe('opencodeDataDir — the same resolution opencode uses (xdg-basedir)', () => {
  it('XDG_DATA_HOME wins, else ~/.local/share; "opencode" under it', () => {
    expect(opencodeDataDir({ XDG_DATA_HOME: '/x/data' }, '/home/u')).toBe(path.join('/x/data', 'opencode'))
    expect(opencodeDataDir({}, '/home/u')).toBe(path.join('/home/u', '.local', 'share', 'opencode'))
    expect(opencodeDataDir({ XDG_DATA_HOME: '' }, '/home/u')).toBe(path.join('/home/u', '.local', 'share', 'opencode'))
  })
})

describe('opencodeDbFingerprint — stat, never open', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-fp-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('changes when the WAL changes, and is stable otherwise', async () => {
    fs.writeFileSync(path.join(dir, 'opencode.db'), 'a')
    fs.writeFileSync(path.join(dir, 'opencode.db-wal'), 'w')
    const a = await opencodeDbFingerprint(dir, {})
    expect(a).not.toBeNull()
    expect(await opencodeDbFingerprint(dir, {})).toBe(a)
    fs.appendFileSync(path.join(dir, 'opencode.db-wal'), 'more')
    expect(await opencodeDbFingerprint(dir, {})).not.toBe(a)
  })

  it('a missing WAL is a state, not a failure; the db changing changes it', async () => {
    fs.writeFileSync(path.join(dir, 'opencode.db'), 'a')
    const a = await opencodeDbFingerprint(dir, {})
    expect(a).not.toBeNull()
    fs.appendFileSync(path.join(dir, 'opencode.db'), 'b')
    expect(await opencodeDbFingerprint(dir, {})).not.toBe(a)
  })

  it('covers a channel-named database too (opencode-<channel>.db)', async () => {
    fs.writeFileSync(path.join(dir, 'opencode-dev.db'), 'a')
    const a = await opencodeDbFingerprint(dir, {})
    expect(a).not.toBeNull()
    fs.writeFileSync(path.join(dir, 'opencode-dev.db-wal'), 'w')
    expect(await opencodeDbFingerprint(dir, {})).not.toBe(a)
  })

  it('cannot gate (null) with no database, an unreadable dir, or an OPENCODE_DB override', async () => {
    expect(await opencodeDbFingerprint(dir, {})).toBeNull()
    expect(await opencodeDbFingerprint(path.join(dir, 'nope'), {})).toBeNull()
    fs.writeFileSync(path.join(dir, 'opencode.db'), 'a')
    expect(await opencodeDbFingerprint(dir, { OPENCODE_DB: '/elsewhere.db' })).toBeNull()
  })
})

describe('readOpencodeChat — the change gate', () => {
  const page = normalizeChatPage({ maxBytes: 262144 })
  const OK = doc([msg(1, 'user', 'hi'), msg(2, 'assistant', 'yo')])

  it('an unchanged database answers from the cache: no second export', async () => {
    const run = vi.fn(async (): Promise<OpencodeExportOutcome> => ({ ok: true, stdout: OK }))
    const cache = createOpencodeChatCache({ fingerprint: async () => 'fp1', maxSessions: 4 })
    const a = await readOpencodeChat({ sessionId: SID }, page, run, cache)
    const b = await readOpencodeChat({ sessionId: SID }, page, run, cache)
    expect(b).toStrictEqual(a)
    expect(a.messages).toHaveLength(2)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a changed database exports again', async () => {
    let fp = 'fp1'
    const run = vi.fn(async (): Promise<OpencodeExportOutcome> => ({ ok: true, stdout: OK }))
    const cache = createOpencodeChatCache({ fingerprint: async () => fp, maxSessions: 4 })
    await readOpencodeChat({ sessionId: SID }, page, run, cache)
    fp = 'fp2'
    await readOpencodeChat({ sessionId: SID }, page, run, cache)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('the fingerprint is taken BEFORE the export (a write during it forces the next export)', async () => {
    const order: string[] = []
    const run = vi.fn(async (): Promise<OpencodeExportOutcome> => {
      order.push('export')
      return { ok: true, stdout: OK }
    })
    const cache = createOpencodeChatCache({
      fingerprint: async () => {
        order.push('stat')
        return 'fp'
      },
      maxSessions: 4
    })
    await readOpencodeChat({ sessionId: SID }, page, run, cache)
    expect(order).toEqual(['stat', 'export'])
  })

  it('no fingerprint (cannot gate) never caches; a failure is never cached', async () => {
    const run = vi.fn(async (): Promise<OpencodeExportOutcome> => ({ ok: true, stdout: OK }))
    const nullCache = createOpencodeChatCache({ fingerprint: async () => null, maxSessions: 4 })
    await readOpencodeChat({ sessionId: SID }, page, run, nullCache)
    await readOpencodeChat({ sessionId: SID }, page, run, nullCache)
    expect(run).toHaveBeenCalledTimes(2)

    const flaky = vi
      .fn<() => Promise<OpencodeExportOutcome>>()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, stdout: OK })
    const cache = createOpencodeChatCache({ fingerprint: async () => 'fp', maxSessions: 4 })
    expect((await readOpencodeChat({ sessionId: SID }, page, flaky, cache)).found).toBe(false)
    expect((await readOpencodeChat({ sessionId: SID }, page, flaky, cache)).found).toBe(true)
    expect(flaky).toHaveBeenCalledTimes(2)
  })

  it('is bounded: least-recently-used session evicted', async () => {
    const ids = ['ses_a', 'ses_b', 'ses_c']
    const run = vi.fn(async (id: string): Promise<OpencodeExportOutcome> => ({
      ok: true,
      stdout: JSON.stringify({ info: { id }, messages: [] })
    }))
    const cache = createOpencodeChatCache({ fingerprint: async () => 'fp', maxSessions: 2 })
    await readOpencodeChat({ sessionId: ids[0] }, page, run, cache)
    await readOpencodeChat({ sessionId: ids[1] }, page, run, cache)
    await readOpencodeChat({ sessionId: ids[0] }, page, run, cache) // hit; a is now most recent
    await readOpencodeChat({ sessionId: ids[2] }, page, run, cache) // evicts b
    expect(run).toHaveBeenCalledTimes(3)
    await readOpencodeChat({ sessionId: ids[0] }, page, run, cache)
    expect(run).toHaveBeenCalledTimes(3)
    await readOpencodeChat({ sessionId: ids[1] }, page, run, cache)
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('passes background to the runner so the gate can space live refreshes', async () => {
    const run = vi.fn(async (): Promise<OpencodeExportOutcome> => ({ ok: true, stdout: OK }))
    await readOpencodeChat({ sessionId: SID }, normalizeChatPage({ maxBytes: 262144, background: true }), run, null)
    await readOpencodeChat({ sessionId: SID }, page, run, null)
    expect(run.mock.calls).toEqual([
      [SID, { background: true }],
      [SID, { background: false }]
    ])
  })
})

describe('normalizeChatPage — background', () => {
  it('only a literal true marks a read as background', () => {
    expect(normalizeChatPage({ background: true })?.background).toBe(true)
    expect(normalizeChatPage({ background: 'yes' })).not.toHaveProperty('background')
    expect(normalizeChatPage({})).not.toHaveProperty('background')
  })
})

describe('createOpencodeExportGate — background spacing', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('a background refresh waits the background spacing; an explicit read does not wait', async () => {
    let t = 10_000
    const sleeps: number[] = []
    const run = vi.fn(async () => ({ ok: true as const, stdout: 'x' }))
    const gate = createOpencodeExportGate(run, {
      minSpacingMs: 0,
      backgroundSpacingMs: 5000,
      maxConcurrent: 2,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms)
        t += ms
      }
    })
    await gate(SID)
    t += 1000
    await gate(SID, { background: true })
    expect(sleeps).toEqual([4000])
    t += 1000
    await gate(SID)
    expect(sleeps).toEqual([4000])
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('an explicit read joining a sleeping background refresh wakes it', async () => {
    const run = vi.fn(async () => ({ ok: true as const, stdout: 'x' }))
    const never = new Promise<void>(() => {})
    const gate = createOpencodeExportGate(run, {
      minSpacingMs: 0,
      backgroundSpacingMs: 5000,
      maxConcurrent: 2,
      sleep: () => never
    })
    await gate(SID)
    const bg = gate(SID, { background: true })
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    const explicit = gate(SID)
    expect(await explicit).toEqual({ ok: true, stdout: 'x' })
    expect(await bg).toEqual({ ok: true, stdout: 'x' })
    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe('readOpencodeChat — page size', () => {
  const run = (stdout: string) => async (): Promise<OpencodeExportOutcome> => ({ ok: true, stdout })

  it('honours a smaller page.maxBytes (the phone asks for 256 KB)', async () => {
    const stdout = doc([1, 2, 3, 4].map((i) => msg(i, 'assistant', String(i).repeat(100 * 1024))))
    const res = await readOpencodeChat({ sessionId: SID }, normalizeChatPage({ maxBytes: 262144 }), run(stdout), null)
    expect(res.messages.map((m) => textOf(m)[0])).toEqual(['3', '4'])
  })

  it('a newest message bigger than the page grows the window like claude (×4 up to 5 MB)', async () => {
    const stdout = doc([1, 2, 3].map((i) => msg(i, 'assistant', String(i).repeat(400 * 1024))))
    const res = await readOpencodeChat({ sessionId: SID }, normalizeChatPage({ maxBytes: 262144 }), run(stdout), null)
    // 256 KB holds none; 1 MB holds the two newest.
    expect(res.messages.map((m) => textOf(m)[0])).toEqual(['2', '3'])
    expect(textOf(res.messages[1])).toHaveLength(400 * 1024)
  })

  it('a newest message bigger than 5 MB is shown TRUNCATED, never as an empty conversation', async () => {
    const stdout = doc([msg(1, 'user', 'q'), msg(2, 'assistant', 'z'.repeat(6 * 1024 * 1024))])
    const res = await readOpencodeChat({ sessionId: SID }, normalizeChatPage({ maxBytes: 262144 }), run(stdout), null)
    expect(res.found).toBe(true)
    expect(res.messages).toHaveLength(1)
    const t = textOf(res.messages[0])
    expect(t.startsWith('zzz')).toBe(true)
    expect(t).toMatch(/truncated/)
    expect(Buffer.byteLength(JSON.stringify(res.messages[0]))).toBeLessThanOrEqual(5 * 1024 * 1024)
  })
})
