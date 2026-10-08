import { SAFE_SESSION_ID } from '@shared/session-id'

/**
 * Which session a node's transcript READERS (the ⌘M chat view, the context meter's mount-time
 * rehydration) look at — the one rule the canvas node and the kanban card modal share.
 *
 * Two sources, in this order (the same order cold restore uses, `TerminalNode`'s `priorId`):
 *  1. the LIVE id a hook reported (`agentStatus.sessionId`) — it follows `/clear`, `/resume` and
 *     `--fork-session` moving the CLI to another session, so it is the only one that can be current;
 *  2. the id nodeterm launched the node with and persisted (`data.agentSessionId` — minted with
 *     `--session-id`, or the id "Open recent" resumed).
 * Without (2) a node whose hooks never reach this app — an SSH session pinned to a dead hook tunnel
 * for its whole life, a session started where no hook endpoint was advertised — could NEVER open the
 * chat view or show a meter: it fell back to the markdown-of-output view while its transcript sat on
 * disk under an id the node itself had on record.
 *
 * The fallback is honest about what it is (`fallback: true`), because the persisted id can be STALE:
 * a `/clear` or `/resume` inside the CLI moves it to another session while the node's record stays.
 * Callers must therefore:
 *  - say so in the view (the chat panel prints one quiet line);
 *  - never use it for anything that WRITES or answers (plan/question answer cards stay bound to the
 *    live `held` ticket, which only a hook can deliver);
 *  - read it STRICTLY by id — `cwd` comes back `undefined` here, because claude's resolver falls back
 *    to the NEWEST transcript in the cwd when the id misses (a cleaned-up transcript, an id that
 *    never ran), and under a fallback id that would put a stranger's conversation on screen under
 *    "the conversation this node was started with". A remote node's host locator globs by id without
 *    a cwd, so the remote leg is unaffected.
 *
 * The persisted id belongs to the node's CREATED agent (`createdAgentId(data)`), which is exactly the
 * agent both mount sites pick the reader by — so the fallback can never hand one agent's id to
 * another agent's resolver. Keep it that way: do not feed it to a reader chosen by an observed agent.
 *
 * `persisted` is hand-editable project.json data, so it is re-validated against `SAFE_SESSION_ID`
 * rather than trusted by type; an invalid one is simply no fallback. The live id is passed through
 * as before (its own validation lives where hook events are ingested).
 */
export interface TranscriptSession {
  /** The id to read by; `undefined` = no session known (the view stays on the output markdown). */
  sessionId: string | undefined
  /** True when `sessionId` is the node's persisted launch id, not one a hook confirmed. */
  fallback: boolean
  /** The cwd to hand the reader: the node's own for a hook-confirmed id, `undefined` for a fallback. */
  cwd: string | undefined
}

export function transcriptSessionFor(input: {
  live: string | null | undefined
  persisted: unknown
  cwd: string | undefined
}): TranscriptSession {
  if (input.live) return { sessionId: input.live, fallback: false, cwd: input.cwd }
  const p = typeof input.persisted === 'string' ? input.persisted.trim() : ''
  if (p && SAFE_SESSION_ID.test(p)) return { sessionId: p, fallback: true, cwd: transcriptReadCwd(input.cwd, true) }
  return { sessionId: undefined, fallback: false, cwd: input.cwd }
}

/** The cwd a transcript READ may carry: none for a fallback id (see above). The chat panel asks
 *  this itself because it also needs the node's real cwd for the composer's `@` file list. */
export function transcriptReadCwd(cwd: string | undefined, fallback: boolean): string | undefined {
  return fallback ? undefined : cwd
}

/** The chat panel's one quiet line while it reads the fallback id. */
export const FALLBACK_SESSION_NOTE =
  'Showing the conversation this node was started with — it may be older if the session changed in the terminal.'
