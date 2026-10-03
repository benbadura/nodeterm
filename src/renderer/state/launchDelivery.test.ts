import { describe, it, expect, beforeEach } from 'vitest'
import { useLaunchDelivery } from './launchDelivery'

/**
 * Issue #569 item 1 — the transient record behind the QUEUED badge's warning.
 *
 * The rule the whole store exists for: a launch that was abandoned must be VISIBLE. It used to be
 * a `console.warn` and nothing else, so a node that never started looked exactly like one still
 * waiting on a dependency — from the canvas and, more expensively, from an orchestrator driving
 * the canvas from outside.
 */
describe('useLaunchDelivery', () => {
  beforeEach(() => useLaunchDelivery.setState({ byId: {} }))

  it('reports nothing by default — absent is "waiting normally", not "fine"', () => {
    expect(useLaunchDelivery.getState().byId['term-1']).toBeUndefined()
  })

  it('markStalled is idempotent: the age does not restart on every re-render', () => {
    const s = useLaunchDelivery.getState()
    s.markStalled('term-1')
    const first = useLaunchDelivery.getState().byId['term-1']
    s.markStalled('term-1')
    expect(useLaunchDelivery.getState().byId['term-1']).toBe(first)
  })

  it('never downgrades a failure back to a stall', () => {
    const s = useLaunchDelivery.getState()
    s.markFailed('term-1', 5)
    s.markStalled('term-1')
    expect(useLaunchDelivery.getState().byId['term-1']?.kind).toBe('failed')
  })

  it('keeps the LARGER attempt count — the manual ▶ must not rewrite history', () => {
    const s = useLaunchDelivery.getState()
    s.markFailed('term-1', 5)
    s.markFailed('term-1', 1) // the ▶ button's single refusal
    const st = useLaunchDelivery.getState().byId['term-1']
    expect(st).toMatchObject({ kind: 'failed', attempts: 5 })
  })

  it('clear removes the entry, and clearing an unknown id changes nothing', () => {
    const s = useLaunchDelivery.getState()
    s.markFailed('term-1', 2)
    const before = useLaunchDelivery.getState().byId
    s.clear('term-nope')
    expect(useLaunchDelivery.getState().byId).toBe(before)
    s.clear('term-1')
    expect(useLaunchDelivery.getState().byId['term-1']).toBeUndefined()
  })
})

/**
 * #925 — a headless start is in flight: core owns the pane and is typing the launch into it, so
 * the node's ▶ must not type too. The orchestrator raises `starting` before it launches and
 * settles it with `clear` (started / not persistent) or `markFailed` (any other failure).
 */
describe('launchDelivery starting (#925)', () => {
  beforeEach(() => useLaunchDelivery.setState({ byId: {} }))
  it('markStarting records a starting state that markFailed / clear then replace', () => {
    useLaunchDelivery.getState().markStarting('n1')
    expect(useLaunchDelivery.getState().byId.n1?.kind).toBe('starting')
    useLaunchDelivery.getState().markFailed('n1', 1)
    expect(useLaunchDelivery.getState().byId.n1?.kind).toBe('failed')
    useLaunchDelivery.getState().markStarting('n1')
    useLaunchDelivery.getState().clear('n1')
    expect(useLaunchDelivery.getState().byId.n1).toBeUndefined()
  })
  it('markStalled never downgrades a start in flight', () => {
    useLaunchDelivery.getState().markStarting('n1')
    useLaunchDelivery.getState().markStalled('n1')
    expect(useLaunchDelivery.getState().byId.n1?.kind).toBe('starting')
  })
  it('a failure that follows a start reports the attempts it was given, not a stale count', () => {
    useLaunchDelivery.getState().markStarting('n1')
    useLaunchDelivery.getState().markFailed('n1', 1)
    expect(useLaunchDelivery.getState().byId.n1).toMatchObject({ kind: 'failed', attempts: 1 })
  })
})
