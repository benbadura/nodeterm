// The ⌘M read for a CODEX node (`chat:read-transcript`, and the phone's `chat.page` through the same
// `readChatTranscript`). What these pin: a codex node is served from its own rollout — local or on
// its SSH host — and NEVER through claude's resolver (whose cwd fallback answers with a stranger's
// session) nor from this machine's disk when the node is remote.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { readChatTranscript, registerTranscriptIpc, type RemoteTranscriptPage, type TranscriptIpcDeps } from './transcript-ipc'
import { resetCodexRolloutCacheForTests } from './codex-chat'
import { setCustomAgentBaseResolver } from '../shared/agents/config'
import { IPC } from '../shared/ipc'
import type { ChatTranscriptResult } from '../shared/types'
import { CHAT_PAGE_DEFAULT_BYTES } from '../shared/chat-page'
import {
  CODEX_SID,
  assistantText,
  functionCall,
  functionOutput,
  rollout,
  turnContext,
  userMessageItem
} from './codex-rollout-fake'

const CWD = '/srv/demo'
let home: string
let f: ReturnType<typeof fakePlatform>
let savedCodexHome: string | undefined

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-transcript-codex-'))
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
  setCustomAgentBaseResolver(null)
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedCodexHome
  fs.rmSync(home, { recursive: true, force: true })
})

const writeRollout = (body: string, id = CODEX_SID): string => {
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', '24')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, `rollout-2026-09-24T09-00-00-${id}.jsonl`)
  fs.writeFileSync(p, body)
  return p
}
/** A claude transcript in the node's cwd — the stranger claude's cwd fallback would hand over. */
const writeClaudeStranger = (): string => {
  const dir = path.join(home, '.claude', 'projects', '-srv-demo')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, '46b36ce2-dd77-4f5e-a89e-4a0e831e83df.jsonl')
  fs.writeFileSync(p, JSON.stringify({ type: 'user', message: { content: 'STRANGER' } }) + '\n')
  return p
}
const BODY = rollout([
  turnContext('gpt-5.6-sol', 'medium'),
  userMessageItem(['fix the build']),
  functionCall('call_1', 'exec_command', { cmd: 'npm test' }),
  functionOutput('call_1', 'Output:\n3 passed'),
  assistantText('Fixed.')
])
/** `page` null = the legacy unpaged read (a default parameter would swallow an explicit undefined). */
const read = (q: Parameters<typeof readChatTranscript>[0], page: unknown = {}, deps: TranscriptIpcDeps = {}) =>
  readChatTranscript({ cwd: CWD, nodeId: 'n1', agentId: 'codex', ...q }, page, deps)

describe('readChatTranscript — codex, local', () => {
  it('serves the node\'s rollout as a paged ChatPage', async () => {
    writeRollout(BODY)
    const res = await read({ sessionId: CODEX_SID })
    expect(res.found).toBe(true)
    expect(res.olderCursor).toBeNull()
    expect(res.unmatchedResults).toEqual([])
    expect(res.model).toBe('gpt-5.6-sol')
    expect(res.effort).toBe('medium')
    expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(res.messages[1].parts[0]).toEqual({ kind: 'tool', name: 'exec_command', arg: 'npm test', id: 'call_1', result: '3 passed' })
    expect(res.messages.every((m) => typeof m.key === 'number')).toBe(true)
  })

  it('NEVER reaches claude\'s resolver: no rollout ⇒ not found, even with a claude transcript in the cwd', async () => {
    writeClaudeStranger()
    const claudeHook = writeClaudeStranger()
    const res = await read({ sessionId: CODEX_SID }, {}, { pathFor: () => claudeHook })
    expect(res).toEqual({ messages: [], found: false, olderCursor: null, unmatchedResults: [] })
    const legacy = await read({ sessionId: CODEX_SID }, null, { pathFor: () => claudeHook })
    expect(legacy).toEqual({ messages: [], found: false })
  })

  it('never answers with ANOTHER codex session', async () => {
    writeRollout(BODY, '01a0c9f4-2b7e-7c31-9d52-5e8a1f3b6c99')
    expect((await read({ sessionId: CODEX_SID })).found).toBe(false)
    expect((await read({ sessionId: undefined })).found).toBe(false)
  })

  it('uses the codex tail\'s hook-fed path, never claude\'s', async () => {
    const hooked = path.join(home, 'hooked', `rollout-2026-09-24T09-00-00-${CODEX_SID}.jsonl`)
    fs.mkdirSync(path.dirname(hooked), { recursive: true })
    fs.writeFileSync(hooked, rollout([assistantText('from the hook path')]))
    const res = await read({ sessionId: CODEX_SID }, {}, { codexPathFor: () => hooked })
    expect(res.messages[0].parts[0]).toMatchObject({ text: 'from the hook path' })
  })

  it('pages back through older windows with byte-offset keys', async () => {
    const turns = []
    for (let i = 0; i < 400; i++) turns.push(userMessageItem([`q${i} ` + 'x'.repeat(900)]), assistantText(`a${i}`))
    writeRollout(rollout(turns))
    const tail = await read({ sessionId: CODEX_SID }, { maxBytes: CHAT_PAGE_DEFAULT_BYTES })
    expect(tail.olderCursor).toBeGreaterThan(0)
    const older = await read({ sessionId: CODEX_SID }, { before: tail.olderCursor, maxBytes: CHAT_PAGE_DEFAULT_BYTES })
    expect(Math.max(...older.messages.map((m) => m.key!))).toBeLessThan(tail.olderCursor!)
    expect(older.messages.at(-1)!.key! < tail.messages[0].key!).toBe(true)
  })

  it('GROWS a window that holds no complete line instead of dropping the record', async () => {
    writeRollout(rollout([assistantText('before'), userMessageItem(['big ' + 'y'.repeat(300_000)])]))
    const res = await read({ sessionId: CODEX_SID }, { maxBytes: 64 * 1024 })
    expect(res.messages.at(-1)!.parts[0]).toMatchObject({ kind: 'text' })
    expect(JSON.stringify(res.messages.at(-1))).toContain('big yyy')
  })

  it('the unpaged (legacy) read answers {messages, found} with no keys', async () => {
    writeRollout(BODY)
    const res = await read({ sessionId: CODEX_SID }, null)
    expect(Object.keys(res).sort()).toEqual(['found', 'messages'])
    expect(res.found).toBe(true)
    expect(res.messages.every((m) => m.key === undefined)).toBe(true)
  })

  it('a custom agent whose base harness is codex is read as codex', async () => {
    writeRollout(BODY)
    writeClaudeStranger()
    setCustomAgentBaseResolver((id) => (id === 'custom:cx' ? 'codex' : undefined))
    const res = await read({ sessionId: CODEX_SID, agentId: 'custom:cx' })
    expect(res.found).toBe(true)
    expect(res.messages[0].parts[0]).toMatchObject({ text: 'fix the build' })
  })
})

describe('readChatTranscript — codex, remote', () => {
  const remoteBody = Buffer.from(rollout([userMessageItem(['on the host']), assistantText('hello from the host')]))
  const hostPage = (): TranscriptIpcDeps['readRemoteCodexPage'] =>
    vi.fn(async (_q, page): Promise<RemoteTranscriptPage> => {
      const end = page.before ?? remoteBody.length
      const windowStart = Math.max(0, end - page.maxBytes)
      const start = windowStart > 0 ? windowStart - 1 : 0
      return { ok: true, data: remoteBody.subarray(start, end), start }
    })

  it('reads the HOST\'s rollout, never the local one of the same id', async () => {
    writeRollout(rollout([assistantText('LOCAL — wrong machine')]))
    const readRemoteCodexPage = hostPage()
    const res = await read({ sessionId: CODEX_SID, remoteOnly: true }, {}, { readRemoteCodexPage })
    expect(res.found).toBe(true)
    expect(JSON.stringify(res.messages)).toContain('hello from the host')
    expect(JSON.stringify(res.messages)).not.toContain('LOCAL')
  })

  it('never takes claude\'s remote leg for a codex node', async () => {
    const readRemotePage = vi.fn(async () => ({ ok: true as const, data: Buffer.from('{}'), start: 0 }))
    await read({ sessionId: CODEX_SID }, {}, { readRemotePage, readRemoteCodexPage: hostPage() })
    await read({ sessionId: CODEX_SID }, {}, { readRemotePage })
    expect(readRemotePage).not.toHaveBeenCalled()
  })

  it('a host that could not be read is UNREADABLE; a clean miss is not found', async () => {
    writeRollout(BODY)
    const failed = await read({ sessionId: CODEX_SID }, {}, { readRemoteCodexPage: async () => ({ ok: false }) })
    expect(failed).toMatchObject({ found: false, unreadable: true, messages: [] })
    const absent = await read({ sessionId: CODEX_SID }, {}, { readRemoteCodexPage: async () => ({ ok: false, absent: true }) })
    expect(absent).toEqual({ messages: [], found: false, olderCursor: null, unmatchedResults: [] })
  })

  it('a known-remote node the remote leg cannot place is unreadable — this machine\'s disk is never read', async () => {
    writeRollout(BODY)
    const paged = await read({ sessionId: CODEX_SID, remoteOnly: true }, {}, { readRemoteCodexPage: async () => null })
    expect(paged).toMatchObject({ found: false, unreadable: true, messages: [] })
    const noLeg = await read({ sessionId: CODEX_SID, remoteOnly: true })
    expect(noLeg).toMatchObject({ found: false, unreadable: true, messages: [] })
    const legacy = await read({ sessionId: CODEX_SID, remoteOnly: true }, null)
    expect(legacy).toEqual({ messages: [], found: false })
  })

  it('a growth re-read that fails is a failed read, never a local fallback', async () => {
    writeRollout(BODY)
    let calls = 0
    const readRemoteCodexPage = async (_q: unknown, page: { before: number | null; maxBytes: number }): Promise<RemoteTranscriptPage | null> => {
      calls++
      if (calls > 1) return null
      const big = Buffer.from('x'.repeat(200_000) + '\n')
      return { ok: true, data: big.subarray(big.length - page.maxBytes - 1), start: big.length - page.maxBytes - 1 }
    }
    const res = await read({ sessionId: CODEX_SID }, { maxBytes: 64 * 1024 }, { readRemoteCodexPage })
    expect(res).toMatchObject({ found: false, unreadable: true })
  })
})

describe('registerTranscriptIpc — codex node', () => {
  const chat = (nodeId: string) =>
    f.handlers[IPC.chatReadTranscript](CODEX_SID, CWD, undefined, nodeId, 'codex', {}) as Promise<ChatTranscriptResult>

  it('the shell\'s own record of a remote node forces remote-only', async () => {
    writeRollout(BODY)
    registerTranscriptIpc({ isRemoteNode: (id) => id === 'remote-node' })
    expect(await chat('remote-node')).toMatchObject({ found: false, unreadable: true })
    expect((await chat('local-node')).found).toBe(true)
  })
})
