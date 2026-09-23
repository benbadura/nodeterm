// The desktop shell's half of the context meter's mount-time rehydration (issue #813).
//
// `core/context-ensure.test.ts` pins the ROUTING with injected deps. What it cannot reach is this
// shell's `ensureRemote` closure, which is inline in `index.ts` over `ptyManager`,
// `sshProjectManager` and `remoteContextTail` — so its three load-bearing properties are pinned at
// source level, the same way `remote-end-wiring.test.ts` and `codex-identity-record-wiring.test.ts`
// pin theirs. Each of them fails SILENTLY if it regresses: a missing jail reads a file the host
// named, a fall-through meters the wrong machine, and a handler nobody registers simply leaves the
// meter blank exactly as before.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const SERVER_INDEX = path.join(__dirname, '..', 'server', 'index.ts')
const SRC = readFileSync(path.join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
const SERVER = readFileSync(SERVER_INDEX, 'utf8').replace(/\r\n/g, '\n')

/** The `ensureRemote: async (…) => { … }` body inside the `registerContextEnsureIpc({ … })` call. */
const ensureRemoteBody = (): string => {
  const start = SRC.indexOf('ensureRemote: async ({ sessionId, cwd, accountId, nodeId, agentId })')
  expect(start, 'ensureRemote closure not found in src/main/index.ts').toBeGreaterThan(-1)
  const end = SRC.indexOf('\n  })', start)
  expect(end, 'end of the registerContextEnsureIpc call not found').toBeGreaterThan(start)
  return SRC.slice(start, end)
}

describe('main wires the context-meter rehydration', () => {
  it('registers the core handler at all', () => {
    // A handler nobody registers is the whole bug: the renderer casts and nothing receives it.
    expect(SRC).toContain('registerContextEnsureIpc({')
  })

  it('routes each agent to its own tail, and gives grok none', () => {
    const body = SRC.slice(SRC.indexOf('registerContextEnsureIpc({'))
    expect(body).toContain('return codexContextTail')
    expect(body).toContain('return geminiContextTail')
    // grok's meter reads a hook-derived signals.json path; there is nothing to rehydrate from, so
    // the switch must fall through to `undefined` rather than adopt claude's tail.
    expect(body.slice(0, body.indexOf('ensureRemote'))).not.toContain('grok')
  })
})

describe('the remote leg keeps the jail and never falls through', () => {
  it('replays the live remote snapshot when a tracked session remounts', () => {
    expect(ensureRemoteBody()).toContain('remoteContextTail.replay(sessionId)')
  })

  it('resolves through `remoteTranscriptRefFor`, the one jailed locator', () => {
    const body = ensureRemoteBody()
    expect(body).toContain('await remoteTranscriptRefFor(sessionId, cwd, accountId, nodeId)')
    // Calling the locator directly would skip `isSafeRemoteTranscriptPath` — a located path is
    // attacker-influenced input (it crosses a machine boundary before we read it). Matched as a
    // CALL, since the closure's comments name the locator to explain the boundary.
    expect(body).not.toContain('locateRemoteTranscriptCommand(')
  })

  it('`remoteTranscriptRefFor` still jails what the host answered', () => {
    // The property the test above delegates to. Pinned here so removing the jail cannot leave this
    // file green while the ensure path quietly starts reading whatever the host named.
    const fn = SRC.slice(SRC.indexOf('const remoteTranscriptRefFor = async ('))
    const body = fn.slice(0, fn.indexOf('\n  }\n'))
    expect(body).toContain('isSafeRemoteTranscriptPath(located, remoteHome)')
  })

  it('answers `null` only for a node that is not an SSH remote', () => {
    const body = ensureRemoteBody()
    // `null` is core's signal to take the LOCAL path. Returning it for anything else — a failed
    // ssh call, an unresolved home — sends a remote session to this machine's disk, where claude's
    // cwd fallback happily meters an unrelated local session under the remote node's id.
    const nulls = body.split('\n').filter((l) => /return null/.test(l))
    expect(nulls.length).toBe(1)
    expect(body).toContain("if (!nodeId || !ptyManager.sshRemoteForNode(nodeId)) return null")
  })

  it('refuses a remote codex/gemini node instead of reading this machine', () => {
    // Same boundary the hook raw-listener draws: remote-context-tail.ts parses claude's usage
    // records and the locator searches claude's roots, so there is no remote meter for the others.
    expect(ensureRemoteBody()).toContain("if (agentId && agentId !== 'claude') return 'unresolved'")
  })

  it('caches nothing on an unresolved attempt', () => {
    const body = ensureRemoteBody()
    // Only a HIT is remembered, and `remoteTranscriptRefFor` is what remembers it. Nothing here may
    // record an absence: a momentarily dead ControlMaster must not look like a deleted transcript,
    // or the meter stays blank until the session's next turn — the bug, by another route.
    expect(body).not.toMatch(/\.(add|set)\(/)
  })
})

describe('both shells serve it', () => {
  // The repo has shipped a one-shell hook/transcript change three times; the Server Edition had no
  // `context:ensure` handler AT ALL before this, which is why its meters filled only on the next
  // turn too. The asymmetry that IS legitimate: only the desktop passes `ensureRemote`, because
  // only it has an SSH-project manager — the server runs ON the host whose transcripts it reads.
  it('the server registers the same handler, local-only', () => {
    expect(SERVER).toContain('registerContextEnsureIpc({')
    expect(SERVER).not.toContain('ensureRemote')
  })
})
