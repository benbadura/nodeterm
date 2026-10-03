// `readChatTranscript`'s grok leg: which machine answers, which file, and what rides a paged reply.
//
// The two failures these exist to make loud: a grok node answered with SOMEONE ELSE'S conversation
// (claude's cwd-newest fallback, reached by any grok read that is not routed first — a custom agent
// built on grok included), and a REMOTE grok node answered from THIS machine's disk.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { readChatTranscript, type TranscriptIpcDeps } from './transcript-ipc'
import { _resetGrokSessionDirsForTests, rememberGrokSessionDir } from './grok-session'
import { setCustomAgentBaseResolver } from '../shared/agents/config'
import { GROK_AMBIGUOUS_SESSION_MESSAGE } from '../shared/chat-page'

const GROK_SID = '01a06126-b981-73f1-8b68-4547e4d7da84'
const CWD = '/srv/app'
const jl = (...rows: object[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const grokAssistant = (content: string, model = 'grok-4.6-build', effort = 'xhigh') => ({
  type: 'assistant',
  content,
  model_id: model,
  model_fingerprint: 'fp',
  reasoning_effort: effort
})

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-grok-ipc-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  initPlatform(fakePlatform())
  _resetGrokSessionDirsForTests()
})
afterEach(() => {
  vi.restoreAllMocks()
  resetPlatformForTests()
  setCustomAgentBaseResolver(null)
  _resetGrokSessionDirsForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

/** A claude transcript for the same cwd — what claude's cwd fallback would hand back. */
const writeClaudeStranger = (): void => {
  const dir = path.join(home, '.claude', 'projects', '-srv-app')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, '11111111-2222-3333-4444-555555555555.jsonl'),
    jl({ type: 'user', message: { content: 'SOMEONE ELSE PRIVATE' } })
  )
}
const writeLocalGrok = (body: string): void => {
  const dir = path.join(home, '.grok', 'sessions', '%2Fsrv%2Fapp', GROK_SID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), body)
  rememberGrokSessionDir(GROK_SID, dir)
}

describe('readChatTranscript — grok, local', () => {
  it('a paged read carries the newest assistant record\'s model and effort', async () => {
    writeLocalGrok(jl({ type: 'user', content: 'hi' }, grokAssistant('hello', 'grok-5', 'high')))
    const res = await readChatTranscript({ sessionId: GROK_SID, cwd: CWD, agentId: 'grok' }, { maxBytes: 65536 }, {})
    expect(res).toMatchObject({ found: true, olderCursor: null, unmatchedResults: [], model: 'grok-5', effort: 'high' })
  })

  it('the legacy unpaged read stays exactly {messages, found}', async () => {
    writeLocalGrok(jl({ type: 'user', content: 'hi' }, grokAssistant('hello')))
    const res = await readChatTranscript({ sessionId: GROK_SID, cwd: CWD, agentId: 'grok' }, undefined, {})
    expect(Object.keys(res).sort()).toEqual(['found', 'messages'])
  })

  it('a CUSTOM agent built on grok reads grok\'s file — never claude\'s cwd fallback', async () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:g1' ? 'grok' : undefined))
    writeClaudeStranger()
    writeLocalGrok(jl({ type: 'user', content: 'mine' }))
    const res = await readChatTranscript({ sessionId: GROK_SID, cwd: CWD, agentId: 'custom:g1' }, { maxBytes: 65536 }, {})
    expect(JSON.stringify(res.messages)).not.toContain('SOMEONE ELSE PRIVATE')
    expect(JSON.stringify(res.messages)).toContain('mine')
  })

  it('a custom grok agent with no located session is not-found, not a stranger\'s transcript', async () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:g1' ? 'grok' : undefined))
    writeClaudeStranger()
    const res = await readChatTranscript({ sessionId: GROK_SID, cwd: CWD, agentId: 'custom:g1' }, { maxBytes: 65536 }, {})
    expect(res).toEqual({ messages: [], found: false, olderCursor: null, unmatchedResults: [] })
  })

  it('a paged local read is the newest page.maxBytes too — the same TAIL window the remote leg serves', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ type: 'user', content: `row ${i} ${'z'.repeat(60)}` }))
    writeLocalGrok(jl(...rows))
    const res = await readChatTranscript(
      { sessionId: GROK_SID, cwd: CWD, nodeId: 'n1', agentId: 'grok' },
      { maxBytes: 65536 },
      {}
    )
    expect(res.found).toBe(true)
    expect(res.olderCursor).toBeNull()
    expect(res.messages.length).toBeGreaterThan(0)
    expect(res.messages.length).toBeLessThan(rows.length)
    expect(JSON.stringify(res.messages.at(-1))).toContain('row 1999 ')
    // The partial first line was dropped, not parsed as a mangled message.
    for (const m of res.messages) expect(JSON.stringify(m)).toMatch(/row \d+ z{60}/)
    // …and the legacy unpaged read keeps the whole (5 MiB-capped) file.
    const legacy = await readChatTranscript({ sessionId: GROK_SID, cwd: CWD, nodeId: 'n1', agentId: 'grok' }, undefined, {})
    expect(legacy.messages.length).toBe(rows.length)
  })

  it('a local node (remote leg says null) still reads locally', async () => {
    writeLocalGrok(jl({ type: 'user', content: 'local grok' }))
    const readRemoteGrok = vi.fn(async () => null)
    const res = await readChatTranscript(
      { sessionId: GROK_SID, cwd: CWD, nodeId: 'n1', agentId: 'grok' },
      { maxBytes: 65536 },
      { readRemoteGrok }
    )
    expect(readRemoteGrok).toHaveBeenCalledOnce()
    expect(JSON.stringify(res.messages)).toContain('local grok')
  })
})

describe('readChatTranscript — grok, remote (SSH project)', () => {
  const remoteQ = { sessionId: GROK_SID, cwd: CWD, nodeId: 'n-remote', agentId: 'grok', remoteOnly: true }

  it('answers from the HOST, parsed like the local file, with model and effort', async () => {
    writeLocalGrok(jl({ type: 'user', content: 'THIS MACHINE' }))
    const deps: TranscriptIpcDeps = {
      readRemoteGrok: async () => ({ ok: true, text: jl({ type: 'user', content: 'the host' }, grokAssistant('ok', 'grok-h', 'low')) })
    }
    const res = await readChatTranscript(remoteQ, { maxBytes: 65536 }, deps)
    expect(res.found).toBe(true)
    expect(JSON.stringify(res.messages)).toContain('the host')
    expect(JSON.stringify(res.messages)).not.toContain('THIS MACHINE')
    expect(res).toMatchObject({ olderCursor: null, unmatchedResults: [], model: 'grok-h', effort: 'low' })
  })

  it('a host that could not be read is UNREADABLE — and this machine\'s file is never touched', async () => {
    writeLocalGrok(jl({ type: 'user', content: 'THIS MACHINE' }))
    const res = await readChatTranscript(remoteQ, { maxBytes: 65536 }, { readRemoteGrok: async () => ({ ok: false }) })
    expect(res).toEqual({ messages: [], found: false, olderCursor: null, unmatchedResults: [], unreadable: true })
  })

  it('a clean miss on the host is not-found WITHOUT unreadable', async () => {
    writeLocalGrok(jl({ type: 'user', content: 'THIS MACHINE' }))
    const res = await readChatTranscript(remoteQ, { maxBytes: 65536 }, { readRemoteGrok: async () => ({ ok: false, absent: true }) })
    expect(res).toEqual({ messages: [], found: false, olderCursor: null, unmatchedResults: [] })
  })

  it('the remote verdict is final even without remoteOnly (a live master said remote)', async () => {
    writeLocalGrok(jl({ type: 'user', content: 'THIS MACHINE' }))
    const { remoteOnly: _r, ...q } = remoteQ
    const res = await readChatTranscript(q, { maxBytes: 65536 }, { readRemoteGrok: async () => ({ ok: false }) })
    expect(res.found).toBe(false)
    expect(res.unreadable).toBe(true)
  })

  it('a known-remote node with no remote leg is unreadable, never a local read', async () => {
    writeLocalGrok(jl({ type: 'user', content: 'THIS MACHINE' }))
    for (const deps of [{}, { readRemoteGrok: async () => null }] as TranscriptIpcDeps[]) {
      const res = await readChatTranscript(remoteQ, { maxBytes: 65536 }, deps)
      expect(res).toMatchObject({ found: false, unreadable: true, messages: [] })
    }
  })

  it('the legacy unpaged remote read keeps its two-key shape on success and failure', async () => {
    const ok = await readChatTranscript(remoteQ, undefined, { readRemoteGrok: async () => ({ ok: true, text: jl({ type: 'user', content: 'h' }) }) })
    expect(Object.keys(ok).sort()).toEqual(['found', 'messages'])
    expect(ok.found).toBe(true)
    const bad = await readChatTranscript(remoteQ, undefined, { readRemoteGrok: async () => ({ ok: false }) })
    expect(bad).toEqual({ messages: [], found: false })
  })

  it('an id matching two host sessions REJECTS with its own sentence — never unreadable, never not-found', async () => {
    const readRemoteGrok = async () => ({ ok: false as const, ambiguous: true as const })
    await expect(readChatTranscript(remoteQ, { maxBytes: 65536 }, { readRemoteGrok })).rejects.toThrow(
      GROK_AMBIGUOUS_SESSION_MESSAGE
    )
    await expect(readChatTranscript(remoteQ, undefined, { readRemoteGrok })).rejects.toThrow(GROK_AMBIGUOUS_SESSION_MESSAGE)
  })

  it('hands the page\'s maxBytes to the remote leg (the legacy read asks for no window)', async () => {
    const readRemoteGrok = vi.fn(async (_q: unknown, _o?: { maxBytes?: number }) => ({ ok: true as const, text: jl({ type: 'user', content: 'h' }) }))
    await readChatTranscript(remoteQ, { maxBytes: 262144 }, { readRemoteGrok })
    expect(readRemoteGrok.mock.calls[0][1]).toEqual({ maxBytes: 262144 })
    await readChatTranscript(remoteQ, undefined, { readRemoteGrok })
    expect(readRemoteGrok.mock.calls[1][1]).toBeUndefined()
  })

  it('never asks the claude remote legs for a grok node', async () => {
    const readRemotePage = vi.fn(async () => ({ ok: true as const, data: Buffer.from(''), start: 0 }))
    const readRemote = vi.fn(async () => 'x')
    await readChatTranscript(remoteQ, { maxBytes: 65536 }, { readRemotePage, readRemote, readRemoteGrok: async () => ({ ok: false }) })
    await readChatTranscript(remoteQ, undefined, { readRemotePage, readRemote, readRemoteGrok: async () => ({ ok: false }) })
    expect(readRemotePage).not.toHaveBeenCalled()
    expect(readRemote).not.toHaveBeenCalled()
  })
})
