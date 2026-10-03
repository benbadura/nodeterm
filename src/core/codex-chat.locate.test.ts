// Locating a codex node's rollout: by its OWN thread id, under its OWN account's CODEX_HOME, and
// never by anything weaker. The failure this guards is the one CLAUDE.md records for codex before:
// a resolver that answers "a transcript" rather than "this session's transcript" shows a stranger's
// conversation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { locateCodexRollout, resetCodexRolloutCacheForTests } from './codex-chat'
import { codexHomeForAccount } from './codex-accounts-core'

const ID = '01a0c9f4-2b7e-7c31-9d52-5e8a1f3b6c20'
const OTHER = '01a0c9f4-2b7e-7c31-9d52-5e8a1f3b6c99'

let home: string
let f: ReturnType<typeof fakePlatform>
let savedCodexHome: string | undefined

const put = (root: string, rel: string, body = '{}\n'): string => {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  return p
}
const sessions = (): string => path.join(home, '.codex', 'sessions')

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-codex-locate-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  savedCodexHome = process.env.CODEX_HOME
  delete process.env.CODEX_HOME
  f = fakePlatform()
  initPlatform(f)
  resetCodexRolloutCacheForTests()
})
afterEach(() => {
  vi.restoreAllMocks()
  resetPlatformForTests()
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedCodexHome
  fs.rmSync(home, { recursive: true, force: true })
})

describe('locateCodexRollout', () => {
  it('finds the rollout named for exactly this thread id under the system home', async () => {
    put(sessions(), `2026/09/23/rollout-2026-09-23T10-00-00-${OTHER}.jsonl`)
    const mine = put(sessions(), `2026/09/24/rollout-2026-09-24T09-00-00-${ID}.jsonl`)
    expect(await locateCodexRollout({ sessionId: ID })).toBe(mine)
  })

  it('never answers with another session: no substring match, no newest-in-cwd fallback', async () => {
    // `includes()` would hit this file for the id `…6c20` minus its first group: the id must be
    // the WHOLE `-<id>.jsonl` suffix.
    put(sessions(), `2026/09/24/rollout-2026-09-24T09-00-00-x${ID}.jsonl`)
    put(sessions(), `2026/09/24/rollout-2026-09-24T09-00-00-${ID}.jsonl.bak`)
    put(sessions(), `2026/09/24/other-${ID}.jsonl`)
    // A claude transcript for the same cwd is not codex's business at all.
    put(path.join(home, '.claude', 'projects', '-srv-demo'), `${ID}.jsonl`)
    expect(await locateCodexRollout({ sessionId: ID })).toBeUndefined()
  })

  it('refuses an id that could not be a thread id, before touching the disk', async () => {
    put(sessions(), `2026/09/24/rollout-2026-09-24T09-00-00-${ID}.jsonl`)
    for (const bad of [undefined, '', '../x', `${ID}/..`, 'zz', '*']) {
      expect(await locateCodexRollout({ sessionId: bad }), String(bad)).toBeUndefined()
    }
  })

  it('a thread id is a WHOLE uuid: a trailing group of another id never matches its file', async () => {
    // `5e8a1f3b6c20` is hex and 12 long, so claude's looser SESSION_ID_RE admits it — and
    // `rollout-…-9d52-5e8a1f3b6c20.jsonl` really does end in `-5e8a1f3b6c20.jsonl`.
    put(sessions(), `2026/09/24/rollout-2026-09-24T09-00-00-${ID}.jsonl`)
    for (const partial of ['5e8a1f3b6c20', '9d52-5e8a1f3b6c20', '7c31-9d52-5e8a1f3b6c20', `${ID}0`]) {
      expect(await locateCodexRollout({ sessionId: partial }), partial).toBeUndefined()
    }
    // …and the uuid itself is accepted in either case.
    expect(await locateCodexRollout({ sessionId: ID })).toBeDefined()
  })

  it('reads a MANAGED account\'s own home, never the system one', async () => {
    const acct = 'acct-1'
    // os.homedir() is mocked, so the managed short root lands inside this test's temp home.
    const managed = path.join(codexHomeForAccount(f.userDataDir, acct), 'sessions')
    expect(managed.startsWith(home)).toBe(true)
    put(sessions(), `2026/09/24/rollout-2026-09-24T09-00-00-${ID}.jsonl`) // the system home's copy
    expect(await locateCodexRollout({ sessionId: ID, accountId: acct })).toBeUndefined()
    const mine = put(managed, `2026/09/24/rollout-2026-09-24T09-00-00-${ID}.jsonl`)
    resetCodexRolloutCacheForTests()
    expect(await locateCodexRollout({ sessionId: ID, accountId: acct })).toBe(mine)
  })

  it('an account id that cannot name a home finds nothing (never the system home)', async () => {
    put(sessions(), `2026/09/24/rollout-2026-09-24T09-00-00-${ID}.jsonl`)
    expect(await locateCodexRollout({ sessionId: ID, accountId: '../escape' })).toBeUndefined()
  })

  it('honours the host\'s CODEX_HOME for the system account', async () => {
    const relocated = path.join(home, 'elsewhere')
    process.env.CODEX_HOME = relocated
    const mine = put(path.join(relocated, 'sessions'), `2026/09/24/rollout-2026-09-24T09-00-00-${ID}.jsonl`)
    expect(await locateCodexRollout({ sessionId: ID })).toBe(mine)
  })

  it('does not follow a symlinked rollout or date directory', async () => {
    const outside = put(home, `outside/rollout-2026-09-24T09-00-00-${ID}.jsonl`)
    fs.mkdirSync(path.join(sessions(), '2026', '09'), { recursive: true })
    fs.symlinkSync(outside, path.join(sessions(), '2026', '09', `rollout-2026-09-24T09-00-00-${ID}.jsonl`))
    fs.symlinkSync(path.join(home, 'outside'), path.join(sessions(), '2026', '10'))
    expect(await locateCodexRollout({ sessionId: ID })).toBeUndefined()
  })

  it('prefers the hook-fed path, but only when it names this thread and exists', async () => {
    const scanned = put(sessions(), `2026/09/24/rollout-2026-09-24T09-00-00-${ID}.jsonl`)
    const hooked = put(home, `hooked/rollout-2026-09-24T09-00-00-${ID}.jsonl`)
    expect(await locateCodexRollout({ sessionId: ID }, () => hooked)).toBe(hooked)
    // A hint naming ANOTHER thread's file is ignored, not trusted.
    const foreign = put(home, `hooked/rollout-2026-09-24T09-00-00-${OTHER}.jsonl`)
    expect(await locateCodexRollout({ sessionId: ID }, () => foreign)).toBe(scanned)
    // A hint that no longer exists falls back to the scan.
    expect(await locateCodexRollout({ sessionId: ID }, () => path.join(home, `gone/rollout-x-${ID}.jsonl`))).toBe(scanned)
    // A hint that is a SYMLINK (to anything) is not a rollout codex wrote.
    const link = path.join(home, 'hooked', `rollout-2026-09-24T09-00-01-${ID}.jsonl`)
    fs.symlinkSync(foreign, link)
    expect(await locateCodexRollout({ sessionId: ID }, () => link)).toBe(scanned)
  })

  it('caches a hit, and heals when the cached file disappears', async () => {
    const first = put(sessions(), `2026/09/24/rollout-2026-09-24T09-00-00-${ID}.jsonl`)
    expect(await locateCodexRollout({ sessionId: ID })).toBe(first)
    fs.rmSync(first)
    const moved = put(sessions(), `2026/09/25/rollout-2026-09-25T09-00-00-${ID}.jsonl`)
    expect(await locateCodexRollout({ sessionId: ID })).toBe(moved)
  })

  it('a missing sessions directory is simply not found', async () => {
    expect(await locateCodexRollout({ sessionId: ID })).toBeUndefined()
  })
})
