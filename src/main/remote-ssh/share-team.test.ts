import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createShareTeamHandlers, SHARE_TIMEOUTS, type ShareTeamDeps } from './share-team'
import { SHARE_REFUSAL } from '../../shared/share-team'
import { encodeJoinCode } from '../../core/relay/join-code'
import { genKeyPair, publicKeyToB64 } from '../../core/relay/e2ee'
import { hostIdFromPublicKeyB64 } from '../../core/relay/relay-id'
import type { RelayBookmark } from '../remote/relay-bookmarks'

const OWNER = publicKeyToB64(genKeyPair().publicKey)
const hostKey = publicKeyToB64(genKeyPair().publicKey)
const CODE = encodeJoinCode({ v: 1, relayEndpoint: 'wss://relay.example', hostId: hostIdFromPublicKeyB64(hostKey), hostPublicKeyB64: hostKey, hostDeviceId: 'dev', label: 'box' })

const PROBE_OUT = [
  '##NTP 1', '##OS Linux', '##UID 1000', '##USER alice', '##HOME /home/alice', '##HOMEREAL /home/alice', '##HAVE git yes', '##HAVE curl yes',
  '##UNIT user', '##NODE /usr/bin/node', '##MAIN /home/alice/app/out/server/main.cjs', '##DATADIR /home/alice/.nodeterm-server',
  '##BOOTSTRAP yes', '##STATUSRC 0', '##STATUS', '{"enabled":true,"off":null}', '##STATUSEND',
  '##CWD /home/alice/proj', '##PANES', 'nt-term-a|claude', 'nt-term-b|npm', '##PANESEND', '##END'
].join('\n')

function deps(
  o: {
    connected?: boolean
    remoteCwd?: string
    replies?: string[]
    bookmarks?: RelayBookmark[]
    remote?: { status: 'ok'; content: string } | { status: 'absent' } | { status: 'error' }
    label?: string
    ownerKey?: () => Promise<string>
    runInstall?: ShareTeamDeps['runInstall']
  } = {}
) {
  const calls: Array<{ args: string[]; stdin?: string; timeoutMs: number }> = []
  const replies = [...(o.replies ?? [])]
  const saved: RelayBookmark[] = [...(o.bookmarks ?? [])]
  const order: string[] = []
  const d: ShareTeamDeps = {
    ref: () => (o.connected === false ? undefined : { conn: { host: 'h', user: 'alice' } as never, controlPath: '/cp', remoteCwd: o.remoteCwd ?? '~/proj' }),
    run: async (args, stdin, timeoutMs) => {
      calls.push({ args, stdin, timeoutMs })
      return { code: 0, stdout: replies.shift() ?? '' }
    },
    runInstall: o.runInstall ?? (async () => ({ exitCode: 0 })),
    flushMirror: async () => void order.push('flush'),
    readRemoteProject: async () => (order.push('read'), o.remote ?? { status: 'ok', content: JSON.stringify({ version: 1, nodes: [{ id: 'term-a' }, { id: 'term-b' }] }) }),
    ownerKey: o.ownerKey ?? (async () => OWNER),
    ownerLabel: () => o.label ?? 'My Mac\u0007',
    bookmarks: {
      list: async () => saved,
      upsert: async (b) => void (saved.splice(0, saved.length, ...saved.filter((x) => x.hostId !== b.hostId), b)),
      update: async (hostId, patch) => {
        const i = saved.findIndex((x) => x.hostId === hostId)
        if (i >= 0) saved[i] = { ...saved[i], ...patch }
      }
    },
    now: () => Date.parse('2026-10-01T10:00:00Z')
  }
  return { h: createShareTeamHandlers(d), calls, saved, order }
}
const cli = (body: unknown, rc = 0): string => `##NTB\n${JSON.stringify(body)}\n##NTRC ${rc}\n`
const GOOD = (): Record<string, unknown> => ({
  hostId: hostIdFromPublicKeyB64(hostKey),
  projectId: 'project-1',
  projectName: 'proj',
  joinCode: CODE,
  hosting: 'up',
  created: { team: true, owner: true, project: true, share: true }
})
const lastArg = (c: { args: string[] }): string => c.args[c.args.length - 1]

describe('share-team wiring in main', () => {
  it('passes each verb timeout through to sshRun (a dropped argument falls back to the runner 15 s)', () => {
    // The runner end is pinned in ssh-project.test.ts; this is the glue between the two.
    const src = readFileSync(path.resolve(__dirname, '../index.ts'), 'utf8').replace(/\r\n/g, '\n')
    const block = src.slice(src.indexOf('createShareTeamHandlers({'), src.indexOf('runInstall:', src.indexOf('createShareTeamHandlers({')))
    expect(block).toMatch(/run: \(args, stdin, timeoutMs\) =>\s+sshProjectManager \? sshProjectManager\.sshRun\(args, stdin, \{ timeoutMs \}\)/)
  })
})

describe('share-team handlers', () => {
  it('probe: refuses a disconnected project with E_NOT_CONNECTED', async () => {
    const { h } = deps({ connected: false })
    expect(await h.probe('p', [])).toMatchObject({ ok: false, code: 'E_NOT_CONNECTED' })
  })
  it('probe: parses, plans and maps pane commands to node ids, with the probe timeout', async () => {
    const { h, calls } = deps({ replies: [PROBE_OUT] })
    const r = await h.probe('p', ['term-a', 'term-b', 'term-c'])
    expect(r).toMatchObject({ ok: true, plan: { kind: 'ready' }, paneCommands: { 'term-a': 'claude', 'term-b': 'npm' } })
    expect(calls[0].timeoutMs).toBe(SHARE_TIMEOUTS.probe)
  })
  it('probe: an unsafe node id never reaches the pane map', async () => {
    const { h } = deps({ replies: [PROBE_OUT] })
    const r = await h.probe('p', ['term-a', '../term-b'])
    expect(r).toMatchObject({ ok: true, paneCommands: { 'term-a': 'claude' } })
    expect(r.ok && Object.keys(r.paneCommands)).toEqual(['term-a'])
  })
  it('probe: a folder the login shell cannot quote is refused, never run', async () => {
    const { h, calls } = deps({ remoteCwd: "~/it's" })
    expect(await h.probe('p', [])).toMatchObject({ ok: false, error: expect.stringMatching(/quote or backslash/) })
    expect(calls).toHaveLength(0)
  })
  it('probe: a cut-short reply is an error and forgets the earlier probe', async () => {
    const { h } = deps({ replies: [PROBE_OUT, '##NTP 1\n##OS Linux\n'] })
    await h.probe('p', [])
    expect(await h.probe('p', [])).toMatchObject({ ok: false, error: expect.stringMatching(/did not finish/) })
    expect(await h.bootstrap('p')).toMatchObject({ ok: false, code: 'E_NOT_PROBED' })
  })
  it('bootstrap needs a ready probe first', async () => {
    const { h } = deps()
    expect(await h.bootstrap('p')).toMatchObject({ ok: false, code: 'E_NOT_PROBED' })
  })
  it('bootstrap and install never run against a probe whose plan refuses (here: the home directory itself)', async () => {
    // The folder Viewers could read is the whole home: ~/.ssh, agent credentials, hook tokens.
    const home = PROBE_OUT.replace('##CWD /home/alice/proj', '##CWD /home/alice')
    const { h, calls } = deps({ replies: [home] })
    const probed = await h.probe('p', [])
    expect(probed).toMatchObject({ ok: true, plan: { kind: 'refuse', reason: SHARE_REFUSAL.homeFolder } })
    expect(await h.bootstrap('p')).toEqual({ ok: false, code: 'E_NOT_PROBED', error: SHARE_REFUSAL.homeFolder })
    expect(await h.install('p', () => {})).toEqual({ ok: false, code: 'E_NOT_PROBED', error: SHARE_REFUSAL.homeFolder })
    expect(await h.resume('p', 'project-1', [])).toMatchObject({ ok: false, code: 'E_NOT_PROBED' })
    expect(calls).toHaveLength(1) // the probe, and nothing after it
  })
  it('bootstrap needs a READY plan: a server that is installed but not answering is installed first', async () => {
    const down = PROBE_OUT.replace('##STATUSRC 0', '##STATUSRC 1')
    const { h, calls } = deps({ replies: [down] })
    expect(await h.probe('p', [])).toMatchObject({ ok: true, plan: { kind: 'install', reason: 'not-running' } })
    expect(await h.bootstrap('p')).toMatchObject({ ok: false, code: 'E_NOT_PROBED' })
    expect(calls).toHaveLength(1)
  })
  it('install needs a probe first', async () => {
    let ran = false
    const { h } = deps({ runInstall: async () => ((ran = true), { exitCode: 0 }) })
    expect(await h.install('p', () => {})).toMatchObject({ ok: false, code: 'E_NOT_PROBED' })
    expect(ran).toBe(false)
  })
  it('bootstrap: passes the owner key, a control-free label and the folder; validates the join code', async () => {
    const good = GOOD()
    // The folder comes from the cached probe's real path, never from the caller.
    const { h, calls } = deps({ replies: [PROBE_OUT, cli(good)] })
    await h.probe('p', [])
    const r = await h.bootstrap('p')
    expect(r).toMatchObject({ ok: true, result: good })
    const cmd = lastArg(calls[1])
    expect(cmd).toContain(OWNER)
    expect(cmd).toContain("'My Mac'")
    expect(cmd).toContain("'/home/alice/proj'")
    expect(calls[1].timeoutMs).toBe(SHARE_TIMEOUTS.bootstrap)
  })
  it('bootstrap adopts the folder of the LATEST probe (a re-probe after an install replaces the cache)', async () => {
    const { h, calls } = deps({ replies: [PROBE_OUT.replace('##CWD /home/alice/proj', '##CWD /home/alice/old'), PROBE_OUT, cli(GOOD())] })
    await h.probe('p', [])
    await h.probe('p', [])
    expect(await h.bootstrap('p')).toMatchObject({ ok: true })
    expect(lastArg(calls[2])).toContain("'/home/alice/proj'")
    expect(lastArg(calls[2])).not.toContain('/home/alice/old')
  })
  it('bootstrap: a label with an apostrophe or backslash goes through with them removed', async () => {
    const { h, calls } = deps({ label: "Enes's \\Mac", replies: [PROBE_OUT, cli(GOOD())] })
    await h.probe('p', [])
    expect(await h.bootstrap('p')).toMatchObject({ ok: true })
    expect(lastArg(calls[1])).toContain("'Eness Mac'")
  })
  it('bootstrap: an over-long label is capped, never refused', async () => {
    const { h, calls } = deps({ label: 'x'.repeat(80), replies: [PROBE_OUT, cli(GOOD())] })
    await h.probe('p', [])
    expect(await h.bootstrap('p')).toMatchObject({ ok: true })
    expect(lastArg(calls[1])).toContain(`'${'x'.repeat(60)}'`)
    expect(lastArg(calls[1])).not.toContain('x'.repeat(61))
  })
  it('bootstrap: only the known result fields come back', async () => {
    const { h } = deps({ replies: [PROBE_OUT, cli({ ...GOOD(), extra: 'ignored' })] })
    await h.probe('p', [])
    const r = await h.bootstrap('p')
    expect(r.ok && Object.keys(r.result).sort()).toEqual(['created', 'hostId', 'hosting', 'joinCode', 'projectId', 'projectName'])
  })
  it('bootstrap: a server refusal keeps its code; a join code for another host is refused', async () => {
    const { h } = deps({ replies: [PROBE_OUT, cli({ ok: false, code: 'E_HOSTING_OFF', error: 'refused (403)' }, 1)] })
    await h.probe('p', [])
    expect(await h.bootstrap('p')).toEqual({ ok: false, code: 'E_HOSTING_OFF', error: 'refused (403)' })
    const forged = { hostId: 'someone-else', projectId: 'project-1', projectName: 'p', joinCode: CODE, hosting: 'up', created: { team: false, owner: false, project: false, share: false } }
    const d2 = deps({ replies: [PROBE_OUT, cli(forged)] })
    await d2.h.probe('p', [])
    expect(await d2.h.bootstrap('p')).toMatchObject({ ok: false, error: expect.stringMatching(/join code/i) })
  })
  it('bootstrap: a refusal code outside the E_* shape is dropped, and a malformed result is refused', async () => {
    const { h } = deps({ replies: [PROBE_OUT, cli({ ok: false, code: 'nope', error: 'no' }, 1), cli({ ...GOOD(), hosting: 'down' })] })
    await h.probe('p', [])
    expect(await h.bootstrap('p')).toEqual({ ok: false, error: 'no' })
    expect(await h.bootstrap('p')).toMatchObject({ ok: false })
  })
  it('bootstrap: a key that cannot be read is a reply, never a rejection, and keeps its code', async () => {
    const locked = async (): Promise<string> => {
      throw Object.assign(new Error('The keyring is locked.'), { code: 'E_PEER_KEY_LOCKED' })
    }
    const { h, calls } = deps({ ownerKey: locked, replies: [PROBE_OUT] })
    await h.probe('p', [])
    expect(await h.bootstrap('p')).toEqual({ ok: false, code: 'E_PEER_KEY_LOCKED', error: 'The keyring is locked.' })
    expect(calls).toHaveLength(1)
  })
  it('killSessions: refuses an unsafe id before running anything; parses per-node states', async () => {
    const { h, calls } = deps({ replies: ['##NTK\n##K nt-term-a gone\n##K nt-term-b alive\n##NTKEND\n'] })
    expect(await h.killSessions('p', ['../x'])).toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
    expect(await h.killSessions('p', ['term-a', 'term-b'])).toEqual({ ok: true, results: [{ nodeId: 'term-a', state: 'gone' }, { nodeId: 'term-b', state: 'alive' }] })
    expect(calls[0].timeoutMs).toBe(SHARE_TIMEOUTS.kill)
  })
  it('killSessions: an empty list runs nothing; too many ids are refused', async () => {
    const { h, calls } = deps()
    expect(await h.killSessions('p', [])).toEqual({ ok: true, results: [] })
    expect(await h.killSessions('p', Array.from({ length: 201 }, (_, i) => `n${i}`))).toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
  })
  it('resume: the session list goes on stdin, never argv', async () => {
    const { h, calls } = deps({ replies: [PROBE_OUT, cli({ results: [{ nodeId: 'term-a', status: 'resumed' }] })] })
    await h.probe('p', [])
    const sessions = [{ nodeId: 'term-a', agentId: 'claude', sessionId: 's-1', permissionMode: 'auto' }]
    expect(await h.resume('p', 'project-1', sessions)).toEqual({ ok: true, results: [{ nodeId: 'term-a', status: 'resumed' }] })
    expect(calls[1].stdin).toBe(JSON.stringify(sessions))
    expect(calls[1].args.join(' ')).not.toContain('s-1')
    expect(calls[1].timeoutMs).toBe(SHARE_TIMEOUTS.resume)
  })
  it('resume: needs a probe, a valid project id and a valid session list; a malformed reply is refused', async () => {
    expect(await deps().h.resume('p', 'project-1', [])).toMatchObject({ ok: false, code: 'E_NOT_PROBED' })
    const { h, calls } = deps({ replies: [PROBE_OUT, cli({ results: [{ nodeId: 'term-a', status: 'exploded' }] })] })
    await h.probe('p', [])
    expect(await h.resume('p', '', [])).toMatchObject({ ok: false })
    expect(await h.resume('p', 'project-1', [{ nodeId: 'a' }] as never)).toMatchObject({ ok: false })
    expect(calls).toHaveLength(1)
    expect(await h.resume('p', 'project-1', [])).toMatchObject({ ok: false })
  })
  it('flushMirror: flushes BEFORE reading, and reports the node ids on the host', async () => {
    const { h, order } = deps()
    expect(await h.flushMirror('p')).toEqual({ ok: true, nodeIds: ['term-a', 'term-b'] })
    expect(order).toEqual(['flush', 'read'])
    expect(await deps({ remote: { status: 'error' } }).h.flushMirror('p')).toMatchObject({ ok: false })
    expect(await deps({ remote: { status: 'absent' } }).h.flushMirror('p')).toEqual({ ok: true, nodeIds: [] })
    expect(await deps({ remote: { status: 'ok', content: '{not json' } }).h.flushMirror('p')).toMatchObject({ ok: false })
  })
  it('install: one run per project at a time, cancellable (answered E_CANCELLED), output streamed', async () => {
    let release: (v: { exitCode: number }) => void = () => {}
    let seenSignal: AbortSignal | null = null
    const { h } = deps({
      replies: [PROBE_OUT],
      runInstall: (_p, script, onChunk, signal) => {
        seenSignal = signal
        onChunk(script.includes('install-server.sh') ? 'installing\n' : '?')
        return new Promise((r) => (release = r))
      }
    })
    await h.probe('p', [])
    const chunks: string[] = []
    const first = h.install('p', (t) => chunks.push(t))
    expect(await h.install('p', () => {})).toEqual({ ok: false, error: 'An install is already running.' })
    await h.cancelInstall('p')
    expect(seenSignal!.aborted).toBe(true)
    release({ exitCode: 143 })
    // A cancelled install is never an install that "finished": the share must end there.
    expect(await first).toEqual({ ok: false, code: 'E_CANCELLED', error: 'The install was cancelled.' })
    expect(chunks).toEqual(['installing\n'])
    // The slot is free again once the run ends.
    const again = h.install('p', () => {})
    release({ exitCode: 0 })
    expect(await again).toEqual({ ok: true, exitCode: 0 })
  })
  /** Handlers whose last bootstrap returned CODE: the only code `seedBookmark` may seed. */
  const bootstrapped = async (o: Parameters<typeof deps>[0] = {}) => {
    const d = deps({ ...o, replies: [PROBE_OUT, cli(GOOD())] })
    await d.h.probe('p', [])
    expect(await d.h.bootstrap('p')).toMatchObject({ ok: true })
    return d
  }
  it('seedBookmark: a new team gets an approved ssh bookmark; an existing unapproved one is approved; a bad code is refused', async () => {
    const a = await bootstrapped()
    expect(await a.h.seedBookmark(CODE)).toMatchObject({ ok: true, label: 'box' })
    expect(a.saved).toEqual([{ hostId: hostIdFromPublicKeyB64(hostKey), code: CODE, label: 'box', deviceToken: null, approvedAt: '2026-10-01T10:00:00.000Z', source: 'ssh' }])
    const b = await bootstrapped({ bookmarks: [{ hostId: hostIdFromPublicKeyB64(hostKey), code: CODE, label: 'box', deviceToken: 'tok', approvedAt: null, source: 'code' }] })
    await b.h.seedBookmark(CODE)
    expect(b.saved[0]).toMatchObject({ deviceToken: 'tok', approvedAt: '2026-10-01T10:00:00.000Z', source: 'code' })
    expect(await a.h.seedBookmark('nodeterm://join/garbage')).toMatchObject({ ok: false })
  })
  it('seedBookmark: an approved bookmark for the same key is left alone; one for another key is replaced', async () => {
    const hostId = hostIdFromPublicKeyB64(hostKey)
    const kept: RelayBookmark = { hostId, code: CODE, label: 'box', deviceToken: 'tok', approvedAt: '2026-01-01T00:00:00.000Z', source: 'code' }
    const a = await bootstrapped({ bookmarks: [kept] })
    await a.h.seedBookmark(CODE)
    expect(a.saved).toEqual([kept])
    // Same hostId, different stored key: the stored code no longer decodes to this key.
    const stale: RelayBookmark = { ...kept, code: 'nodeterm://join?code=stale' }
    const b = await bootstrapped({ bookmarks: [stale] })
    await b.h.seedBookmark(CODE)
    expect(b.saved).toEqual([{ hostId, code: CODE, label: 'box', deviceToken: null, approvedAt: '2026-10-01T10:00:00.000Z', source: 'ssh' }])
  })
  it('seedBookmark skips the SAS only for a code a successful bootstrap handed out', async () => {
    // A valid code nobody bootstrapped: no SAS skip, and nothing written.
    const fresh = deps()
    expect(await fresh.h.seedBookmark(CODE)).toMatchObject({ ok: false })
    expect(fresh.saved).toEqual([])
    // A failed bootstrap hands out nothing either, even when the reply carried a code.
    const refused = deps({ replies: [PROBE_OUT, cli({ ok: false, code: 'E_HOSTING_OFF', error: 'no' }, 1)] })
    await refused.h.probe('p', [])
    await refused.h.bootstrap('p')
    expect(await refused.h.seedBookmark(CODE)).toMatchObject({ ok: false })
    expect(refused.saved).toEqual([])
    // A code for another team, valid and well-formed, after a bootstrap that returned CODE.
    const otherKey = publicKeyToB64(genKeyPair().publicKey)
    const other = encodeJoinCode({ v: 1, relayEndpoint: 'wss://relay.example', hostId: hostIdFromPublicKeyB64(otherKey), hostPublicKeyB64: otherKey, hostDeviceId: 'dev2', label: 'evil' })
    const done = await bootstrapped()
    expect(await done.h.seedBookmark(other)).toMatchObject({ ok: false })
    expect(done.saved).toEqual([])
  })
})
