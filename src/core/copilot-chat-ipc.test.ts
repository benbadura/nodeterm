// How a copilot node's ⌘M read is ROUTED. The parser is tested in copilot-chat.test.ts; what these
// pin is that the answer comes from the node's OWN journal on the right machine, or not at all:
//   - never claude's resolver (its cwd fallback hands back the newest CLAUDE transcript for the
//     directory — a stranger's conversation), and never another copilot session;
//   - never this machine's disk for a remote (SSH) node, whose journal lives on the host.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { readChatTranscript, registerTranscriptIpc } from './transcript-ipc'
import { locateCopilotTranscript } from './copilot-chat'
import { setCustomAgentBaseResolver } from '../shared/agents/config'
import { IPC } from '../shared/ipc'
import type { ChatTranscriptResult } from '../shared/types'

const SID = '11111111-2222-4333-8444-555555555555'
const OTHER_SID = '99999999-2222-4333-8444-555555555555'
const CWD = '/srv/app'

const ev = (type: string, data: object, i = 0): string =>
  JSON.stringify({
    type,
    data,
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    timestamp: '2026-09-28T20:35:16.000Z',
    parentId: null
  }) + '\n'
const journal = (prompt: string, answer: string): string =>
  ev('session.start', { sessionId: SID, version: 1, producer: 'copilot-agent', copilotVersion: '1.0.88', startTime: 'x' }) +
  ev('user.message', { content: prompt }, 1) +
  ev('assistant.message', { messageId: 'm', model: 'gpt-5.5', content: answer, toolRequests: [] }, 2)

let home: string
let f: ReturnType<typeof fakePlatform>

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-copilot-chat-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.stubEnv('COPILOT_HOME', '')
  f = fakePlatform()
  initPlatform(f)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  setCustomAgentBaseResolver(null)
  resetPlatformForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

function writeJournal(root: string, sessionId: string, body: string): string {
  const dir = path.join(root, 'session-state', sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, 'events.jsonl')
  fs.writeFileSync(p, body)
  return p
}
/** A CLAUDE transcript for the same cwd — the one claude's cwd fallback would hand back. */
function writeClaudeNeighbour(): void {
  const dir = path.join(home, '.claude', 'projects', '-srv-app')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl'),
    JSON.stringify({ type: 'user', message: { content: 'CLAUDE-NEIGHBOUR' } }) + '\n'
  )
}

// `null` = no page = the legacy read (NOT `undefined`, which would fire the default parameter).
const read = (q: Record<string, unknown>, page: unknown = { maxBytes: 65536 }, deps = {}) =>
  readChatTranscript({ cwd: CWD, agentId: 'copilot', ...q }, page, deps)

describe('locateCopilotTranscript', () => {
  it('finds `<COPILOT_HOME>/session-state/<id>/events.jsonl`', async () => {
    const custom = path.join(home, 'custom-copilot-home')
    vi.stubEnv('COPILOT_HOME', custom)
    const p = writeJournal(custom, SID, journal('a', 'b'))
    expect(await locateCopilotTranscript(SID)).toBe(p)
  })

  it('defaults to ~/.copilot, then the snap package\'s remapped home', async () => {
    const snap = writeJournal(path.join(home, 'snap', 'copilot-cli', 'common', '.copilot'), SID, journal('a', 'b'))
    expect(await locateCopilotTranscript(SID)).toBe(snap)
    const plain = writeJournal(path.join(home, '.copilot'), SID, journal('a', 'b'))
    expect(await locateCopilotTranscript(SID)).toBe(plain)
  })

  it('refuses an id that could leave the session-state directory', async () => {
    writeJournal(path.join(home, '.copilot'), SID, journal('a', 'b'))
    // A real file the traversal WOULD reach: `session-state/../escape/events.jsonl`.
    fs.mkdirSync(path.join(home, '.copilot', 'escape'), { recursive: true })
    fs.writeFileSync(path.join(home, '.copilot', 'escape', 'events.jsonl'), journal('ESCAPED', 'x'))
    expect(await locateCopilotTranscript('../escape')).toBeUndefined()
    for (const bad of ['../' + SID, `${SID}/../${SID}`, '', 'x', '/etc/passwd']) {
      expect(await locateCopilotTranscript(bad)).toBeUndefined()
    }
    expect(await locateCopilotTranscript(undefined)).toBeUndefined()
  })

  it('a directory named like the id but holding no journal is not a transcript', async () => {
    fs.mkdirSync(path.join(home, '.copilot', 'session-state', SID, 'events.jsonl'), { recursive: true })
    expect(await locateCopilotTranscript(SID)).toBeUndefined()
  })
})

describe('readChatTranscript — copilot routing', () => {
  it('reads the node\'s own journal, paged: keys, olderCursor null for a small file, model', async () => {
    writeJournal(path.join(home, '.copilot'), SID, journal('hello copilot', 'hi there'))
    const res = await read({ sessionId: SID })
    expect(res.found).toBe(true)
    expect(res.olderCursor).toBeNull()
    expect(res.unmatchedResults).toEqual([])
    expect(res.model).toBe('gpt-5.5')
    expect(res.messages.map((m) => [m.role, (m.parts[0] as { text: string }).text])).toEqual([
      ['user', 'hello copilot'],
      ['assistant', 'hi there']
    ])
    expect(res.messages.every((m) => typeof m.key === 'number')).toBe(true)
  })

  it('reads it unpaged too (the legacy shape, byte for byte: no paging fields)', async () => {
    writeJournal(path.join(home, '.copilot'), SID, journal('hello copilot', 'hi there'))
    const res = await read({ sessionId: SID }, null)
    expect(Object.keys(res).sort()).toEqual(['found', 'messages'])
    expect(res.found).toBe(true)
    expect(res.messages.map((m) => m.key)).toEqual([undefined, undefined])
  })

  it('pages back through a journal bigger than the window', async () => {
    const big = 'lorem ipsum dolor sit amet '.repeat(200)
    let body = ev('session.start', { sessionId: SID, version: 1, producer: 'copilot-agent', copilotVersion: '1', startTime: 'x' })
    for (let i = 0; i < 60; i++) {
      body += ev('user.message', { content: `q${i}` }, i * 2 + 1)
      body += ev('assistant.message', { messageId: 'm', content: `a${i} ${big}`, toolRequests: [] }, i * 2 + 2)
    }
    const p = writeJournal(path.join(home, '.copilot'), SID, body)
    expect(fs.statSync(p).size).toBeGreaterThan(3 * 65536)
    const seen: string[] = []
    let before: number | null = null
    for (let n = 0; n < 20; n++) {
      const page: { maxBytes: number; before?: number } = { maxBytes: 65536 }
      if (before !== null) page.before = before
      const res: ChatTranscriptResult = await read({ sessionId: SID }, page)
      expect(res.found).toBe(true)
      seen.unshift(...res.messages.filter((m) => m.role === 'user').map((m) => (m.parts[0] as { text: string }).text))
      if (res.olderCursor === null || res.olderCursor === undefined) break
      before = res.olderCursor
    }
    expect(seen).toEqual(Array.from({ length: 60 }, (_, i) => `q${i}`))
  })

  it('NEVER another session\'s transcript: a missing journal is not-found, not claude\'s cwd-newest or a sibling copilot session', async () => {
    writeClaudeNeighbour()
    writeJournal(path.join(home, '.copilot'), OTHER_SID, journal('OTHER-COPILOT-SESSION', 'x'))
    for (const page of [{ maxBytes: 65536 }, null]) {
      const res = await read({ sessionId: SID }, page)
      expect(res.found).toBe(false)
      expect(res.unreadable).toBeUndefined()
      expect(JSON.stringify(res)).not.toContain('CLAUDE-NEIGHBOUR')
      expect(JSON.stringify(res)).not.toContain('OTHER-COPILOT-SESSION')
    }
    // No session id at all: still nothing, never the cwd's newest.
    const res = await read({ sessionId: undefined })
    expect(res.found).toBe(false)
    expect(JSON.stringify(res)).not.toContain('CLAUDE-NEIGHBOUR')
  })

  it('never consults claude\'s hook-fed path authority or the remote claude reader for a local copilot node', async () => {
    writeJournal(path.join(home, '.copilot'), SID, journal('mine', 'reply'))
    const pathFor = vi.fn(() => '/nonexistent/claude.jsonl')
    const readRemotePage = vi.fn(async () => ({ ok: true as const, data: Buffer.from('{"type":"user","message":{"content":"CLAUDE-REMOTE"}}\n'), start: 0 }))
    const res = await read({ sessionId: SID }, { maxBytes: 65536 }, { pathFor, readRemotePage })
    expect(res.found).toBe(true)
    expect(JSON.stringify(res)).toContain('mine')
    expect(JSON.stringify(res)).not.toContain('CLAUDE-REMOTE')
    expect(pathFor).not.toHaveBeenCalled()
    expect(readRemotePage).not.toHaveBeenCalled()
  })

  it('a REMOTE node never reads this machine: unreadable when paged, not-found unpaged — even with the same id on disk here', async () => {
    writeJournal(path.join(home, '.copilot'), SID, journal('LOCAL-NAMESAKE', 'x'))
    const paged = await read({ sessionId: SID, nodeId: 'nt-1', remoteOnly: true })
    expect(paged).toEqual({ messages: [], found: false, olderCursor: null, unmatchedResults: [], unreadable: true })
    const legacy = await read({ sessionId: SID, nodeId: 'nt-1', remoteOnly: true }, null)
    expect(legacy).toEqual({ messages: [], found: false })
  })

  it('the IPC handler decides remoteness from the shell\'s records, not the renderer', async () => {
    writeJournal(path.join(home, '.copilot'), SID, journal('LOCAL-NAMESAKE', 'x'))
    registerTranscriptIpc({ isRemoteNode: (id) => id === 'remote-node' })
    const h = f.handlers[IPC.chatReadTranscript]
    const remote = (await h(SID, CWD, undefined, 'remote-node', 'copilot', { maxBytes: 65536 })) as ChatTranscriptResult
    expect(remote.unreadable).toBe(true)
    expect(JSON.stringify(remote)).not.toContain('LOCAL-NAMESAKE')
    const local = (await h(SID, CWD, undefined, 'local-node', 'copilot', { maxBytes: 65536 })) as ChatTranscriptResult
    expect(local.found).toBe(true)
    expect(JSON.stringify(local)).toContain('LOCAL-NAMESAKE')
  })

  it('a custom agent built on copilot reads copilot\'s journal, not claude\'s resolver', async () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:cp' ? 'copilot' : undefined))
    writeClaudeNeighbour()
    writeJournal(path.join(home, '.copilot'), SID, journal('custom copilot', 'ok'))
    const res = await read({ sessionId: SID, agentId: 'custom:cp' })
    expect(res.found).toBe(true)
    expect(JSON.stringify(res)).toContain('custom copilot')
    const missing = await read({ sessionId: OTHER_SID, agentId: 'custom:cp' })
    expect(missing.found).toBe(false)
    expect(JSON.stringify(missing)).not.toContain('CLAUDE-NEIGHBOUR')
  })

  it('an invalid page is still refused before anything is read', async () => {
    writeJournal(path.join(home, '.copilot'), SID, journal('a', 'b'))
    await expect(read({ sessionId: SID }, { before: -1 })).rejects.toThrow('Invalid transcript page')
  })
})
