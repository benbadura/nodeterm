import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  USER_CLOSED_SESSION_EVENT,
  announceUserClosedSession,
  isSessionNode,
  lastSessionCloseCopy,
  shouldOfferProjectClose
} from './lastSessionClose'

const project = { remote: undefined, closed: false }
const term = (id: string) => ({ id, type: 'terminal' })

describe('isSessionNode (issue #848)', () => {
  it('counts terminal-kind nodes — plain shells and agents alike — and nothing else', () => {
    expect(isSessionNode({ type: 'terminal' })).toBe(true)
    // An untyped node is a terminal, the same `?? 'terminal'` default terminalNodeIds applies.
    expect(isSessionNode({})).toBe(true)
    for (const type of ['sticky', 'markdown', 'browser', 'editor', 'files', 'group', 'subagent']) {
      expect(isSessionNode({ type }), type).toBe(false)
    }
  })
})

describe('shouldOfferProjectClose (issue #848)', () => {
  it('offers when the × closed the only session node on the canvas', () => {
    expect(
      shouldOfferProjectClose({ enabled: true, closedNodeId: 'a', nodes: [term('a')], project })
    ).toBe(true)
  })

  it('is opt-in: never offers while the setting is off', () => {
    expect(
      shouldOfferProjectClose({ enabled: false, closedNodeId: 'a', nodes: [term('a')], project })
    ).toBe(false)
  })

  it('does not offer while another session node remains — hibernated or parked ones included', () => {
    // Extra fields are what a real canvas node carries; the decision must ignore them.
    const hibernated = { id: 'b', type: 'terminal', data: { hibernated: true } }
    // A hibernated agent is still a terminal node on the canvas, so it still counts (the issue's
    // own reason for tying the offer to the click rather than to "no process is running").
    expect(
      shouldOfferProjectClose({
        enabled: true,
        closedNodeId: 'a',
        nodes: [term('a'), hibernated],
        project
      })
    ).toBe(false)
  })

  it('still offers when only non-session nodes (notes, markdown, a browser) remain', () => {
    expect(
      shouldOfferProjectClose({
        enabled: true,
        closedNodeId: 'a',
        nodes: [term('a'), { id: 's', type: 'sticky' }, { id: 'w', type: 'browser' }, { id: 'm', type: 'markdown' }],
        project
      })
    ).toBe(true)
  })

  it('does not offer for a node that is not (or no longer) on this canvas', () => {
    // A repeated click on a node already gone, or a × on a node rendered outside the active
    // canvas, must not ask — the click has to be the one that removed the last session HERE.
    expect(
      shouldOfferProjectClose({ enabled: true, closedNodeId: 'gone', nodes: [], project })
    ).toBe(false)
    expect(
      shouldOfferProjectClose({ enabled: true, closedNodeId: 'x', nodes: [{ id: 'x', type: 'sticky' }], project })
    ).toBe(false)
  })

  it('does not offer without an open, local project', () => {
    const base = { enabled: true, closedNodeId: 'a', nodes: [term('a')] }
    expect(shouldOfferProjectClose({ ...base, project: undefined })).toBe(false)
    expect(shouldOfferProjectClose({ ...base, project: { closed: true } })).toBe(false)
    // A relay tab is a view of another machine's project: "close" there only removes the view,
    // which a reconnect brings straight back — not what this offer promises.
    expect(
      shouldOfferProjectClose({ ...base, project: { remote: { hostId: 'h' } as never, closed: false } })
    ).toBe(false)
  })
})

describe('lastSessionCloseCopy', () => {
  it('names the project and says where to reopen it', () => {
    const copy = lastSessionCloseCopy('Demo')
    expect(copy.message).toContain('“Demo”')
    expect(copy.message).toContain('Recently closed')
    expect(copy.confirmLabel).toBe('Close project')
    expect(copy.cancelLabel).toBe('Keep open')
  })
})

describe('announceUserClosedSession', () => {
  afterEach(() => vi.restoreAllMocks())

  it('dispatches the node id on the window event Canvas listens to', () => {
    const seen: unknown[] = []
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    target.addEventListener(USER_CLOSED_SESSION_EVENT, (e) => seen.push((e as CustomEvent).detail))
    announceUserClosedSession('n1')
    expect(seen).toEqual([{ nodeId: 'n1' }])
    vi.unstubAllGlobals()
  })
})
