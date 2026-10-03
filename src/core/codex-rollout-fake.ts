// SYNTHETIC codex rollout records, in the shapes measured on real rollouts (codex-cli 0.114.0,
// 0.145.0, 0.146.0, 0.151.0 and 0.156.1 — 67 files, 2026-09-28). Test support only: the ⌘M codex
// reader's unit tests and its golden fixtures (src/shared/chat-fixtures/codex/) are built from these,
// never from a slice of a real rollout — real ones carry customer data.
//
// Every builder returns ONE rollout line as an object; `rolloutLine` serializes it with the
// envelope codex writes (`timestamp`, `type`, `payload`, and `ordinal` on the paginated format).
// Field order inside each payload follows the measured records, so a fixture reads like the real
// thing. Nothing here decides behaviour.

export type CodexRec = { type: string; payload: Record<string, unknown>; metadata?: Record<string, unknown> }

export const CODEX_SID = '01a0c9f4-2b7e-7c31-9d52-5e8a1f3b6c20'
const T0 = Date.parse('2026-09-24T09:00:00.000Z')

/** One JSONL line. `index` fixes the timestamp (T0 + index seconds); `ordinal` is the paginated
 *  format's per-line counter — absent on the legacy format. */
export function rolloutLine(r: CodexRec, index: number, ordinal?: number): string {
  const timestamp = new Date(T0 + index * 1000).toISOString()
  const env: Record<string, unknown> = { timestamp, type: r.type, payload: r.payload }
  if (r.metadata) env.metadata = r.metadata
  if (ordinal !== undefined) env.ordinal = ordinal
  return JSON.stringify(env) + '\n'
}

/** A whole rollout: legacy lines carry no `ordinal`, paginated ones number every line from 0. */
export function rollout(recs: CodexRec[], format: 'legacy' | 'paginated' = 'paginated'): string {
  return recs.map((r, i) => rolloutLine(r, i, format === 'paginated' ? i : undefined)).join('')
}

// ── Session / turn metadata (never rendered) ─────────────────────────────────────────────────────
export const sessionMeta = (format: 'legacy' | 'paginated', id = CODEX_SID): CodexRec => ({
  type: 'session_meta',
  payload: {
    id,
    timestamp: '2026-09-24T09:00:00.000Z',
    cwd: '/srv/demo',
    originator: 'codex_cli_rs',
    cli_version: format === 'legacy' ? '0.145.0' : '0.156.1',
    source: 'cli',
    model_provider: 'openai',
    base_instructions: { text: 'You are a coding agent.' },
    history_mode: format,
    session_id: id,
    thread_source: 'user'
  }
})
export const turnContext = (model: unknown, effort?: unknown): CodexRec => ({
  type: 'turn_context',
  payload: {
    turn_id: 'turn-synthetic',
    cwd: '/srv/demo',
    approval_policy: 'on-request',
    sandbox_policy: { type: 'workspace-write' },
    model,
    ...(effort === undefined ? {} : { effort }),
    summary: 'auto',
    collaboration_mode: {
      mode: 'default',
      settings: { model, reasoning_effort: effort ?? null, developer_instructions: null }
    }
  }
})
export const taskStarted = (): CodexRec => ({
  type: 'event_msg',
  payload: { type: 'task_started', turn_id: 'turn-synthetic', started_at: 1790000000, model_context_window: 258400, collaboration_mode_kind: 'default' }
})
export const taskComplete = (last: string | null = 'Done.'): CodexRec => ({
  type: 'event_msg',
  payload: { type: 'task_complete', turn_id: 'turn-synthetic', last_agent_message: last, started_at: 1790000000, completed_at: 1790000030, duration_ms: 30000 }
})
export const taskFailed = (message: unknown, info = 'usage_limit_exceeded'): CodexRec => ({
  type: 'event_msg',
  payload: {
    type: 'task_complete',
    turn_id: 'turn-synthetic',
    last_agent_message: null,
    started_at: 1790000000,
    completed_at: 1790000001,
    duration_ms: 1000,
    error: { codex_error_info: info, message }
  }
})
export const turnAborted = (reason: unknown = 'interrupted'): CodexRec => ({
  type: 'event_msg',
  payload: { type: 'turn_aborted', turn_id: 'turn-synthetic', reason, started_at: 1790000000, completed_at: 1790000002, duration_ms: 2000 }
})
export const tokenCount = (): CodexRec => ({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 20000, cached_input_tokens: 18000, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 20300 },
      last_token_usage: { input_tokens: 12000, cached_input_tokens: 11000, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 12200 },
      model_context_window: 258400
    },
    rate_limits: { primary: null, secondary: null }
  }
})
export const tokenUsageRecord = (): CodexRec => ({
  type: 'token_usage_record',
  payload: { response_id: 'resp_synthetic', session_id: CODEX_SID, thread_id: CODEX_SID, turn_id: 'turn-synthetic', root_turn_id: 'turn-synthetic', usage: {}, turn_token_usage: {}, thread_token_usage: {} }
})
export const worldState = (): CodexRec => ({ type: 'world_state', payload: { full: true, state: {} } })
export const threadSettingsApplied = (): CodexRec => ({
  type: 'event_msg',
  payload: { type: 'thread_settings_applied', thread_id: CODEX_SID, thread_settings: {} }
})
export const interAgentMeta = (): CodexRec => ({ type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } })
export const compacted = (): CodexRec => ({
  type: 'compacted',
  payload: {
    message: '',
    replacement_history: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'An earlier prompt, as the model sees it.' }] },
      { type: 'compaction', encrypted_content: 'gAAAAsynthetic' }
    ],
    replacement_history_metadata: [],
    window_id: 'w2',
    window_number: 2,
    previous_window_id: 'w1',
    first_window_id: 'w1',
    compaction_response_id: 'resp_compact',
    latest_token_usage_record: null
  }
})

// ── What the model sees (response_item) ──────────────────────────────────────────────────────────
const passthrough = { internal_chat_message_metadata_passthrough: {} }
/** A model-side `message`: `role` user / developer carries injected context; assistant carries
 *  `output_text` and a `phase` (commentary | final_answer). */
export const riMessage = (role: string, texts: unknown[], phase?: string): CodexRec => ({
  type: 'response_item',
  payload: {
    type: 'message',
    id: 'msg_synthetic',
    role,
    content: texts.map((t) =>
      typeof t === 'string' ? { type: role === 'assistant' ? 'output_text' : 'input_text', text: t } : t
    ),
    ...(phase ? { phase } : {}),
    ...passthrough
  }
})
export const assistantText = (text: string, phase = 'final_answer'): CodexRec => riMessage('assistant', [text], phase)
export const reasoning = (): CodexRec => ({
  type: 'response_item',
  payload: { type: 'reasoning', id: 'rs_synthetic', summary: [], encrypted_content: 'gAAAAsyntheticreasoning', ...passthrough }
})
export const functionCall = (callId: string, name: string, args: unknown, namespace?: string): CodexRec => ({
  type: 'response_item',
  payload: {
    type: 'function_call',
    id: 'fc_synthetic',
    name,
    ...(namespace ? { namespace } : {}),
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
    call_id: callId,
    ...passthrough
  }
})
export const functionOutput = (callId: string, output: unknown): CodexRec => ({
  type: 'response_item',
  payload: { type: 'function_call_output', id: 'fco_synthetic', call_id: callId, output, ...passthrough },
  metadata: { client_authored: false, fallback_token_limit_override: null }
})
export const customToolCall = (callId: string, name: string, input: unknown): CodexRec => ({
  type: 'response_item',
  payload: { type: 'custom_tool_call', id: 'ctc_synthetic', status: 'completed', call_id: callId, name, input, ...passthrough }
})
export const customToolOutput = (callId: string, output: unknown): CodexRec => ({
  type: 'response_item',
  payload: { type: 'custom_tool_call_output', id: 'ctco_synthetic', call_id: callId, output, ...passthrough },
  metadata: { client_authored: false, fallback_token_limit_override: null }
})
export const toolSearchCall = (callId: string, query: string): CodexRec => ({
  type: 'response_item',
  payload: { type: 'tool_search_call', id: 'ts_synthetic', call_id: callId, status: 'completed', execution: 'client', arguments: { query }, ...passthrough }
})
export const toolSearchOutput = (callId: string): CodexRec => ({
  type: 'response_item',
  payload: { type: 'tool_search_output', call_id: callId, status: 'completed', execution: 'client', tools: [{ name: 'demo_tool' }], ...passthrough }
})
export const riAgentMessage = (author: string, recipient: string, text: string): CodexRec => ({
  type: 'response_item',
  payload: {
    type: 'agent_message',
    id: 'am_synthetic',
    author,
    recipient,
    content: [
      { type: 'input_text', text },
      { type: 'encrypted_content', encrypted_content: 'gAAAAsyntheticagent' }
    ],
    ...passthrough
  }
})

// ── What the UI saw (event_msg) ──────────────────────────────────────────────────────────────────
/** LEGACY format (≤ 0.146): the prompt exactly as the user typed it. */
export const userMessageEvent = (message: unknown): CodexRec => ({
  type: 'event_msg',
  payload: { type: 'user_message', message, images: [], local_images: [], text_elements: [] }
})
/** LEGACY format: the UI's copy of an assistant message (duplicates the response_item). */
export const agentMessageEvent = (message: string, phase = 'final_answer'): CodexRec => ({
  type: 'event_msg',
  payload: { type: 'agent_message', message, phase, memory_citation: null }
})
const itemCompleted = (item: Record<string, unknown>): CodexRec => ({
  type: 'event_msg',
  payload: { type: 'item_completed', thread_id: CODEX_SID, turn_id: 'turn-synthetic', item, started_at_ms: 1790000000000, completed_at_ms: 1790000000100 }
})
/** PAGINATED format (≥ 0.151): the prompt exactly as the user typed it. `content` items are
 *  `{type:'text'}` and, for a pasted image, `{type:'local_image'}`. */
export const userMessageItem = (content: unknown[]): CodexRec =>
  itemCompleted({
    type: 'UserMessage',
    id: 'item_user',
    client_id: 'client_synthetic',
    content: content.map((c) => (typeof c === 'string' ? { type: 'text', text: c, text_elements: [] } : c))
  })
/** PAGINATED format: the UI's copy of an assistant message (duplicates the response_item). */
export const agentMessageItem = (text: string, phase = 'final_answer'): CodexRec =>
  itemCompleted({ type: 'AgentMessage', id: 'item_agent', phase, content: [{ type: 'Text', text }] })
export const commandExecutionItem = (): CodexRec =>
  itemCompleted({
    type: 'CommandExecution',
    id: 'item_cmd',
    command: ['/bin/bash', '-lc', 'ls'],
    cwd: '/srv/demo',
    process_id: '1',
    source: 'unified_exec_startup',
    status: 'completed',
    parsed_cmd: [{ type: 'list_files', cmd: 'ls' }],
    aggregated_output: 'a.txt\n',
    formatted_output: 'a.txt',
    stdout: 'a.txt\n',
    stderr: '',
    exit_code: 0,
    duration: { secs: 0, nanos: 1000000 }
  })
export const fileChangeItem = (): CodexRec =>
  itemCompleted({ type: 'FileChange', id: 'item_fc', status: 'completed', stdout: '', stderr: '', changes: { '/srv/demo/a.txt': { type: 'add', content: 'x\n' } } })
export const reasoningItem = (): CodexRec =>
  itemCompleted({ type: 'Reasoning', id: 'item_rs', summary_text: [], raw_content: [] })
export const extensionItem = (): CodexRec =>
  itemCompleted({ type: 'Extension', id: 'item_ext', kind: 'clock.sleep', durationMs: 1000 })
export const contextCompactionItem = (): CodexRec => itemCompleted({ type: 'ContextCompaction', id: 'item_cc' })
export const subAgentActivityItem = (): CodexRec =>
  itemCompleted({ type: 'SubAgentActivity', id: 'item_sa', kind: 'completed', agent_path: '/root/worker_1', agent_thread_id: 'thread-child' })

/** The model-side twin of a typed prompt, plus the context codex injects before it. The typed text
 *  is ALSO written here (as a role:user input_text) — the reader must not show it twice. */
export const injectedContext = (): CodexRec[] => [
  riMessage('developer', ['<permissions instructions>\nApprovals are on-request.\n</permissions instructions>']),
  riMessage('user', ['# AGENTS.md instructions for /srv/demo\n\n<INSTRUCTIONS>\nBe terse.\n</INSTRUCTIONS>']),
  riMessage('user', ['<environment_context>\n  <cwd>/srv/demo</cwd>\n</environment_context>'])
]
