# Grok chat golden fixtures

The grok half of the chat parser port (`docs/mobile-chat-view.md`). The TypeScript implementation is
the reference: `parseGrokChat` (`src/core/grok-chat.ts`) for the parse, `readChatTranscript`'s grok
leg (`src/core/transcript-ipc.ts`) for the page the phone receives. `nodeterm-ios` keeps a
byte-identical copy of this directory, and its Swift port must reproduce every `expected/*.json` from
the same input.

Every input is **synthetic**, built by `src/core/grok-chat-fixtures.test.ts` from record shapes
measured on grok 1.0.13 (a real-derived session fixture plus the record vocabulary compiled into the
shipped binary). None of them is a slice of a real session. Do not add one.

## Regenerate

```sh
UPDATE_CHAT_FIXTURES=1 npx vitest run src/core/grok-chat-fixtures.test.ts
```

Without the variable, the test requires every file to equal what the code produces, and requires
`inputs/` and `expected/` to hold exactly the generated set. Regenerating is refused when `CI` is set.
After regenerating, refresh the iOS copy in the same change.

## Layout

| path | what it is |
|---|---|
| `inputs/<name>.jsonl` | A synthetic `chat_history.jsonl`. |
| `expected/<name>.page.json` | `{ request, parse, page }`: the phone's request (`{maxBytes: 262144}`), `parseGrokChat(input)` verbatim, and the page `readChatTranscript` serves for that request. |

Every expected file is `JSON.stringify(value, null, 2) + "\n"`, keys in the order the TS code builds
them. Optional keys (`model`, `effort`, a tool part's `result`) are **absent** when unset, never
`null`. The test also checks that the LOCAL leg (a real session directory) and the REMOTE leg (the
host's text through `readRemoteGrok`) serve the identical page, and that `page.messages` equals
`parse.messages`.

## Paging: grok does not page

`chat_history.jsonl` is NOT an append-only log. grok 1.0.13 persists it through
`chat_history.jsonl.sync.tmp` + rename, and `/compact`, `/rewind` and its own history repair
(duplicate and dangling tool results) rewrite the history in place. A byte offset is therefore not a
stable identity for a line, so:

- The desktop reads the file's **tail window**: the newest `page.maxBytes` of it (the phone asks for
  262144), never more than 5 MiB (`CHAT_PAGE_MAX_BYTES`); the legacy unpaged read takes the full
  5 MiB. Local and remote (SSH host) legs read the same window. When capped, the partial first line is
  dropped (a line starting exactly on the window edge is kept).
- A paged request is answered with ONE page: `olderCursor: null`, `unmatchedResults: []`, and **no
  `key` and no `at`** on any message (grok records carry no timestamp).
- The phone must treat a grok page as the **whole thread**: replace, never merge by key, and never ask
  for an older page. There is no "beginning of conversation" marker, because a capped read cannot
  know it reached the start.
- `model` / `effort` ride a paged reply exactly as they do for claude. The legacy unpaged read stays
  `{messages, found}`.

## Record rules (the Swift port must replicate these exactly)

**Changed in `feat/chat-view-grok`:** a tool part's `arg` is now the SALIENT argument (rule 8) and its
`result` the first three lines of the output (rule 6) — earlier builds showed the raw `arguments` /
full result. The iOS port must follow these goldens, not the old formatting.

Lines are split on `\n`. A line that is blank after JS `trim` is ignored. Each remaining line is
`JSON.parse`d (after trim):

1. **Skipped and counted** (`parse.skipped`): a line that does not parse, parses to a non-object
   (`42`, `null`, a string), parses to an array, or is an object whose `type` is not one of `system`,
   `user`, `assistant`, `tool_result`, `backend_tool_call`, `reasoning`. The count is not on the wire.
2. **Text of a `content` field** (`textOf`): a string is itself; an array maps each item to itself if
   it is a string, else to its `text` field (else `""`), drops empty strings, and joins with `\n`;
   anything else is `""`.
3. `system` → if its text is non-empty, an assistant message with one text part `"[system] " + text`.
4. `user` → if its text is empty, nothing. If `synthetic_reason` is a string whose JS-`trim` is
   non-empty, an **assistant** message `"[" + trimmedReason + "] " + text` (harness-injected text is
   never shown as something the human typed). Otherwise a user message with the text.
5. `assistant`:
   - **model / effort**: every assistant record REPLACES both values — `model_id` and
     `reasoning_effort`, each kept only when it is a non-empty string of at most 100 UTF-16 units
     (JS `.length`, Swift `utf16.count`). A record that does not state one clears it: the newest
     assistant record answers both fields, and nothing is carried forward from an older record.
   - parts: a text part with `textOf(content)` when non-empty, then one tool part per entry of
     `tool_calls` (only when `tool_calls` is an array; an entry that is not a JSON object — `null`, a
     number, a string, an array — is ignored):
     `name` = the entry's `name` when it is a non-empty string, else `"tool"`; `arg` = see rule 8.
   - An entry with a non-empty string `id` is remembered for rule 6. A message is pushed only when it
     has at least one part.
6. `tool_result` → when `tool_call_id` is a string naming a remembered call, that call's tool part
   gets `result` = `textOf(content)` split on `\n`, the first three pieces joined with a space, then
   its first 500 UTF-16 units — set only when non-empty. A later result for the same id overwrites.
   An orphan result is dropped (never its own message).
7. `backend_tool_call` → an assistant message with one tool part (a `kind` that is not a JSON object
   counts as absent): `name` = `kind.tool_type` when it is a non-empty string, else `"backend_tool"`;
   `arg` = `kind.action.query` when it is a string
   (first 200 UTF-16 units), else `""`. No `result`.
8. **A tool call's `arg`**: when `arguments` is a string, it is `JSON.parse`d (a failure leaves no
   object); when it is an object it is used as is. If that yields a non-array object, the first of
   these keys whose value is a non-empty string wins, in this order: `command`, `target_file`,
   `file_path`, `target_directory`, `path`, `pattern`, `query`, `url`, `description`, `prompt` (claude's
   `toolArg` order with grok's measured `target_file` / `target_directory` added). Otherwise the arg is
   the raw text: the `arguments` string itself, `JSON.stringify` of an object/array, or `""` for any
   other value. Either way, the first 200 UTF-16 units (`String.prototype.slice(0, 200)`).
9. `reasoning` → nothing (its `encrypted_content` is unreadable and its `summary` is omitted by
   product decision), and it is NOT counted as skipped.

No new role, part kind or field: a v1 decoder reads all of this as ordinary text and tool parts.

## What each fixture pins

| fixture | pins |
|---|---|
| `plain-turns` | The `system` prompt note, typed prompts with `prompt_index`, markdown, two text items joined with `\n`, a string-content user record, non-ASCII text. |
| `tools` | Salient args (`target_file`, `target_directory`, `command`, `file_path`, `path` over `pattern`), the raw-text fallback capped at 200, a non-JSON `arguments` string, results summarised to three lines / 500 units, an empty result (no `result` key), an orphan result dropped. |
| `synthetic-notes` | Every injected reason becomes an assistant-side `[reason]` note (`project_instructions`, `system_reminder`, `task_completed`, `subagent_completed`, `permission_rejected`, `compaction_meta`); a blank reason reads as the user. |
| `backend-and-reasoning` | `reasoning` records (with and without a summary) render nothing; a `web_search` backend call with a query, and one without. |
| `model-effort` | The newest assistant record's model and effort win. |
| `model-effort-no-carry` | The newest record states no effort: `effort` is absent, never an older record's value. |
| `model-effort-cap` | A model of 50 × U+1F9EA (100 UTF-16 units) is kept; an effort of 101 units is absent. |
| `skipped-lines` | A truncated line, `42`, `null`, an array and an unknown `type` are skipped and counted (5); a blank line is ignored without counting. |
| `reasoning-only` | A history with nothing renderable is still FOUND, with no messages. |
