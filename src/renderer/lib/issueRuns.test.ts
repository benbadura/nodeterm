import { describe, expect, it } from 'vitest'
import {
  NO_ISSUE_RUNS,
  boundRunsByIssue,
  issueRunChip,
  issueRunChipSig,
  runEndState,
  runEndedEntry,
  runStartedEntry,
  type IssueRunSession
} from './issueRuns'

const REF = { owner: 'eneskirca', repo: 'nodeterm', number: 42 }

describe('runStartedEntry / runEndedEntry', () => {
  it('files a run-started event under the ISSUE card, naming the session', () => {
    expect(
      runStartedEntry(REF, { id: 'term-1', title: 'Claude', agentId: 'claude', agentSessionId: 'sid-1' })
    ).toEqual({
      kind: 'event',
      nodeId: 'github-issue:eneskirca/nodeterm#42',
      event: {
        type: 'run-started',
        title: 'Claude',
        run: { nodeId: 'term-1', agentId: 'claude', sessionId: 'sid-1' }
      }
    })
  })

  it('omits what it does not know rather than inventing it (no session id for an agent that mints none)', () => {
    const e = runStartedEntry(REF, { id: 'term-1', title: 'Codex', agentId: 'codex' })!
    expect(e.event?.run).toEqual({ nodeId: 'term-1', agentId: 'codex' })
  })

  it('writes nothing for a node with no valid binding', () => {
    expect(runStartedEntry(undefined, { id: 't', title: 'x' })).toBeNull()
    expect(runStartedEntry({ owner: 'o;rm', repo: 'r', number: 1 }, { id: 't', title: 'x' })).toBeNull()
    expect(runEndedEntry(undefined, { id: 't', title: 'x' }, undefined)).toBeNull()
  })

  it('records the end with the last observed state and the live session id first', () => {
    const e = runEndedEntry(
      REF,
      { id: 'term-1', title: 'Claude', agentId: 'claude', agentSessionId: 'minted' },
      { state: 'done', unread: false, sessionId: 'live' }
    )!
    expect(e.nodeId).toBe('github-issue:eneskirca/nodeterm#42')
    expect(e.event).toEqual({
      type: 'run-ended',
      title: 'Claude',
      run: { nodeId: 'term-1', agentId: 'claude', sessionId: 'live', end: 'done' }
    })
  })

  it('carries no cost or token figure (there is no cumulative number to report)', () => {
    const e = runEndedEntry(REF, { id: 't', title: 'x' }, { state: 'done', unread: false })!
    expect(JSON.stringify(e)).not.toMatch(/cost|token|usage/i)
  })
})

describe('runEndState', () => {
  it.each([
    [undefined, 'unknown'],
    [{ unread: false }, 'unknown'],
    [{ state: 'working', unread: false }, 'working'],
    [{ state: 'waiting', unread: false }, 'waiting'],
    [{ state: 'blocked', unread: false }, 'blocked'],
    [{ state: 'done', unread: false }, 'done'],
    [{ state: 'done', unread: false, lastTurnError: { at: 1 } }, 'errored'],
    [{ state: 'done', unread: false, dropped: true }, 'dropped']
  ] as const)('%j → %s', (status, end) => {
    expect(runEndState(status as never)).toBe(end)
  })
})

describe('issueRunChip — the chip follows the bound node state', () => {
  it.each([
    [undefined, 'idle'],
    [{ state: 'working', unread: false }, 'running'],
    [{ state: 'waiting', unread: false }, 'needs'],
    [{ state: 'blocked', unread: false }, 'needs'],
    [{ state: 'done', unread: false }, 'idle'],
    [{ state: 'done', unread: true }, 'idle'],
    [{ state: 'done', unread: false, lastTurnError: { at: 1 } }, 'failed'],
    [{ state: 'done', unread: false, dropped: true }, 'dropped'],
    [{ unread: false, paused: true }, 'paused'],
    [{ unread: false, hibernated: true }, 'sleeping'],
    [{ state: 'done', unread: false, hibernated: true, lastTurnError: { at: 1 } }, 'failed'],
    [{ state: 'working', unread: false, hibernated: true }, 'running']
  ] as const)('%j → %s', (status, kind) => {
    expect(issueRunChip(status as never).kind).toBe(kind)
  })

  it('agrees with the session card badge on every state they share (one precedence, not two)', async () => {
    const { cardBadge } = await import('./kanbanStatusChips')
    const states = [
      { unread: false, state: 'working' }, { unread: false, state: 'waiting' }, { unread: false, state: 'blocked' },
      { unread: false, state: 'done' }, { unread: false, dropped: true, state: 'done' },
      { unread: false, paused: true }, { unread: false, hibernated: true }
    ]
    for (const st of states) {
      const badge = cardBadge('terminal', st as never)
      expect(issueRunChip(st as never).kind).toBe(badge ?? 'idle')
    }
  })

  it('carries unread separately from the state', () => {
    expect(issueRunChip({ state: 'done', unread: true }).unread).toBe(true)
    expect(issueRunChip({ state: 'working', unread: false }).unread).toBe(false)
  })

  it('reduces to a primitive signature that changes only when the chip would', () => {
    const a = issueRunChipSig({ state: 'working', unread: false, stateAt: 1 } as never)
    const b = issueRunChipSig({ state: 'working', unread: false, stateAt: 999 } as never)
    expect(a).toBe(b)
    expect(issueRunChipSig({ state: 'done', unread: false })).not.toBe(a)
    expect(issueRunChipSig({ state: 'done', unread: true })).not.toBe(issueRunChipSig({ state: 'done', unread: false }))
  })
})

describe('boundRunsByIssue', () => {
  const s = (id: string, issueRef?: unknown, title = id): IssueRunSession =>
    ({ id, title, agentId: 'claude', issueRef }) as IssueRunSession

  it('groups bound sessions under their issue, case-insensitively', () => {
    const map = boundRunsByIssue([
      s('a', REF),
      s('b', { owner: 'EnesKirca', repo: 'NodeTerm', number: 42 }),
      s('c', { ...REF, number: 7 }),
      s('d')
    ])
    expect(map.get('eneskirca/nodeterm#42')?.map((r) => r.id)).toEqual(['a', 'b'])
    expect(map.get('eneskirca/nodeterm#7')?.map((r) => r.id)).toEqual(['c'])
    expect(map.size).toBe(2)
  })

  it('ignores a hostile binding instead of grouping it', () => {
    expect(boundRunsByIssue([s('a', { owner: 'o', repo: 'r;x', number: 1 })]).size).toBe(0)
  })

  it('reuses the previous array when a bound set did not change (memoized cards keep their props)', () => {
    const first = boundRunsByIssue([s('a', REF)])
    const second = boundRunsByIssue([s('a', REF), s('z')], first)
    expect(second.get('eneskirca/nodeterm#42')).toBe(first.get('eneskirca/nodeterm#42'))
    const renamed = boundRunsByIssue([s('a', REF, 'renamed')], first)
    expect(renamed.get('eneskirca/nodeterm#42')).not.toBe(first.get('eneskirca/nodeterm#42'))
  })

  it('exposes one shared empty list for unbound cards', () => {
    expect(NO_ISSUE_RUNS).toEqual([])
  })
})
