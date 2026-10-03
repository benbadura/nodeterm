// grok's `chat_history.jsonl` as the ⌘M panel's structured messages.
//
// Separate from `transcript-reader.ts`'s `parseChatMessages`, which parses CLAUDE's shape
// (`o.message.content`, `tool_use`/`tool_result` blocks) and would return an empty thread for every
// grok line. Sharing that function was never an option; sharing the SHAPE knowledge is, so this
// builds on `grokParse` rather than re-deriving grok's line vocabulary and drifting from it.
//
// MEASURED shapes (grok 1.0.13 — the real-derived `__fixtures__/grok/chat_history.jsonl`, plus the
// record vocabulary compiled into the shipped binary's `xai-chat-state` crate). One record per line,
// discriminated by `type`, with NO timestamp on any of them:
//   system            {content: string}                         — the system prompt
//   user              {content: [{type:'text', text}], prompt_index?, synthetic_reason?, images?,
//                      cwd_generation?, prior_turn_interrupt?}
//   assistant         {content: string, tool_calls?: [{id, name, arguments: <JSON string>}],
//                      model_id, model_fingerprint, reasoning_effort}
//   tool_result       {tool_call_id, content: string}
//   backend_tool_call {kind: {tool_type: 'web_search', action: {type, query, sources}}, id, status}
//   reasoning         {id, summary: [...], encrypted_content, status}
// `reasoning_effort` ∈ minimal | low | medium | high | xhigh | max (the binary's enum).
//
// The file is NOT an append-only log: grok persists it through `chat_history.jsonl.sync.tmp` +
// rename, and `/compact`, `/rewind` and its own history repair (duplicate / dangling tool results)
// rewrite the history in place. A byte offset is therefore not a stable identity for a line, which
// is why this reader does not page (see `readChatTranscript`).
import type { ChatMessage, ChatPart } from '../shared/types'
import { CHAT_TOOL_ARG_MAX } from '../shared/chat-command'
import { grokParse } from './context-link-render'
import { metaString, summarizeResult } from './transcript-reader'

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : ((c as { text?: string })?.text ?? '')))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * The argument keys that NAME what a grok tool call acts on, in priority order. `target_file` and
 * `target_directory` are measured (`read_file` / `list_dir`); the rest are the same salient keys
 * claude's `toolArg` reads. A key a tool does not have is simply not picked, so an unmeasured name
 * here can never produce a wrong value — only a value that really is in the call.
 */
const SALIENT_ARG_KEYS = [
  'command',
  'target_file',
  'file_path',
  'target_directory',
  'path',
  'pattern',
  'query',
  'url',
  'description',
  'prompt'
] as const

/** A tool call's `arg`: its salient string argument, else the raw arguments text — capped at
 *  `CHAT_TOOL_ARG_MAX` UTF-16 units either way. */
function toolArg(args: unknown): string {
  const raw = typeof args === 'string' ? args : args && typeof args === 'object' ? JSON.stringify(args) : ''
  let o: unknown = args
  if (typeof args === 'string') {
    try {
      o = JSON.parse(args)
    } catch {
      o = undefined
    }
  }
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const k of SALIENT_ARG_KEYS) {
      const v = (o as Record<string, unknown>)[k]
      if (typeof v === 'string' && v) return v.slice(0, CHAT_TOOL_ARG_MAX)
    }
  }
  return String(raw).slice(0, CHAT_TOOL_ARG_MAX)
}

/** What a grok conversation reads as. `model` / `effort` are keys only when stated. */
export interface GrokChatParse {
  messages: ChatMessage[]
  /** `model_id` of the NEWEST assistant record (one record answers both fields). */
  model?: string
  /** That same record's `reasoning_effort` — never carried forward from an older record. */
  effort?: string
  /** Lines that are not a record this reader knows: malformed JSON, a non-object, an unknown
   *  `type`. A record deliberately hidden (`reasoning`, an empty text) is NOT counted. */
  skipped: number
}

const KNOWN_TYPES = new Set(['system', 'user', 'assistant', 'tool_result', 'backend_tool_call', 'reasoning'])

/**
 * Ordered bubbles for a grok conversation.
 *
 * Two rules carried over from `linesFromGrok`, because breaking either one here would be a
 * behaviour difference between two views of the same file:
 *
 *  - A `user` line with `synthetic_reason` was injected by the harness, not typed by a person. It is
 *    rendered as an ASSISTANT-side note prefixed with its reason rather than as a user bubble — the
 *    panel has only two roles, and the one thing that must never happen is tooling text appearing in
 *    the shape of something the human said.
 *  - `reasoning` is skipped. Its `encrypted_content` is unreadable, and its plaintext `summary` is
 *    omitted by the same product decision documented in `context-link-render.ts`.
 */
export function parseGrokChat(buf: string): GrokChatParse {
  const messages: ChatMessage[] = []
  const toolById = new Map<string, Extract<ChatPart, { kind: 'tool' }>>()
  const parsed = grokParse(buf)
  let skipped = parsed.skipped
  let model: string | undefined
  let effort: string | undefined
  for (const o of parsed.lines) {
    // `grokParse` admits any JSON value that is an object — an array or a record of a type this
    // reader has never seen is a line it could not map, and says so in the count.
    if (Array.isArray(o) || !KNOWN_TYPES.has(o.type as string)) {
      skipped++
      continue
    }
    switch (o.type) {
      case 'user': {
        const t = textOf(o.content)
        if (!t) break
        const injected = typeof o.synthetic_reason === 'string' ? o.synthetic_reason.trim() : ''
        if (injected) {
          messages.push({ role: 'assistant', parts: [{ kind: 'text', text: `[${injected}] ${t}` }] })
        } else {
          messages.push({ role: 'user', parts: [{ kind: 'text', text: t }] })
        }
        break
      }
      case 'system': {
        const t = textOf(o.content)
        if (t) messages.push({ role: 'assistant', parts: [{ kind: 'text', text: `[system] ${t}` }] })
        break
      }
      case 'assistant': {
        // A snapshot of ONE record: the newest assistant record answers both fields, and a field it
        // does not state is absent — the same rule claude's paged reader follows.
        const rec = o as { model_id?: unknown; reasoning_effort?: unknown }
        model = metaString(rec.model_id)
        effort = metaString(rec.reasoning_effort)
        const parts: ChatPart[] = []
        const t = textOf(o.content)
        if (t) parts.push({ kind: 'text', text: t })
        for (const c of Array.isArray(o.tool_calls) ? o.tool_calls : []) {
          if (!c || typeof c !== 'object' || Array.isArray(c)) continue
          const part: Extract<ChatPart, { kind: 'tool' }> = {
            kind: 'tool',
            name: typeof c.name === 'string' && c.name ? c.name : 'tool',
            arg: toolArg(c.arguments)
          }
          parts.push(part)
          if (typeof c.id === 'string' && c.id) toolById.set(c.id, part)
        }
        if (parts.length) messages.push({ role: 'assistant', parts })
        break
      }
      case 'tool_result': {
        // Attached to the call it answers, never rendered as its own bubble — same as claude's
        // reader. An orphan result (no matching id) is dropped rather than shown speaker-less.
        const tool = typeof o.tool_call_id === 'string' ? toolById.get(o.tool_call_id) : undefined
        if (!tool) break
        const s = summarizeResult(textOf(o.content))
        if (s) tool.result = s
        break
      }
      case 'backend_tool_call': {
        const kind = o.kind && typeof o.kind === 'object' && !Array.isArray(o.kind) ? o.kind : undefined
        const q = kind?.action?.query
        messages.push({
          role: 'assistant',
          parts: [
            {
              kind: 'tool',
              name: typeof kind?.tool_type === 'string' && kind.tool_type ? kind.tool_type : 'backend_tool',
              arg: typeof q === 'string' ? q.slice(0, CHAT_TOOL_ARG_MAX) : ''
            }
          ]
        })
        break
      }
      default:
        // `reasoning`: known, deliberately hidden (see above).
        break
    }
  }
  const out: GrokChatParse = { messages, skipped }
  if (model !== undefined) out.model = model
  if (effort !== undefined) out.effort = effort
  return out
}

/** The messages alone — the legacy (unpaged) read and every caller that predates `parseGrokChat`. */
export function chatMessagesFromGrok(buf: string): ChatMessage[] {
  return parseGrokChat(buf).messages
}
