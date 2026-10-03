import { describe, it, expect } from 'vitest'
import { planIdentitySeed, identitySeedSignature } from './identitySeed'
import { IDENTITY_SEED_MAX } from '@shared/agent-identity-seed'

const project = (id: string, nodeIds: string[]) => ({
  id,
  nodes: nodeIds.map((n) => ({ id: n, kind: 'terminal' as const }))
})

describe('planIdentitySeed', () => {
  it('seeds only nodes that exist in a project, with a known sessionId', () => {
    const plan = planIdentitySeed(
      [project('p1', ['a', 'b', 'c'])],
      {
        a: { sessionId: 'sa', agentId: 'claude' },
        b: { agentId: 'claude' }, // no session id: nothing the phone could use
        deleted: { sessionId: 'sd', agentId: 'claude' } // stale localStorage entry
      },
      new Set()
    )
    expect(plan).toEqual([[{ nodeId: 'a', agentId: 'claude', sessionId: 'sa' }]])
  })

  it('falls back to the node\'s own agentId and carries the observed account', () => {
    const account = { configDir: '/h/.claude', accountId: null, known: true }
    const plan = planIdentitySeed(
      [{ nodes: [{ id: 'a', agentId: 'codex' }] }],
      { a: { sessionId: 'sa', account } },
      new Set()
    )
    expect(plan).toEqual([[{ nodeId: 'a', agentId: 'codex', sessionId: 'sa', account }]])
  })

  it('does not resend an identity it already sent, but sends a changed one', () => {
    const statuses = { a: { sessionId: 'sa', agentId: 'claude' } }
    const sent = new Set([identitySeedSignature({ nodeId: 'a', agentId: 'claude', sessionId: 'sa' })])
    expect(planIdentitySeed([project('p', ['a'])], statuses, sent)).toEqual([])
    expect(
      planIdentitySeed([project('p', ['a'])], { a: { sessionId: 'sb', agentId: 'claude' } }, sent)
    ).toHaveLength(1)
  })

  it('drops entries the core would refuse, so a hand-edited localStorage cannot ride along', () => {
    expect(
      planIdentitySeed([project('p', ['a'])], { a: { sessionId: '$(x)', agentId: 'claude' } }, new Set())
    ).toEqual([])
  })

  it('chunks to the per-call cap', () => {
    const ids = Array.from({ length: IDENTITY_SEED_MAX + 3 }, (_, i) => `n${i}`)
    const statuses = Object.fromEntries(ids.map((id) => [id, { sessionId: `s-${id}`, agentId: 'claude' }]))
    const plan = planIdentitySeed([project('p', ids)], statuses, new Set())
    expect(plan.map((c) => c.length)).toEqual([IDENTITY_SEED_MAX, 3])
  })
})
