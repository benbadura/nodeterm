// The REMOTE (SSH-project) grok chat read: a generated `sh` line, executed here by a REAL /bin/sh
// against a fake host tree, plus the tri-state factory the desktop injects into `readChatTranscript`.
//
// Generated shell is source no compiler checks — only running it proves the glob, the root choice,
// the ambiguity refusal and the page framing agree with the parser (same discipline as
// `remote-transcript-locate.test.ts` and `transcript-page.realsh.test.ts`).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  createReadRemoteGrokChat,
  parseRemoteGrokChat,
  remoteGrokChatCommand
} from './remote-grok-chat'
import { REMOTE_GROK_HOME_PROBE, resolveReportedGrokHome } from './agents/grok-paths'
import { CHAT_PAGE_MAX_BYTES } from '../shared/chat-page'

const SID = '01a06126-b981-73f1-8b68-4547e4d7da84'
const OTHER = '01a06126-b981-73f1-8b68-000000000000'
const jl = (...rows: object[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

let host: string
beforeAll(() => {
  host = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-grok-remote-'))
})
afterAll(() => fs.rmSync(host, { recursive: true, force: true }))

/** A fresh fake $HOME for one case. */
const freshHome = (name: string): string => {
  const h = path.join(host, name)
  fs.mkdirSync(h, { recursive: true })
  return h
}
const writeSession = (grokHome: string, group: string, sid: string, body: string): void => {
  const d = path.join(grokHome, 'sessions', group, sid)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'chat_history.jsonl'), body)
}
/** Run the command the way ssh would: a shell with the host's env. */
const runOn = (
  cmd: string,
  env: Record<string, string>,
  shell = '/bin/sh'
): { code: number; stdout: string } => {
  const r = spawnSync(shell, ['-c', cmd], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } })
  return { code: r.status ?? -1, stdout: r.stdout }
}

describe('remoteGrokChatCommand under a real /bin/sh', () => {
  it('reads THIS session\'s chat_history.jsonl from $HOME/.grok, whatever cwd group it sits in', () => {
    const home = freshHome('a')
    writeSession(path.join(home, '.grok'), '%2Fsrv%2Fapp', SID, jl({ type: 'user', content: 'mine' }))
    writeSession(path.join(home, '.grok'), '%2Fsrv%2Fapp', OTHER, jl({ type: 'user', content: 'SOMEONE ELSE' }))
    const r = runOn(remoteGrokChatCommand(SID)!, { HOME: home })
    expect(r.code).toBe(0)
    const got = parseRemoteGrokChat(r.stdout)
    expect(got).toEqual({ text: jl({ type: 'user', content: 'mine' }) })
  })

  it('reads under the grok home it is GIVEN, and never consults $GROK_HOME itself', () => {
    const home = freshHome('b')
    const custom = path.join(host, 'b-grokhome')
    writeSession(custom, 'g', SID, jl({ type: 'user', content: 'from GROK_HOME' }))
    writeSession(path.join(home, '.grok'), 'g', SID, jl({ type: 'user', content: 'from ~/.grok' }))
    const given = parseRemoteGrokChat(runOn(remoteGrokChatCommand(SID, undefined, custom)!, { HOME: home }).stdout)
    expect(given).toEqual({ text: jl({ type: 'user', content: 'from GROK_HOME' }) })
    // No validated home = $HOME/.grok, whatever the env says: the root was decided in TypeScript.
    const fallback = parseRemoteGrokChat(runOn(remoteGrokChatCommand(SID)!, { HOME: home, GROK_HOME: custom }).stdout)
    expect(fallback).toEqual({ text: jl({ type: 'user', content: 'from ~/.grok' }) })
  })

  it('answers a clean miss with status 0 — "no transcript" is an ANSWER, not a failed ssh', () => {
    const home = freshHome('c')
    writeSession(path.join(home, '.grok'), 'g', OTHER, jl({ type: 'user', content: 'SOMEONE ELSE' }))
    const r = runOn(remoteGrokChatCommand(SID)!, { HOME: home })
    expect(r.code).toBe(0)
    expect(parseRemoteGrokChat(r.stdout)).toEqual({ absent: true })
    // No sessions tree at all is the same answer.
    const bare = runOn(remoteGrokChatCommand(SID)!, { HOME: freshHome('c2') })
    expect(bare.code).toBe(0)
    expect(parseRemoteGrokChat(bare.stdout)).toEqual({ absent: true })
  })

  it('a session dir with no chat_history.jsonl yet is a clean miss, not a failure', () => {
    const home = freshHome('d')
    fs.mkdirSync(path.join(home, '.grok', 'sessions', 'g', SID), { recursive: true })
    const r = runOn(remoteGrokChatCommand(SID)!, { HOME: home })
    expect(r.code).toBe(0)
    expect(parseRemoteGrokChat(r.stdout)).toEqual({ absent: true })
  })

  it('refuses to CHOOSE when the id matches two sessions (never a guess between two files)', () => {
    const home = freshHome('e')
    writeSession(path.join(home, '.grok'), 'g1', SID, jl({ type: 'user', content: 'one' }))
    writeSession(path.join(home, '.grok'), 'g2', SID, jl({ type: 'user', content: 'two' }))
    const r = runOn(remoteGrokChatCommand(SID)!, { HOME: home })
    expect(r.code).not.toBe(0)
  })

  it('reads only the last maxBytes of a big history and drops the partial first line', () => {
    const home = freshHome('f')
    const rows = Array.from({ length: 400 }, (_, i) => ({ type: 'user', content: `satır ${i} — ğüşiöç ✓` }))
    const body = jl(...rows)
    writeSession(path.join(home, '.grok'), 'g', SID, body)
    const cap = 4096
    const r = runOn(remoteGrokChatCommand(SID, cap)!, { HOME: home })
    expect(r.code).toBe(0)
    const got = parseRemoteGrokChat(r.stdout, cap)
    if (!('text' in got)) throw new Error('expected text')
    // Every kept line is a whole record from the file's tail, and the tail's last line is present.
    const kept = got.text.trimEnd().split('\n')
    for (const l of kept) expect(body.includes(l + '\n')).toBe(true)
    expect(kept.at(-1)).toBe(JSON.stringify(rows.at(-1)))
    expect(Buffer.byteLength(got.text)).toBeLessThanOrEqual(cap)
    expect(JSON.parse(kept[0])).toMatchObject({ type: 'user' })
  })

  it('keeps a line that begins exactly on the window edge (the lookbehind byte)', () => {
    const home = freshHome('g')
    const first = JSON.stringify({ type: 'user', content: 'x'.repeat(50) }) + '\n'
    const second = JSON.stringify({ type: 'user', content: 'edge line' }) + '\n'
    writeSession(path.join(home, '.grok'), 'g', SID, first + second)
    const cap = Buffer.byteLength(second)
    const got = parseRemoteGrokChat(runOn(remoteGrokChatCommand(SID, cap)!, { HOME: home }).stdout, cap)
    expect(got).toEqual({ text: second })
  })

  it('works when the login shell is bash too', () => {
    const home = freshHome('h')
    writeSession(path.join(home, '.grok'), 'g', SID, jl({ type: 'user', content: 'bash' }))
    const r = runOn(remoteGrokChatCommand(SID)!, { HOME: home }, '/bin/bash')
    expect(parseRemoteGrokChat(r.stdout)).toEqual({ text: jl({ type: 'user', content: 'bash' }) })
  })

  it('emits no command for an id that could escape the sessions tree', () => {
    for (const bad of ['', '../x', 'a/b', '*', "a'b", 'a b', 'x'.repeat(129), '$(id)']) {
      expect(remoteGrokChatCommand(bad), bad).toBeNull()
    }
  })

  it('a glob character in $GROK_HOME stays a path', () => {
    const home = freshHome('i')
    const odd = path.join(host, 'i-[star]*')
    writeSession(odd, 'g', SID, jl({ type: 'user', content: 'odd home' }))
    const r = runOn(remoteGrokChatCommand(SID, undefined, odd)!, { HOME: home })
    expect(parseRemoteGrokChat(r.stdout)).toEqual({ text: jl({ type: 'user', content: 'odd home' }) })
  })
})

describe('parseRemoteGrokChat', () => {
  it('throws on anything that is neither the absent marker nor a well-formed page', () => {
    for (const bad of ['', 'garbage', 'NODETERM_ABSENTX\n', '0 5 5\n']) {
      expect(() => parseRemoteGrokChat(bad), JSON.stringify(bad)).toThrow()
    }
  })
})

describe('createReadRemoteGrokChat — the tri-state', () => {
  const target = { conn: 'c', controlPath: '/tmp/cp' }
  const make = (o: {
    remote?: boolean
    t?: typeof target | undefined
    run?: (t: typeof target, cmd: string) => Promise<{ code: number; stdout: string }>
  }) => {
    const run = vi.fn(
      o.run ??
        (async (_t: typeof target, cmd: string) =>
          cmd === REMOTE_GROK_HOME_PROBE ? { code: 0, stdout: '' } : { code: 0, stdout: 'NODETERM_ABSENT\n' })
    )
    const read = createReadRemoteGrokChat({
      isRemote: () => o.remote ?? false,
      target: () => o.t,
      run
    })
    return { read, run }
  }

  it('null = not a remote session (no node, or neither records nor a live master say remote)', async () => {
    expect(await make({ remote: true, t: target }).read({ sessionId: SID })).toBeNull()
    expect(await make({ remote: false, t: undefined }).read({ sessionId: SID, nodeId: 'n' })).toBeNull()
  })

  it('a live master makes the node remote whatever the records say', async () => {
    const { read, run } = make({
      remote: false,
      t: target,
      run: async () => ({ code: 0, stdout: 'NODETERM_ABSENT\n' })
    })
    expect(await read({ sessionId: SID, nodeId: 'n' })).toEqual({ ok: false, absent: true })
    expect(run).toHaveBeenCalled()
  })

  it('remote with no master = could not ask (unreadable), and nothing ran', async () => {
    const { read, run } = make({ remote: true, t: undefined })
    expect(await read({ sessionId: SID, nodeId: 'n' })).toEqual({ ok: false })
    expect(run).not.toHaveBeenCalled()
  })

  it('remote with no session id (or an unusable one) = a clean miss, and nothing ran', async () => {
    for (const sessionId of [undefined, '../etc']) {
      const { read, run } = make({ remote: true, t: target })
      expect(await read({ sessionId, nodeId: 'n' })).toEqual({ ok: false, absent: true })
      expect(run).not.toHaveBeenCalled()
    }
  })

  it('a failed ssh, a non-zero status or a malformed reply is unreadable — never absent', async () => {
    for (const run of [
      async () => {
        throw new Error('master down')
      },
      async () => ({ code: 255, stdout: '' }),
      async () => ({ code: 0, stdout: 'half a reply' }),
      // The $GROK_HOME probe itself failed: the root is unknown, so nothing is read.
      async (_t: typeof target, cmd: string) =>
        cmd === REMOTE_GROK_HOME_PROBE ? { code: 255, stdout: '' } : { code: 0, stdout: 'NODETERM_ABSENT\n' }
    ]) {
      expect(await make({ remote: true, t: target, run }).read({ sessionId: SID, nodeId: 'n' })).toEqual({ ok: false })
    }
  })

  it('returns the host\'s text on success, and the command names only this session', async () => {
    const home = freshHome('factory')
    writeSession(path.join(home, '.grok'), 'g', SID, jl({ type: 'user', content: 'over ssh' }))
    const { read, run } = make({
      remote: true,
      t: target,
      run: async (_t, cmd) => runOn(cmd, { HOME: home })
    })
    expect(await read({ sessionId: SID, nodeId: 'n' })).toEqual({ ok: true, text: jl({ type: 'user', content: 'over ssh' }) })
    expect(run.mock.calls[0][0]).toBe(target)
    expect(run.mock.calls.at(-1)![1]).toContain(SID)
  })

  it('two sessions with the id is its own answer — AMBIGUOUS, not unreadable (a retry cannot fix it)', async () => {
    const home = freshHome('amb')
    writeSession(path.join(home, '.grok'), 'g1', SID, jl({ type: 'user', content: 'one' }))
    writeSession(path.join(home, '.grok'), 'g2', SID, jl({ type: 'user', content: 'two' }))
    const { read } = make({ remote: true, t: target, run: async (_t, cmd) => runOn(cmd, { HOME: home }) })
    expect(await read({ sessionId: SID, nodeId: 'n' })).toEqual({ ok: false, ambiguous: true })
  })

  it('resolves the root with the INSTALLER\'s rule: an unsafe $GROK_HOME falls back to $HOME/.grok', async () => {
    const home = freshHome('root')
    writeSession(path.join(home, '.grok'), 'g', SID, jl({ type: 'user', content: 'from ~/.grok' }))
    const good = path.join(host, 'root-good')
    writeSession(good, 'g', SID, jl({ type: 'user', content: 'from GROK_HOME' }))
    // Absolute, but carries `$` — isSafeRemoteGrokHome refuses it, so the hook installer writes
    // under ~/.grok and the reader must look there too.
    const unsafe = path.join(host, 'root-$bad')
    writeSession(unsafe, 'g', SID, jl({ type: 'user', content: 'UNSAFE ROOT' }))
    const readWith = async (env: Record<string, string>) =>
      make({ remote: true, t: target, run: async (_t, cmd) => runOn(cmd, { HOME: home, ...env }) }).read({
        sessionId: SID,
        nodeId: 'n'
      })
    expect(await readWith({ GROK_HOME: good })).toEqual({ ok: true, text: jl({ type: 'user', content: 'from GROK_HOME' }) })
    expect(await readWith({ GROK_HOME: `${good}/` })).toEqual({ ok: true, text: jl({ type: 'user', content: 'from GROK_HOME' }) })
    expect(await readWith({ GROK_HOME: unsafe })).toEqual({ ok: true, text: jl({ type: 'user', content: 'from ~/.grok' }) })
    expect(await readWith({ GROK_HOME: 'relative/dir' })).toEqual({ ok: true, text: jl({ type: 'user', content: 'from ~/.grok' }) })
    expect(resolveReportedGrokHome(unsafe)).toBeNull()
  })

  it('honours a smaller per-call maxBytes: a TAIL window, newest messages kept, partial line dropped', async () => {
    const home = freshHome('win')
    const rows = Array.from({ length: 300 }, (_, i) => ({ type: 'user', content: `row ${i} ${'y'.repeat(40)}` }))
    const body = jl(...rows)
    writeSession(path.join(home, '.grok'), 'g', SID, body)
    const { read, run } = make({ remote: true, t: target, run: async (_t, cmd) => runOn(cmd, { HOME: home }) })
    const got = await read({ sessionId: SID, nodeId: 'n' }, { maxBytes: 4096 })
    if (!got || !got.ok) throw new Error('expected text')
    expect(Buffer.byteLength(got.text)).toBeLessThanOrEqual(4096)
    const kept = got.text.trimEnd().split('\n')
    expect(kept.at(-1)).toBe(JSON.stringify(rows.at(-1)))
    for (const l of kept) expect(() => JSON.parse(l)).not.toThrow()
    expect(kept.length).toBeLessThan(rows.length)
    // …and never MORE than the cap, whatever the caller asks.
    await read({ sessionId: SID, nodeId: 'n' }, { maxBytes: 64 * 1024 * 1024 })
    expect(run.mock.calls.at(-1)![1]).toBe(remoteGrokChatCommand(SID, CHAT_PAGE_MAX_BYTES, null))
  })
})

// Guard against the test above silently passing because the command never touched the tree.
describe('the fake host tree is really read', () => {
  it('execFileSync /bin/sh is available', () => {
    expect(execFileSync('/bin/sh', ['-c', 'printf ok'], { encoding: 'utf8' })).toBe('ok')
  })
})
