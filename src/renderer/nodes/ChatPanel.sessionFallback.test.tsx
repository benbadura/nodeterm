// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/types'
import type { HeldPermission } from '@shared/agents/permission-answer'
import { useAgentStatus } from '../state/agentStatus'
import { FALLBACK_SESSION_NOTE } from '../lib/transcriptSession'

/**
 * The ⌘M panel reading a node's PERSISTED launch id (no hook-confirmed one — lib/transcriptSession.ts).
 * Pins the three honesty rules: the quiet note is shown, the read carries NO cwd (claude's resolver
 * would otherwise answer a missing id with the newest transcript in that folder — another session),
 * and plan/question answer controls are never offered (an answer is a write bound to the live ticket).
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { session, reads, readTranscript } = vi.hoisted(() => {
  const reads: { messages: unknown[] } = { messages: [] }
  const readTranscript = vi.fn(async (..._args: unknown[]) => ({
    messages: reads.messages,
    found: true,
    olderCursor: null,
    unmatchedResults: []
  }))
  const session = {
    api: {
      chat: { readTranscript },
      pty: { sendText: vi.fn(async () => true as const) },
      answerPermission: vi.fn(async () => true)
    }
  }
  return { session, reads, readTranscript }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'

const NODE = 'n-chat-fallback'
let host: HTMLDivElement
let root: Root

const planMsg: ChatMessage = {
  role: 'assistant',
  key: 0,
  parts: [{ kind: 'tool', name: 'ExitPlanMode', arg: '', body: '# Plan' }]
}

async function mount(props: { sessionFallback?: boolean }): Promise<void> {
  await act(async () => {
    root.render(<ChatPanel nodeId={NODE} sessionId="s-minted" cwd="/work/repo" agentId="claude" {...props} />)
  })
}
const note = (): string | null => host.querySelector('.term-chat__fallback-note')?.textContent ?? null
const answerButtons = (): number => host.querySelectorAll('.term-chat__tool-card button').length

beforeEach(() => {
  readTranscript.mockClear()
  reads.messages = [planMsg]
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useAgentStatus.setState((s) => {
    const byId = { ...s.byId }
    delete byId[NODE]
    return { byId }
  })
})

async function holdPlan(): Promise<void> {
  const held: HeldPermission = { pendingId: 'p-1', toolName: 'ExitPlanMode' }
  await act(async () => {
    useAgentStatus.getState().setState(NODE, 'blocked', 'claude', false, held.pendingId, true, false, held)
  })
}

describe('ChatPanel on a fallback session id', () => {
  it('says it is showing the launch conversation and reads strictly by id', async () => {
    await mount({ sessionFallback: true })
    expect(note()).toBe(FALLBACK_SESSION_NOTE)
    expect(readTranscript).toHaveBeenCalled()
    for (const call of readTranscript.mock.calls) {
      expect(call[0]).toBe('s-minted')
      expect(call[1]).toBeUndefined() // no cwd: no cwd-newest fallback to another session
    }
  })

  it('never offers answer controls, even while a matching plan ticket is held', async () => {
    await holdPlan()
    await mount({ sessionFallback: true })
    expect(host.querySelectorAll('.term-chat__tool-card').length).toBe(1)
    expect(answerButtons()).toBe(0)
  })

  it('a hook-confirmed id is unchanged: no note, cwd carried, controls offered', async () => {
    await holdPlan()
    await mount({})
    expect(note()).toBeNull()
    expect(readTranscript.mock.calls[0][1]).toBe('/work/repo')
    expect(answerButtons()).toBeGreaterThan(0)
  })
})
