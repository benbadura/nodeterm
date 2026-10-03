// GitHub Copilot CLI's session journal as the ⌘M panel's structured messages.
//
// Where it lives: `<COPILOT_HOME>/session-state/<sessionId>/events.jsonl` (COPILOT_HOME defaults to
// `~/.copilot`). Measured on copilot 1.0.88 — the `Stop` hook's `transcript_path` names exactly that
// file, and a session launched with nodeterm's minted `--session-id=<uuid>` writes its directory
// under that uuid. The snap package runs with HOME remapped to `~/snap/copilot-cli/common`, so its
// journal is under THAT `.copilot`, which is the second root below.
//
// What it is: append-only JSONL, one session event per line, in the envelope
// `{type, data, [agentId], id, timestamp, parentId}`. The vocabulary is the CLI's own
// `schemas/session-events.schema.json` (152 event types in 1.0.88, most of them live-only
// `ephemeral` events that are never persisted). Compaction APPENDS `session.compaction_*` events
// rather than rewriting the file (measured), so a line's byte offset is a stable key and the file
// pages exactly like claude's: `parseCopilotChatWindow` is claude's `parseChatWindow` with this
// module's record parser.
//
// What the thread shows is copilot's OWN rendering, not a new opinion: the prompt as typed
// (`content`, never the model-facing `transformedContent`), assistant text and tool calls, each
// tool's result, and `Error:` / `Warning:` / `Info:` notices — the same set copilot's chat adapter
// (ACP) emits. A user message the CLI's own timeline hides (a skill injection, another agent's
// prompt) stays hidden, and a sub-agent's events never reach the main thread. The system prompt
// (`system.message`, ~44 KB per new conversation) and reasoning are never rendered.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatMessage, ChatPart } from '../shared/types'
import { BASH_COMMAND_TOOL, CHAT_TOOL_ARG_MAX } from '../shared/chat-command'
import { copilotHomeDir } from './agents/hooks/copilot'
import {
  lineTime,
  metaString,
  parseChatWindow,
  SESSION_ID_RE,
  summarizeResult,
  type ChatRecordsOut,
  type ChatWindowParse
} from './transcript-reader'

export const COPILOT_EVENTS_FILE = 'events.jsonl'

/** The session-state roots a copilot on THIS machine writes to: `$COPILOT_HOME` (or `~/.copilot`),
 *  then the snap package's remapped home. Both are keyed by the exact session id, so checking two
 *  can never adopt another session. */
export function copilotSessionStateRoots(): string[] {
  const roots = [
    path.join(copilotHomeDir(), 'session-state'),
    path.join(os.homedir(), 'snap', 'copilot-cli', 'common', '.copilot', 'session-state')
  ]
  return [...new Set(roots)]
}

/**
 * The journal for ONE session id, or undefined. Keyed strictly by the id — there is no cwd
 * fallback, so a node whose own session has no file is "not found", never someone else's newest
 * conversation. The id is validated before it touches a path (no `/`, no `.`: no traversal).
 */
export async function locateCopilotTranscript(sessionId: string | undefined): Promise<string | undefined> {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return undefined
  for (const root of copilotSessionStateRoots()) {
    const p = path.join(root, sessionId, COPILOT_EVENTS_FILE)
    try {
      if ((await fs.promises.stat(p)).isFile()) return p
    } catch {
      // not in this root
    }
  }
  return undefined
}

/** User-message sources copilot's own timeline shows (`j4` in its app bundle): none, `user`, and
 *  the `command-` / `schedule-` / `autopilot-` families. Anything else (`skill-*` injections,
 *  `agent-*` inter-agent prompts, a non-string) is hidden there, so it is hidden here. */
const SHOWN_SOURCE_PREFIXES = ['command-', 'schedule-', 'autopilot-']
function shownSource(source: unknown): boolean {
  if (source === undefined || source === null || source === 'user') return true
  return typeof source === 'string' && SHOWN_SOURCE_PREFIXES.some((p) => source.startsWith(p))
}

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** A sub-agent's event, by the CLI's own test (`_d`/`oa` in its app bundle): a non-empty `agentId`
 *  on the envelope or in `data`, or a `data.parentToolCallId`. Its turns belong to the `task` call
 *  whose result the main thread already shows. */
function isSubAgentEvent(o: Record<string, unknown>, data: Record<string, unknown>): boolean {
  return nonEmptyString(o.agentId) || nonEmptyString(data.agentId) || nonEmptyString(data.parentToolCallId)
}

/** The keys a tool call's `arguments` is summarized by, first string wins. claude's order for the
 *  keys the two share, then the ones only copilot's tools use (`url`, `query`, `skill`, …). */
const ARG_KEYS = ['command', 'path', 'file_path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill', 'question', 'intent']

function toolArg(args: unknown): string {
  // A `custom` tool (apply_patch's freeform grammar) carries its input as one string.
  if (typeof args === 'string') return args.slice(0, CHAT_TOOL_ARG_MAX)
  if (!isObject(args)) return ''
  for (const k of ARG_KEYS) {
    const v = args[k]
    if (nonEmptyString(v)) return v.slice(0, CHAT_TOOL_ARG_MAX)
  }
  return ''
}

type ToolPart = Extract<ChatPart, { kind: 'tool' }>

export interface CopilotRecordsOut extends ChatRecordsOut {
  /** Lines that could not be read or understood (not JSON, not an event, a handled event with the
   *  wrong shape). Diagnostic only — never on the wire. */
  skipped: number
}

/**
 * Journal lines → ordered messages. `paged` adds what only a paged read carries: each message's
 * `key` (its line's absolute byte offset), each tool part's `id`, the results whose call is in an
 * older window, and `model` (the newest main-thread `assistant.message`'s own `model`; absent when
 * that message states none — never carried forward). Copilot records no per-response effort, so
 * `effort` is never stated.
 */
export function parseCopilotRecords(
  records: Iterable<{ raw: string; offset: number }>,
  paged: boolean
): CopilotRecordsOut {
  const messages: ChatMessage[] = []
  const unmatched = new Map<string, string>()
  const toolById = new Map<string, ToolPart>()
  let model: string | undefined
  let skipped = 0
  for (const { raw, offset } of records) {
    if (!raw.trim()) continue
    let o: unknown
    try {
      o = JSON.parse(raw)
    } catch {
      skipped++
      continue
    }
    if (!isObject(o) || typeof o.type !== 'string' || !isObject(o.data)) {
      skipped++
      continue
    }
    const data = o.data
    if (isSubAgentEvent(o, data)) continue
    const at = lineTime(o.timestamp)
    const push = (m: ChatMessage): void => {
      const withAt = at === undefined ? m : { ...m, at }
      messages.push(paged ? { ...withAt, key: offset } : withAt)
    }
    const tool = (name: string, arg: string, callId: string): ToolPart => {
      const part: ToolPart = { kind: 'tool', name, arg }
      if (paged) part.id = callId
      toolById.set(callId, part)
      return part
    }
    switch (o.type) {
      case 'user.message': {
        if (typeof data.content !== 'string') {
          skipped++
          break
        }
        if (!data.content.trim() || !shownSource(data.source)) break
        push({ role: 'user', parts: [{ kind: 'text', text: data.content }] })
        break
      }
      case 'assistant.message': {
        const content = data.content ?? ''
        const requests = data.toolRequests ?? []
        if (typeof content !== 'string' || !Array.isArray(requests)) {
          skipped++
          break
        }
        if (paged) model = metaString(data.model)
        const parts: ChatPart[] = []
        if (content.trim()) parts.push({ kind: 'text', text: content })
        for (const r of requests) {
          if (!isObject(r) || !nonEmptyString(r.name) || !nonEmptyString(r.toolCallId)) {
            skipped++
            continue
          }
          parts.push(tool(r.name, toolArg(r.arguments), r.toolCallId))
        }
        if (parts.length) push({ role: 'assistant', parts })
        break
      }
      case 'tool.user_requested': {
        // A tool the USER ran — `!cmd` shell mode is a `bash` call. Rendered like claude's `!` line
        // (trimmed, capped) so the composer's optimistic `!cmd` bubble is confirmed by it.
        if (!nonEmptyString(data.toolName) || !nonEmptyString(data.toolCallId)) {
          skipped++
          break
        }
        const args = data.arguments
        const part =
          data.toolName === 'bash' && isObject(args) && typeof args.command === 'string'
            ? tool(BASH_COMMAND_TOOL, args.command.trim().slice(0, CHAT_TOOL_ARG_MAX), data.toolCallId)
            : tool(data.toolName, toolArg(args), data.toolCallId)
        push({ role: 'assistant', parts: [part] })
        break
      }
      case 'tool.execution_complete': {
        if (!nonEmptyString(data.toolCallId)) {
          skipped++
          break
        }
        const error = isObject(data.error) && typeof data.error.message === 'string' ? data.error.message : ''
        const content = isObject(data.result) && typeof data.result.content === 'string' ? data.result.content : ''
        const s = summarizeResult(data.success !== true && error ? `Error: ${error}` : content)
        if (!s) break
        const part = toolById.get(data.toolCallId)
        if (part) part.result = s
        // Its call is in an OLDER window (the call is always written before its completion).
        else if (paged) unmatched.set(data.toolCallId, s)
        break
      }
      case 'session.error':
      case 'session.warning':
      case 'session.info': {
        if (typeof data.message !== 'string') {
          skipped++
          break
        }
        const label = o.type === 'session.error' ? 'Error' : o.type === 'session.warning' ? 'Warning' : 'Info'
        push({ role: 'assistant', parts: [{ kind: 'text', text: `${label}: ${data.message}` }] })
        break
      }
      default:
        // Bookkeeping (session.start/resume/shutdown, turn boundaries, permissions, compaction,
        // model changes, hooks, notifications, binary assets, …) and any type a newer CLI adds:
        // understood as "nothing to show", not counted.
        break
    }
  }
  const out: CopilotRecordsOut = { messages, unmatched, skipped }
  if (model !== undefined) out.model = model
  return out
}

/** One byte window of a copilot journal — claude's window rules, copilot's records. */
export function parseCopilotChatWindow(buf: Buffer, bufStart: number): ChatWindowParse {
  return parseChatWindow(buf, bufStart, parseCopilotRecords)
}

/** The legacy (unpaged) read: the whole capped tail, no keys and no tool ids. */
export function chatMessagesFromCopilot(text: string): ChatMessage[] {
  return parseCopilotRecords(
    text.split('\n').map((raw) => ({ raw, offset: 0 })),
    false
  ).messages
}
