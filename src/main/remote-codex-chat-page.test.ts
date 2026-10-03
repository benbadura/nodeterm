// The desktop's remote leg of a codex ⌘M page: locate the rollout ON the host (the account-scoped,
// symlink-refusing locator the context meter already uses), then the same ranged read claude's
// remote leg uses. Every failure is terminal — a remote node is never read from this machine.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createReadRemoteCodexPage } from './remote-codex-chat-page'
import type { RemoteCodexContextTarget } from '../core/remote-ssh/codex-context'
import type { TranscriptPage } from '../core/remote-ssh/transcript-window'
import type { TranscriptQuery } from '../core/transcript-ipc'

const SID = '01a0c9f4-2b7e-7c31-9d52-5e8a1f3b6c20'
const conn = { host: 'box', user: 'u', port: 22 } as RemoteCodexContextTarget['conn']
const target: RemoteCodexContextTarget = { conn, controlPath: '/tmp/cm', remoteHome: '/home/u' }
const q: TranscriptQuery = { sessionId: SID, cwd: '/srv', accountId: undefined, nodeId: 'n1' }
const PAGE = { before: null, maxBytes: 262144 }
const FILE = `/home/u/.codex/sessions/2026/09/24/rollout-2026-09-24T09-00-00-${SID}.jsonl`

function harness(over: Partial<Parameters<typeof createReadRemoteCodexPage>[0]> = {}) {
  const run = vi.fn(async () => ({ code: 0, stdout: `/home/u/.codex/sessions\n${FILE}\n` }))
  const readPage = vi.fn(async (): Promise<TranscriptPage> => ({ data: Buffer.from('{}\n'), start: 0, end: 3, size: 3 }))
  const deps = {
    targetFor: vi.fn((): RemoteCodexContextTarget | null | undefined => target),
    knownAccount: vi.fn(() => true),
    run,
    readPage,
    ...over
  }
  return { deps, read: createReadRemoteCodexPage(deps) }
}

describe('createReadRemoteCodexPage', () => {
  it('a local node is not its business (null ⇒ take the local path)', async () => {
    const h = harness({ targetFor: vi.fn(() => undefined) })
    expect(await h.read(q, PAGE)).toBeNull()
    expect(await h.read({ ...q, nodeId: undefined }, PAGE)).toBeNull()
    expect(h.deps.run).not.toHaveBeenCalled()
  })

  it('locates on the host, then reads the page over the same master', async () => {
    const h = harness()
    expect(await h.read(q, PAGE)).toEqual({ ok: true, data: Buffer.from('{}\n'), start: 0 })
    expect(h.deps.readPage).toHaveBeenCalledWith({ conn, controlPath: '/tmp/cm', path: FILE }, null, 262144)
    // The located path is remembered: the next page costs one round trip, not two.
    await h.read(q, { before: 100, maxBytes: 524288 })
    expect(h.deps.run).toHaveBeenCalledTimes(1)
  })

  it('a remote node with no master / no record is UNREADABLE', async () => {
    expect(await harness({ targetFor: vi.fn(() => null) }).read(q, PAGE)).toEqual({ ok: false })
  })

  it('no id, or one that is not a whole thread uuid, is a clean miss — nothing is run', async () => {
    const h = harness()
    for (const sessionId of [undefined, '5e8a1f3b6c20', '../x']) {
      expect(await h.read({ ...q, sessionId }, PAGE)).toEqual({ ok: false, absent: true })
    }
    expect(h.deps.run).not.toHaveBeenCalled()
  })

  it('a managed account the host does not know is refused before any command', async () => {
    const h = harness({ targetFor: vi.fn(() => ({ ...target, accountId: 'acct' })), knownAccount: vi.fn(() => false) })
    expect(await h.read(q, PAGE)).toEqual({ ok: false })
    expect(h.deps.run).not.toHaveBeenCalled()
  })

  it('an unsafe remote home for a managed account is unreadable, not a throw', async () => {
    const h = harness({ targetFor: vi.fn(() => ({ ...target, remoteHome: undefined, accountId: 'acct' })) })
    expect(await h.read(q, PAGE)).toEqual({ ok: false })
  })

  it('the host LOOKED and found nothing (exit 0, empty) = absent; a failed ask or a malformed answer = unreadable', async () => {
    expect(await harness({ run: vi.fn(async () => ({ code: 0, stdout: '' })) }).read(q, PAGE)).toEqual({ ok: false, absent: true })
    expect(await harness({ run: vi.fn(async () => ({ code: 255, stdout: '' })) }).read(q, PAGE)).toEqual({ ok: false })
    expect(await harness({ run: vi.fn(async () => { throw new Error('ssh') }) }).read(q, PAGE)).toEqual({ ok: false })
    // A path outside the sessions root the host itself reported is refused by the jail.
    const escape = { code: 0, stdout: `/home/u/.codex/sessions\n/etc/rollout-x-${SID}.jsonl\n` }
    expect(await harness({ run: vi.fn(async () => escape) }).read(q, PAGE)).toEqual({ ok: false })
  })

  it('a failed page read is unreadable AND forgets the located path, so a retry locates again', async () => {
    const h = harness()
    vi.mocked(h.deps.readPage).mockRejectedValueOnce(new Error('master died'))
    expect(await h.read(q, PAGE)).toEqual({ ok: false })
    expect(await h.read(q, PAGE)).toMatchObject({ ok: true })
    expect(h.deps.run).toHaveBeenCalledTimes(2)
  })

  it('the remembered path is per node, target and session — never shared across hosts', async () => {
    const h = harness()
    await h.read(q, PAGE)
    vi.mocked(h.deps.targetFor).mockReturnValue({ ...target, controlPath: '/tmp/other-host' })
    await h.read(q, PAGE)
    await h.read({ ...q, nodeId: 'n2' }, PAGE)
    expect(h.deps.run).toHaveBeenCalledTimes(3)
  })
})

describe.skipIf(process.platform === 'win32')('createReadRemoteCodexPage against a real /bin/sh host tree', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  it('the generated locate command finds exactly this thread under the host CODEX_HOME', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'codex-chat-remote-'))
    const codexHome = path.join(dir, 'codex home')
    const folder = path.join(codexHome, 'sessions', '2026', '09', '24')
    mkdirSync(folder, { recursive: true })
    const mine = path.join(folder, `rollout-2026-09-24T09-00-00-${SID}.jsonl`)
    writeFileSync(mine, '{"type":"x"}\n')
    writeFileSync(path.join(folder, 'rollout-2026-09-24T09-00-00-01a0c9f4-2b7e-7c31-9d52-5e8a1f3b6c99.jsonl'), 'OTHER\n')
    const read = createReadRemoteCodexPage({
      targetFor: () => ({ ...target, remoteHome: dir }),
      knownAccount: () => true,
      run: async (_t, command) => ({
        code: 0,
        stdout: execFileSync('/bin/sh', ['-c', command], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH, SHELL: '/bin/sh', CODEX_HOME: codexHome }
        })
      }),
      readPage: async (ref) => {
        const data = readFileSync(ref.path)
        return { data, start: 0, end: data.length, size: data.length }
      }
    })
    expect(await read(q, PAGE)).toEqual({ ok: true, data: Buffer.from('{"type":"x"}\n'), start: 0 })
  })
})
