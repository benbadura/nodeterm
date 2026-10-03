/**
 * The boundary rule for `agent:seed-identity` — the renderer reporting, from its persisted
 * `agentStatus` store (localStorage `nodeterm.agentStatus`), which agent session each node was last
 * running, so the core's agent-status mirror can advertise it to the phone.
 *
 * Why it exists: the mirror learns a session id only from hook events, while the phone's chat view
 * locates a node's transcript ONLY by the session id it reads off that mirror. A node whose mirror
 * entry was dropped before #994 (identity used to expire with the state), or that has emitted no
 * hook event since the app started, is absent — and its phone chat said "No conversation yet" until
 * the next prompt, while this renderer had the id in localStorage the whole time.
 *
 * Every field is validated here, in `src/shared`, so both sides apply the same rule: the renderer
 * drops what the core would refuse, and the core re-validates, because the values come from
 * hand-editable localStorage and the ids are shell-reaching elsewhere (`--resume <sessionId>`,
 * `nt-<nodeId>` tmux names). Anything that does not match is dropped whole — never repaired.
 */
import { isSafeNodeId } from './safe-id'
import { SAFE_SESSION_ID } from './session-id'
import { BUILTIN_AGENT_IDS } from './agents/config'
import type { ObservedClaudeAccount } from './types'

/** At most this many entries are read from one call; the renderer chunks to it. */
export const IDENTITY_SEED_MAX = 256

export interface IdentitySeedEntry {
  nodeId: string
  /** Required: without it the phone cannot tell which agent's transcript reader to use. */
  agentId: string
  sessionId: string
  /** The observed Claude account label, carried like the mirror carries it (a LABEL only). */
  account?: ObservedClaudeAccount
}

/** `custom:<uuid>` — the node-id alphabet after the prefix. */
const CUSTOM_AGENT_ID = /^custom:[A-Za-z0-9._-]{1,128}$/
const CONFIG_DIR_MAX = 4096
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function isSeedSessionId(v: unknown): v is string {
  return typeof v === 'string' && SAFE_SESSION_ID.test(v)
}

export function isSeedAgentId(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    ((BUILTIN_AGENT_IDS as readonly string[]).includes(v) || CUSTOM_AGENT_ID.test(v))
  )
}

function parseAccount(v: unknown): ObservedClaudeAccount | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (
    typeof o.configDir !== 'string' ||
    !o.configDir ||
    o.configDir.length > CONFIG_DIR_MAX ||
    CONTROL_CHARS.test(o.configDir)
  )
    return null
  if (!(o.accountId === null || (typeof o.accountId === 'string' && isSafeNodeId(o.accountId))))
    return null
  if (typeof o.known !== 'boolean') return null
  return {
    configDir: o.configDir,
    accountId: o.accountId as string | null,
    known: o.known,
    ...(o.remote === true ? { remote: true } : {})
  }
}

/** One entry, or null when any field fails. */
export function parseIdentitySeedEntry(v: unknown): IdentitySeedEntry | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.nodeId !== 'string' || !isSafeNodeId(o.nodeId)) return null
  if (!isSeedSessionId(o.sessionId)) return null
  if (!isSeedAgentId(o.agentId)) return null
  let account: ObservedClaudeAccount | undefined
  if (o.account !== undefined) {
    const a = parseAccount(o.account)
    if (!a) return null
    account = a
  }
  return {
    nodeId: o.nodeId,
    agentId: o.agentId,
    sessionId: o.sessionId,
    ...(account ? { account } : {})
  }
}

/** The validated entries of one call: a non-array is nothing, at most IDENTITY_SEED_MAX are read,
 *  and an invalid entry is dropped without affecting its neighbours. */
export function parseIdentitySeed(input: unknown): IdentitySeedEntry[] {
  if (!Array.isArray(input)) return []
  const out: IdentitySeedEntry[] = []
  for (const v of input.slice(0, IDENTITY_SEED_MAX)) {
    const e = parseIdentitySeedEntry(v)
    if (e) out.push(e)
  }
  return out
}
