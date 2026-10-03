/**
 * Which node identities the renderer seeds into the core's agent-status mirror (see
 * `@shared/agent-identity-seed` for why). Pure, so the rules are testable without a store:
 *  - only nodes that exist in a project handed in (the caller passes this core's projects), so a
 *    deleted node's stale localStorage entry is never advertised;
 *  - only entries with a session id AND an agent id (the status store's, else the node's own);
 *  - only entries the core would accept (`parseIdentitySeedEntry` — the same rule, applied here so
 *    a hand-edited localStorage value never even crosses the boundary);
 *  - an identity already sent (by signature) is not resent; a CHANGED one is. The core only ever
 *    fills a node it has no session for, so a resend could not override anything — this only
 *    bounds the traffic;
 *  - chunked to IDENTITY_SEED_MAX per call, the most the core reads from one.
 */
import {
  IDENTITY_SEED_MAX,
  parseIdentitySeedEntry,
  type IdentitySeedEntry
} from '@shared/agent-identity-seed'
import type { ObservedClaudeAccount } from '@shared/types'

export interface SeedProject {
  nodes: ReadonlyArray<{ id: string; agentId?: string }>
}

export interface SeedStatus {
  sessionId?: string
  agentId?: string
  account?: ObservedClaudeAccount
}

export function identitySeedSignature(e: IdentitySeedEntry): string {
  return `${e.nodeId}\u0000${e.agentId}\u0000${e.sessionId}`
}

export function planIdentitySeed(
  projects: ReadonlyArray<SeedProject>,
  statuses: Readonly<Record<string, SeedStatus | undefined>>,
  sent: ReadonlySet<string>
): IdentitySeedEntry[][] {
  const out: IdentitySeedEntry[] = []
  const seen = new Set<string>()
  for (const p of projects) {
    for (const n of p.nodes ?? []) {
      if (!n || seen.has(n.id)) continue
      seen.add(n.id)
      const st = statuses[n.id]
      if (!st?.sessionId) continue
      const entry = parseIdentitySeedEntry({
        nodeId: n.id,
        agentId: st.agentId ?? n.agentId,
        sessionId: st.sessionId,
        ...(st.account ? { account: st.account } : {})
      })
      if (!entry || sent.has(identitySeedSignature(entry))) continue
      out.push(entry)
    }
  }
  const chunks: IdentitySeedEntry[][] = []
  for (let i = 0; i < out.length; i += IDENTITY_SEED_MAX) {
    chunks.push(out.slice(i, i + IDENTITY_SEED_MAX))
  }
  return chunks
}
