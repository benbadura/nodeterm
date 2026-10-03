# Codex chat golden fixtures

The codex half of the mobile chat view's parser port. Same contract as the claude fixtures in the
parent directory (read `../README.md` first): the TypeScript reader (`src/core/codex-chat.ts`) is the
reference, `nodeterm-ios` keeps a byte-identical copy of this directory, and its Swift port must
reproduce every `expected/*.pages.json` from the same `inputs/*.jsonl`.

Every input is **synthetic**, built by `src/core/codex-chat-fixtures.test.ts` from
`src/core/codex-rollout-fake.ts`, in the record shapes measured on real rollouts (codex-cli 0.114.0,
0.145.0, 0.146.0, 0.151.0 and 0.156.1; 67 files, 2026-09-28). None is a slice of a real rollout.

## Regenerate

```sh
UPDATE_CHAT_FIXTURES=1 npx vitest run src/core/codex-chat-fixtures.test.ts
```

Without the variable the test requires every file to equal what the code produces, and the
directory to hold exactly `README.md`, `inputs/` and `expected/` with the generated set.

## Layout and pager

`inputs/<name>.jsonl` is a synthetic rollout; `expected/<name>.pages.json` is the page sequence the
phone's pager produces from it. The pager, the step format (`before`, `maxBytes`, `grownMaxBytes`,
`start`, `parse`) and the window contract (one lookbehind byte, the dropped partial first line,
`olderCursor`, `noCompleteLine` and the ×4 growth up to 5 MB) are **identical to claude's** — only the
record parser differs. A port can therefore reuse its claude window splitter and swap the parser.
Serialization is `JSON.stringify(value, null, 2) + "\n"`; optional keys are absent, never `null`.

## The record rules (the Swift port must replicate these exactly)

A rollout line is `{timestamp, type, payload}`; the paginated format (codex ≥ 0.151) adds a numeric
`ordinal`, which the parser ignores. For each non-blank line:

1. Not JSON, not a plain object, or `payload` not a plain object → skipped.
2. `at` = `Date.parse(timestamp)` when `timestamp` is a non-empty string that parses; else absent.
   Every pushed message carries its OWN line's `at` and, on a paged read, `key` = the line's
   absolute byte offset.
3. **User text comes from the UI stream only**:
   - `type:"event_msg"`, `payload.type:"user_message"` (legacy ≤ 0.146): `payload.message` when it
     is a string whose JS-`trim()` is non-empty → `{role:"user", parts:[{kind:"text", text:message}]}`
     (text verbatim, untrimmed).
   - `type:"event_msg"`, `payload.type:"item_completed"`, `payload.item.type:"UserMessage"`
     (paginated): one text part per `item.content[]` entry with `type:"text"` and a non-empty
     string `text` (in order); `local_image` entries are dropped. No text part → nothing.
   - `type:"response_item"`, `payload.type:"message"` with role `user` or `developer` is **always
     skipped**: it is the model-side copy of the prompt plus the context codex injects
     (`# AGENTS.md instructions…`, `<environment_context>`, image wrappers, subagent tasks).
4. **Assistant text**: `response_item` / `message` / role `assistant` → one text part per
   `content[]` entry with `type:"output_text"` and a non-empty string `text`. Both phases
   (`commentary`, `final_answer`) render. The UI copies — `event_msg/agent_message` and
   `item_completed` items of type `AgentMessage` — are skipped.
5. **Tool calls**, each its own assistant message with one tool part (`id` = `call_id` on a paged
   read when it is a non-empty string):
   - `function_call`: `name` (non-empty string, else `"tool"`), `arg` = **codexToolArg**(`arguments`).
   - `custom_tool_call`: `name` likewise, `arg` = `input` (a string) JS-`trim()`med, then its first
     200 UTF-16 units; a non-string input → `""`.
   - `tool_search_call`: `name:"tool_search"`, `arg` = codexToolArg(`arguments`).
   - **codexToolArg**: a string is `JSON.parse`d (failure → `""`); the value must be a plain object
     (else `""`). The first key, in the order `cmd`, `command`, `file_path`, `path`, `pattern`,
     `query`, `description`, `prompt`, `message`, whose value is a string wins (first 200 UTF-16
     units); for `command` only, a non-empty array of strings also wins, joined by one space. No
     winner → `""` — never the raw JSON.
6. **Tool outputs** (`function_call_output`, `custom_tool_call_output`, `tool_search_output`), matched
   by `call_id` to a call EARLIER in the same parse:
   - Text: a string `output` as is; an array `output` → the `text` of its `input_text` /
     `output_text` entries (string `text` only) joined by `\n`; anything else → `""`.
   - **Summary**: split the text on `\n`; if one of the FIRST SIX lines is exactly `Output:`, the
     body is the lines after the first such line with leading blank (JS-`trim()` empty) lines
     dropped — and when that leaves nothing, the lines BEFORE `Output:`. Then the first three lines
     joined by one space, first 500 UTF-16 units.
   - Matched call and non-empty summary → the part's `result`. Matched with an empty summary → no
     `result`, still consumed. No matching call on a PAGED read with a non-empty summary and a
     non-empty `call_id` → `unmatchedResults` `{id, result}` (the call is in an older page). A later
     output for the same call overwrites the result. Otherwise skipped.
7. **Notes codex writes only for the harness**:
   - `event_msg/task_complete` with `payload.error` a plain object whose `message` is a string with
     non-empty JS-`trim()` → assistant text `"[error] " + message` (message verbatim).
   - `event_msg/turn_aborted` → assistant text `"[turn aborted: " + reason + "]"` when `reason` is a
     string whose JS-`trim()` is non-empty and at most 100 UTF-16 units (the trimmed value is used),
     else `"[turn aborted]"`.
8. **Model / effort** (paged reads only): every `type:"turn_context"` line replaces BOTH values with
   its `payload.model` / `payload.effort` when each is a string of 1–100 UTF-16 units, else absent.
   The newest `turn_context` in the window answers both; an older one is never carried forward.
9. Everything else is skipped: `session_meta`, `turn_context` (after rule 8), `world_state`,
   `token_count`, `token_usage_record`, `task_started`, a `task_complete` without an error,
   `thread_settings_applied`, `inter_agent_communication_metadata`, `compacted` (the rollout is
   append-only, so history before a compaction stays readable), `reasoning` (encrypted; claude's
   thinking is dropped too), the inter-agent `response_item/agent_message`, every `item_completed`
   item other than `UserMessage` (`AgentMessage`, `CommandExecution`, `FileChange`, `Reasoning`,
   `Extension`, `ImageView`, `SubAgentActivity`, `CollabAgentToolCall`, `ContextCompaction`), and any
   record type a newer codex adds.

No new role, part kind or field: a v1 decoder reads all of this as ordinary text and tool parts.
The two UI user shapes never co-occurred in one measured rollout; a rollout carrying both would show
each prompt twice, and would need a new rule here first.

## What each fixture pins

| fixture | pins |
|---|---|
| `legacy-turns` | The legacy format: `event_msg/user_message` is the prompt; the model-side user copy, the developer and injected context, reasoning, `agent_message` events, `token_count` and `task_complete` are skipped. `exec_command`'s `Chunk ID … Output:` preamble is dropped (a blank line after `Output:` included); `write_stdin`'s arguments name nothing (`arg:""`) and its empty body falls back to the preamble. Markdown survives verbatim. |
| `paginated-turns` | The paginated format (`ordinal`): a `UserMessage` item with non-ASCII text and a `local_image` (dropped), the image-wrapper texts on the model side (skipped), `exec` custom-tool calls (trimmed JavaScript as `arg`, the `Script completed … Output:` preamble dropped, an image-only body falling back to the preamble), `tool_search` (no text output ⇒ no `result`), collaboration calls with a `namespace` (`message` as `arg`), `wait` with an empty body, `sleep`, an inter-agent message, and every non-`UserMessage` item skipped. |
| `errors-and-aborts` | A failed turn (`[error] …`), an interrupted one (`[turn aborted: interrupted]`), an error with an empty message (nothing), the developer `<turn_aborted>` message (skipped), and a reason over 100 units (`[turn aborted]`). |
| `compaction` | A `compacted` record and a `ContextCompaction` item are skipped; the turns before and after both render. |
| `tools-cross-page` | A call in the older page whose output lands in the ~256 KB tail: the tail carries it in `unmatchedResults`, the older page holds the call (with its `id`, no `result`). |
| `model-effort` | The newest `turn_context` answers both fields. |
| `model-effort-no-carry` | The newest `turn_context` states no `effort`: the key is absent. |
| `model-effort-cap` | A 101-unit model is absent; a 100-unit effort is kept. |
| `malformed` | Non-JSON, `null`, an array, a string, a null payload, a non-array `content`, junk content entries, an unparseable timestamp (message without `at`), unparseable `arguments` (`arg:""`), an object `output` (no `result`), and an unknown record type — each costs one line; the last line still renders. |
| `huge-last-line` | The last line is a ~600 KB prompt: the 256 KB tail has no complete line and grows to 1 MB. |
