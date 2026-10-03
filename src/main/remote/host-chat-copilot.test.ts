// The phone's Chat screen for a COPILOT node, end to end through the relay's `chat.page` verb and
// the REAL transcript reader (`readChatTranscript`): the desktop parses, the phone renders the v1
// wire format, so a copilot page served here is exactly what the phone gets.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHostChat, type HostChatDeps, type HostChatNode } from './host-chat'
import { readChatTranscript } from '../../core/transcript-ipc'
import { setCustomAgentBaseResolver } from '../../shared/agents/config'
import type { HeldPermissionIo } from '../../core/agents/permission-decision'

const SID = '11111111-2222-4333-8444-555555555555'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-host-chat-copilot-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.stubEnv('COPILOT_HOME', '')
  const dir = path.join(home, '.copilot', 'session-state', SID)
  fs.mkdirSync(dir, { recursive: true })
  const ev = (type: string, data: object, i: number): string =>
    JSON.stringify({ type, data, id: `id-${i}`, timestamp: '2026-09-28T20:35:16.000Z', parentId: null }) + '\n'
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    ev('user.message', { content: 'from the phone' }, 0) +
      ev('assistant.message', { messageId: 'm', model: 'gpt-5.5', content: 'copilot answered', toolRequests: [] }, 1)
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  setCustomAgentBaseResolver(null)
  fs.rmSync(home, { recursive: true, force: true })
})

function deps(node: HostChatNode): HostChatDeps {
  return {
    lookupNode: (id) => (id === 'n1' ? node : null),
    readTranscript: (q, rawPage) => readChatTranscript(q, rawPage, {}),
    answerIo: () => ({ readPending: async () => null, write: async () => true }) as HeldPermissionIo,
    isStructuredTicket: () => false,
    renderer: {
      status: vi.fn(async () => null),
      send: vi.fn(async () => null),
      session: vi.fn(async () => null)
    },
    hostSendRefusal: () => null,
    knownTickets: () => [],
    timeoutMs: 20
  }
}

describe('host-chat page — copilot', () => {
  it('serves a copilot node its own journal as a v1 page', async () => {
    const page = await createHostChat(deps({ agentId: 'copilot', sessionId: SID, cwd: '/srv/app' })).page('n1', {})
    expect(page).toMatchObject({ version: 1, found: true, sessionId: SID, model: 'gpt-5.5', olderCursor: null })
    const texts = (page as { messages: Array<{ parts: Array<{ text?: string }> }> }).messages.map((m) => m.parts[0].text)
    expect(texts).toEqual(['from the phone', 'copilot answered'])
  })

  it('serves a custom agent built on copilot the same journal', async () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:cp' ? 'copilot' : undefined))
    const page = await createHostChat(deps({ agentId: 'custom:cp', sessionId: SID })).page('n1', {})
    expect(page).toMatchObject({ version: 1, found: true })
  })

  it('a REMOTE copilot node is an error on the phone, never this machine\'s namesake journal', async () => {
    await expect(
      createHostChat(deps({ agentId: 'copilot', sessionId: SID, cwd: '/srv/app', remote: true })).page('n1', {})
    ).rejects.toThrow('Could not read the transcript.')
  })
})
