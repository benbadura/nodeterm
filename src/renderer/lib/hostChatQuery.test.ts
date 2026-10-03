// The renderer half of the phone Chat verbs: main asks, the renderer answers from the store it owns
// and the ⌘M composer's own send gate. What these pin:
//   - status is read verbatim from the agent-status entry (unknown ⇒ state null, flags false);
//   - send runs `chatSendRefusal` AT SEND TIME and refuses a held request too, never types past
//     the deadline main set, and reports `'sent'` only for a sendText that answered `=== true`.
import { describe, expect, it, vi } from 'vitest'
import { hostChatSend, hostChatSession, hostChatStatus } from './hostChatQuery'

const HELD = { pendingId: 'p-1', toolName: 'ExitPlanMode' }

describe('hostChatStatus', () => {
  it('reads the entry verbatim', () => {
    expect(
      hostChatStatus({ state: 'waiting', held: HELD, hibernated: true, paused: false, dropped: true, sessionEnded: false })
    ).toEqual({ state: 'waiting', held: HELD, hibernated: true, paused: false, dropped: true, sessionEnded: false })
  })
  it('no entry ⇒ unknown state, no hold, no flags', () => {
    expect(hostChatStatus(undefined)).toEqual({
      state: null,
      held: null,
      hibernated: false,
      paused: false,
      dropped: false,
      sessionEnded: false
    })
  })
})

describe('hostChatSession', () => {
  it('answers the store\'s session id, or nothing', () => {
    expect(hostChatSession({ sessionId: 'sid' })).toEqual({ sessionId: 'sid' })
    expect(hostChatSession(undefined)).toEqual({})
  })
})

describe('hostChatSend', () => {
  const base = { requestId: 'r', kind: 'send' as const, nodeId: 'n1', agentId: 'claude', text: 'hi', startBy: 2000 }
  const run = (
    status: Record<string, unknown> | undefined,
    sendText: ReturnType<typeof vi.fn> = vi.fn(async () => true),
    now = 1000
  ) =>
    hostChatSend(base, { getStatus: () => status as never, sendText: sendText as never, now: () => now, paneRefusal: async () => null }).then((r) => ({
      r,
      sendText
    }))

  it('sends in done / unknown and reports sent only for === true', async () => {
    for (const st of [{ state: 'done' }, undefined, {}]) {
      const { r, sendText } = await run(st)
      expect(r).toEqual({ result: 'sent' })
      expect(sendText).toHaveBeenCalledWith('n1', 'hi')
    }
  })
  it('refuses working / waiting / blocked, and a held request', async () => {
    const want = ['working', 'dialog', 'dialog', 'dialog']
    for (const [i, st] of [{ state: 'working' }, { state: 'waiting' }, { state: 'blocked' }, { state: 'done', held: HELD }].entries()) {
      const { r, sendText } = await run(st)
      expect(r).toEqual({ result: 'refused', reason: want[i] })
      expect(sendText).not.toHaveBeenCalled()
    }
  })
  it('refuses when a shell owns the pane (hibernated, paused, dropped, exited)', async () => {
    const want = ['asleep', 'paused', 'dropped', 'exited']
    for (const [i, st] of [{ hibernated: true }, { paused: true }, { dropped: true }, { sessionEnded: true }].entries()) {
      const { r, sendText } = await run({ state: 'done', ...st })
      expect(r).toEqual({ result: 'refused', reason: want[i] })
      expect(sendText).not.toHaveBeenCalled()
    }
  })
  it('refuses a node whose agent is unknown everywhere (no process can be proven in the pane)', async () => {
    const sendText = vi.fn(async () => true as const)
    const r = await hostChatSend({ ...base, agentId: undefined }, { getStatus: () => ({ state: 'done' }), sendText, now: () => 1000, paneRefusal: async () => null })
    expect(r).toEqual({ result: 'refused', reason: 'exited' })
    expect(sendText).not.toHaveBeenCalled()
  })
  it('falls back to the store\'s agent id when main has none', async () => {
    const sendText = vi.fn(async () => true as const)
    const r = await hostChatSend(
      { ...base, agentId: undefined },
      { getStatus: () => ({ state: 'done', agentId: 'claude' }), sendText, now: () => 1000, paneRefusal: async () => null }
    )
    expect(r).toEqual({ result: 'sent' })
  })
  it('a query received after startBy is refused unsent', async () => {
    const { r, sendText } = await run({ state: 'done' }, vi.fn(async () => true as const), 2001)
    expect(r).toEqual({ result: 'refused', reason: 'late' })
    expect(sendText).not.toHaveBeenCalled()
  })
  it('passes a partial delivery through, and never reports sent for false / throw / truthy junk', async () => {
    expect((await run({ state: 'done' }, vi.fn(async () => 'pasted-not-submitted' as const))).r).toEqual({ result: 'pasted-not-submitted' })
    expect((await run({ state: 'done' }, vi.fn(async () => false as const))).r).toEqual({ result: 'refused', reason: 'failed' })
    // A sendText that REJECTED may have pasted already: unconfirmed, so the phone does not resend.
    expect((await run({ state: 'done' }, vi.fn(async () => { throw new Error('x') }))).r).toEqual({ result: 'unconfirmed' })
    expect((await run({ state: 'done' }, vi.fn(async () => 'yes' as never))).r).toEqual({ result: 'refused', reason: 'failed' })
  })
  it('asks the KERNEL gate last, with the resolved agent id, and refuses what it refuses — nothing typed', async () => {
    // codex announces no session end: after a `/quit` the store still reads `done`, and only the
    // pane's foreground process group can tell that a shell would receive the text.
    for (const [refusal, reason] of [['exited', 'exited'], ['unverified', 'unavailable']] as const) {
      const sendText = vi.fn(async () => true as const)
      const paneRefusal = vi.fn(async () => refusal)
      const r = await hostChatSend({ ...base, agentId: 'codex' }, { getStatus: () => ({ state: 'done' }), sendText, now: () => 1000, paneRefusal })
      expect(r).toEqual({ result: 'refused', reason })
      expect(paneRefusal).toHaveBeenCalledWith('n1', 'codex')
      expect(sendText).not.toHaveBeenCalled()
    }
  })
  it('a kernel gate that throws refuses (unavailable) rather than typing', async () => {
    const sendText = vi.fn(async () => true as const)
    const r = await hostChatSend(
      { ...base, agentId: 'codex' },
      { getStatus: () => ({ state: 'done' }), sendText, now: () => 1000, paneRefusal: async () => { throw new Error('x') } }
    )
    expect(r).toEqual({ result: 'refused', reason: 'unavailable' })
    expect(sendText).not.toHaveBeenCalled()
  })
  it('the store gate refuses FIRST — no pane probe for a working agent', async () => {
    const paneRefusal = vi.fn(async () => null)
    await hostChatSend({ ...base, agentId: 'codex' }, { getStatus: () => ({ state: 'working' }), sendText: vi.fn(), now: () => 1000, paneRefusal })
    expect(paneRefusal).not.toHaveBeenCalled()
  })
})
