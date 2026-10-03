// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatTranscriptResult } from '@shared/types'
import type { AnswerPermissionPayload, HeldPermission } from '@shared/agents/permission-answer'
import { useAgentStatus } from '../state/agentStatus'
import { CHAT_ANSWER_REBIND_RETRY_MAX_MS, CHAT_ANSWER_REBIND_RETRY_MS } from '../lib/chatAnswer'

/**
 * The ⌘M answer card binds the request the DISPLAYED thread was read for (`threadHeldFor` — the held
 * ticket at the START of the last applied tail read), never the request that happens to be held
 * now. While the hook moves held A → held B (a revised plan) the thread on screen can still show
 * plan A's card with no result, and a card matched only by tool name would approve B from A's card.
 * Pure mapping: `lib/chatAnswer.test.ts` (`answerCardState`); this pins the orderings in the glue.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Pending {
  session: string | undefined
  resolve: (r: ChatTranscriptResult) => void
  reject: (e: unknown) => void
}

const { pending, session, answerPermission } = vi.hoisted(() => {
  const pending: Pending[] = []
  const readTranscript = (s: string | undefined) =>
    new Promise<ChatTranscriptResult>((resolve, reject) => pending.push({ session: s, resolve, reject }))
  const answerPermission = vi.fn(async (_p: unknown) => true)
  const session = { api: { chat: { readTranscript }, pty: { sendText: vi.fn(async () => true as const) }, answerPermission } }
  return { pending, session, answerPermission }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'

const NODE = 'n-chat-answer-bind'
const A: HeldPermission = { pendingId: 'n-p-A', toolName: 'ExitPlanMode' }
const B: HeldPermission = { pendingId: 'n-p-B', toolName: 'ExitPlanMode' }
let host: HTMLDivElement
let root: Root

const planMsg = (key: number, title: string, result?: string): ChatMessage => ({
  role: 'assistant',
  key,
  parts: [{ kind: 'tool', name: 'ExitPlanMode', arg: '', body: `# ${title}`, ...(result ? { result } : {}) }]
})
/** Plan A still unanswered on screen (the case the race is about), then plan B once the transcript has it. */
const THREAD_A = [planMsg(0, 'Plan A')]
const THREAD_B = [planMsg(0, 'Plan A', 'User rejected'), planMsg(10, 'Plan B')]

async function hold(held: HeldPermission | undefined, state: 'blocked' | 'working' = 'blocked'): Promise<void> {
  await act(async () => {
    useAgentStatus.getState().setState(NODE, state, 'claude', false, held?.pendingId, true, false, held)
  })
}
async function render(sessionId = 's1'): Promise<void> {
  await act(async () => {
    root.render(<ChatPanel nodeId={NODE} sessionId={sessionId} agentId="claude" />)
  })
}
async function settle(i: number, messages: ChatMessage[], olderCursor: number | null = null): Promise<void> {
  await act(async () => {
    pending[i].resolve({ messages, found: true, olderCursor, unmatchedResults: [] })
  })
}
async function fail(i: number): Promise<void> {
  await act(async () => {
    pending[i].reject(new Error('master down'))
  })
}
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}
const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.term-chat__tool-card')]
const controlsOn = (): number[] => cards().flatMap((c, i) => (c.querySelector('.term-chat__answer-row') ? [i] : []))
const updatingOn = (): number[] => cards().flatMap((c, i) => (c.querySelector('.term-chat__answer-updating') ? [i] : []))
const approve = (card: HTMLElement): HTMLButtonElement =>
  [...card.querySelectorAll('button')].find((b) => b.textContent === 'Approve · previous mode') as HTMLButtonElement
const sent = (): AnswerPermissionPayload => answerPermission.mock.calls.at(-1)![0] as AnswerPermissionPayload

beforeEach(() => {
  vi.useFakeTimers()
  pending.length = 0
  answerPermission.mockReset()
  answerPermission.mockResolvedValue(true)
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
  vi.useRealTimers()
})

/** Mounted with A held and plan A's card answerable. */
async function boundToA(): Promise<void> {
  await hold(A)
  await render()
  await settle(0, THREAD_A)
  expect(controlsOn()).toEqual([0])
}

describe('answer card binding', () => {
  it('held A → B with no read in flight: A card shows "Updating…", never controls, until B is read', async () => {
    await boundToA()
    await hold(B)
    // The change forced a tail reload at once; until it lands, the A card is NOT answerable…
    expect(pending).toHaveLength(2)
    expect(controlsOn()).toEqual([])
    expect(updatingOn()).toEqual([0])
    expect(cards()[0].querySelector('.term-chat__answer-updating')!.textContent).toMatch(/Updating… — or answer in the terminal/)
    // …the composer points at the terminal, not the card…
    expect(host.querySelector('.term-chat__compose textarea')!.getAttribute('placeholder')).toContain(
      'waiting for an answer in the terminal'
    )
    // …and once B's thread lands, B's card gets controls bound to B.
    await settle(1, THREAD_B)
    expect(updatingOn()).toEqual([])
    expect(controlsOn()).toEqual([1])
    await act(async () => approve(cards()[1]).click())
    expect(sent()).toEqual({ nodeId: NODE, pendingId: 'n-p-B', answer: { kind: 'plan', mode: 'restore' } })
  })

  it('held A → B while a read that started under A is in flight: that read does not bind B; the queued reload does', async () => {
    await boundToA()
    // A read starts while A is held (the ↻ button stands in for any in-flight tail read).
    await act(async () => (host.querySelector('.term-chat__refresh') as HTMLButtonElement).click())
    expect(pending).toHaveLength(2)
    await hold(B)
    // Queued, not started alongside (single-flight): still only the read that began under A.
    expect(pending).toHaveLength(2)
    // It lands with plan A's thread — read for A, so B stays "Updating…" with no controls.
    await settle(1, THREAD_A)
    expect(controlsOn()).toEqual([])
    expect(updatingOn()).toEqual([0])
    // The queued reload runs on settle and binds B.
    expect(pending).toHaveLength(3)
    await settle(2, THREAD_B)
    expect(controlsOn()).toEqual([1])
    await act(async () => approve(cards()[1]).click())
    expect(sent().pendingId).toBe('n-p-B')
  })

  it('a failed reload does not leave the card stuck: it is retried while "Updating…"', async () => {
    await boundToA()
    await hold(B)
    await fail(1)
    expect(updatingOn()).toEqual([0])
    await advance(CHAT_ANSWER_REBIND_RETRY_MS)
    expect(pending).toHaveLength(3)
    await settle(2, THREAD_B)
    expect(controlsOn()).toEqual([1])
  })

  it('held → nil: controls go away, no "Updating…", no reload', async () => {
    await boundToA()
    await hold(undefined, 'working')
    expect(controlsOn()).toEqual([])
    expect(updatingOn()).toEqual([])
    await advance(CHAT_ANSWER_REBIND_RETRY_MS * 3)
    expect(pending).toHaveLength(1)
  })

  it('nil → held: a thread read with nothing held is not bound to the new request until re-read', async () => {
    await hold(undefined, 'working')
    await render()
    await settle(0, THREAD_A)
    await hold(A)
    expect(controlsOn()).toEqual([])
    expect(updatingOn()).toEqual([0])
    // working → blocked with a new held id: ONE reload (the turn-end reload owns it), not two.
    expect(pending).toHaveLength(2)
    await settle(1, THREAD_A)
    expect(controlsOn()).toEqual([0])
    await act(async () => approve(cards()[0]).click())
    expect(sent().pendingId).toBe('n-p-A')
  })

  it('session change: the previous session\'s binding does not carry over to the new thread', async () => {
    await boundToA()
    await render('s2')
    // The new session's read is in flight: the card on screen (the old session's) is not answerable.
    expect(pending.at(-1)!.session).toBe('s2')
    expect(controlsOn()).toEqual([])
    await settle(pending.length - 1, THREAD_A)
    expect(controlsOn()).toEqual([0])
  })

  it('a click on a bound card after the store moved on (no re-render yet) answers nothing', async () => {
    await boundToA()
    const btn = approve(cards()[0])
    useAgentStatus.getState().byId[NODE]!.held = B
    await act(async () => btn.click())
    expect(answerPermission).not.toHaveBeenCalled()
  })

  it('a read under B that still shows the card A was bound to does not bind B (transcript lag)', async () => {
    await boundToA()
    await hold(B)
    // The reload started under B, but the transcript has not written plan B yet: same card as A's.
    await settle(1, THREAD_A)
    expect(controlsOn()).toEqual([])
    expect(updatingOn()).toEqual([0])
    // Kept retrying; once plan B's card is there, B binds to it.
    await advance(CHAT_ANSWER_REBIND_RETRY_MS)
    expect(pending).toHaveLength(3)
    await settle(2, THREAD_B)
    expect(controlsOn()).toEqual([1])
    await act(async () => approve(cards()[1]).click())
    expect(sent().pendingId).toBe('n-p-B')
  })

  it('retries back off (2 s, 4 s, …) and reset when the held request changes', async () => {
    await boundToA()
    await hold(B)
    await fail(1)
    await advance(CHAT_ANSWER_REBIND_RETRY_MS)
    expect(pending).toHaveLength(3)
    await fail(2)
    await advance(CHAT_ANSWER_REBIND_RETRY_MS)
    expect(pending).toHaveLength(3) // the second retry waits 4 s
    await advance(CHAT_ANSWER_REBIND_RETRY_MS)
    expect(pending).toHaveLength(4)
    await fail(3)
    // Capped: never more often than… and never later than the max.
    await advance(CHAT_ANSWER_REBIND_RETRY_MAX_MS)
    expect(pending).toHaveLength(5)
    // A new held request starts over: its reload is immediate, then 2 s again.
    await hold({ pendingId: 'n-p-C', toolName: 'ExitPlanMode' })
    await fail(4)
    await fail(5)
    await advance(CHAT_ANSWER_REBIND_RETRY_MS)
    expect(pending).toHaveLength(7)
  })

  it('with no card on screen (A answered), a failed reload still retries — quietly, with backoff — until B lands', async () => {
    const ANSWERED = [planMsg(0, 'Plan A', 'User approved')]
    await hold(A)
    await render()
    await settle(0, ANSWERED)
    await hold(B)
    expect(pending).toHaveLength(2) // the forced reload on the change
    expect(updatingOn()).toEqual([]) // no card to say "Updating…" on
    await fail(1)
    await advance(CHAT_ANSWER_REBIND_RETRY_MS)
    expect(pending).toHaveLength(3)
    await fail(2)
    await advance(CHAT_ANSWER_REBIND_RETRY_MS) // backed off: the next one waits 4 s
    expect(pending).toHaveLength(3)
    await advance(CHAT_ANSWER_REBIND_RETRY_MS)
    expect(pending).toHaveLength(4)
    // Silent throughout: the answered thread stays, no "Loading…", no error line.
    expect(host.textContent).toContain('Plan A')
    expect(host.textContent).not.toContain('Loading conversation')
    expect(host.textContent).not.toContain("Couldn't read")
    // B's card lands: bound, and the retries stop.
    await settle(3, [...ANSWERED, planMsg(10, 'Plan B')])
    expect(controlsOn()).toEqual([1])
    await advance(CHAT_ANSWER_REBIND_RETRY_MAX_MS * 2)
    expect(pending).toHaveLength(4)
  })

  it('the rebind reload never cancels an older-page fetch: it waits for it, and the page lands', async () => {
    await hold(A)
    await render()
    const el = host.querySelector('.term-chat__msgs') as HTMLDivElement
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 })
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 100 })
    // A thread with history behind it, shorter than the viewport: the older page is fetched at once.
    await settle(0, [planMsg(100, 'Plan A')], 100)
    expect(pending).toHaveLength(2)
    await hold(B)
    expect(pending).toHaveLength(2) // queued behind the older page, not started over it
    await settle(1, [{ role: 'assistant', key: 0, parts: [{ kind: 'text', text: 'earlier' }] }])
    expect(host.textContent).toContain('earlier') // the page was not cancelled
    expect(pending).toHaveLength(3)
    // A quiet reload: the thread stays on screen, no "Loading conversation…".
    expect(host.textContent).not.toContain('Loading conversation')
    await settle(2, [{ role: 'assistant', key: 0, parts: [{ kind: 'text', text: 'earlier' }] }, planMsg(100, 'Plan A', 'User rejected'), planMsg(200, 'Plan B')])
    expect(controlsOn()).toEqual([1])
  })
})
