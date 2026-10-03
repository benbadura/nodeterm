# Gemini chat golden fixtures

The reference outputs for the chat view's **gemini** reader (`src/core/gemini-chat.ts`), the same
contract as the Claude fixtures one directory up: the TypeScript implementation is the reference,
`nodeterm-ios` keeps a byte-identical copy of this directory, and a Swift port must reproduce every
`expected/*.page.json` from the same input.

Every input is **synthetic**, built by `src/core/gemini-chat-fixtures.test.ts` from record shapes
measured against gemini-cli 0.61.0 (its `ChatRecordingService` in the installed bundle, and real
session files on the author's machine). None is a slice of a real session. Do not add one.

## Regenerate

```sh
UPDATE_CHAT_FIXTURES=1 npx vitest run src/core/gemini-chat-fixtures.test.ts
```

Without the variable, every file must equal what the code produces. Regenerating is refused when
`CI` is set. After regenerating, refresh the iOS copy in the same change.

## Layout

| path | what it is |
|---|---|
| `inputs/<name>.jsonl` | A synthetic gemini session file (`~/.gemini/tmp/<project>/chats/session-*.jsonl`). |
| `expected/<name>.page.json` | `{ page, skipped }`: the page the desktop serves for it, and the count of records it could not map. |

`page` is exactly what `readChatTranscript` answers for a paged request (`{maxBytes: 262144}`) on a
gemini node, which is what the relay's `chat.page` sends the phone. The test copies the input into a
scratch `GEMINI_CLI_HOME` and reads it through the real locator, and it also checks that `page`
equals the pure parser's output (`chatFromGemini`) plus the paging constants.

Serialization is `JSON.stringify(value, null, 2) + "\n"`. Keys appear in the order the TS code builds
them: page `messages`, `found`, `olderCursor`, `unmatchedResults`, then `model` when there is one;
message `role`, `parts`, then `at`; tool part `kind`, `name`, `arg`, then `result`. Optional keys are
**absent** when unset, never `null`.

## One page, no paging

A gemini session file is not paged, and never will be by byte window. It is an **upsert log**: the
same message id is written again, in full, every time the message changes (its tool calls are added,
their results land, its token counts arrive), and a `$rewindTo` record deletes earlier messages. A
record's meaning depends on the records before it, so a window of bytes cannot be folded on its own.

The reader therefore reads the whole file and answers ONE page: `olderCursor: null`,
`unmatchedResults: []`, no message `key`, no tool part `id`. This is the same shape grok's reader
answers. The read is capped at the last 5 MB (5242880 bytes, the Claude legacy cap, `readCappedTail`).
Past the cap, the first partial line is dropped and the fold starts there. No fixture is that large;
the behaviour is covered by a unit test that builds its file at run time.

## The fold (the port must replicate this exactly)

Split the file on `\n` and parse each non-blank line as JSON. Then, in file order:

1. A line that does not parse, or parses to anything but a JSON object (`null`, a number, a string,
   an array), is **skipped and counted**.
2. `$rewindTo` is a string → a rewind. If that id is in the log, delete it and every message
   inserted after it (insertion order). If it is NOT in the log, **ignore the record and count it**.
   Gemini's own loader clears everything in that case. We do not: after a compression gemini's
   targets are re-minted ids this log deliberately does not hold (rule 4), and past the 5 MB cap the
   target can sit before the window, so a wipe would blank a thread that is really there.
3. `id` is a string → a message record. **Upsert** it into the log by id: a new id is appended; a
   known id keeps its first position and its content is replaced by this record.
4. `$set` is an object → metadata. **Ignore it, including `$set.messages`.** `$set.messages` is the
   model's context, rewritten at session start (the `<session_context>` preamble), on every
   compression (all turns re-minted under new ids, older ones dropped, a `<state_snapshot>` summary
   inserted as a user turn), and when an aborted turn is rolled back. Every message that was actually
   said is also written as its own record, so honouring it would only make the thread vanish at each
   compression, show the model-facing snapshot as something the human typed, and delete a cancelled
   prompt the terminal still shows.
5. `sessionId` and `projectHash` are both strings → the header. If it carries a `messages` array (an
   older single-record shape), upsert each element that has a string `id`, in order.
6. Anything else is **skipped and counted**.

Rules 2 to 5 are tested in that order, exactly as gemini's `loadConversationRecord` tests them.

## Rendering (the port must replicate this exactly)

Walk the log in insertion order. `at` is `Date.parse(record.timestamp)` in epoch milliseconds when
`timestamp` is a non-empty string that parses; otherwise the key is absent. A message that ends with
no parts is not emitted.

**Visible text** of a `content` / `displayContent` value: a string is one text; an array contributes
the `text` of each element that is an object with a string `text` and without `thought: true`. Then
drop every text that is empty, or whose `trimStart()` begins with `<session_context>` or
`<hook_context>` (harness text; gemini appends a hook's context as its own part beside the prompt,
so this is per PART, never per message). Everything else in a part array (`inlineData`, `fileData`,
`functionCall`, `functionResponse`) contributes no text.

**`type: "user"`**
- First, for each `content` element with a `functionResponse` object: when its `id` names a tool part
  already emitted that has **no** `result` yet, and the response text (below) is non-empty after
  summarizing, set that tool's `result`. A later response never overwrites a result.
- The bubble is the visible text of `displayContent` when that key is present and yields at least one
  text, else the visible text of `content`. One text part per visible text, `role: "user"`.
  (Gemini records `displayContent` when what was sent differs from what was typed, e.g. an `@file`
  expanded into the file's body.) A turn of only `functionResponse` parts is tool output: no bubble.

**`type: "gemini"`** → `role: "assistant"`. Parts: one text part per visible text of `content`,
then tool parts:
- If `toolCalls` is an array with at least one element: one tool part per element, in order. An
  element that is not an object is **skipped and counted**. Otherwise:
  - `name`: the call's `name` if a non-empty string, else `"tool"`.
  - `arg`: the first non-empty string among `args.command`, `args.file_path`, `args.dir_path`,
    `args.path`, `args.pattern`, `args.query`, `args.prompt`, `args.name`, `args.title` (when `args`
    is an object), else the call's `description` string, else `""`. Then its first 200 UTF-16 units
    (`String.prototype.slice(0, 200)`).
  - `result`: the response text of the first element of `result` (an array) that has one (a
    string, even an empty one, ends the search); when no element has one, `resultDisplay` when it is
    a **string** (an object, e.g. a file diff, gives nothing). Summarized. Absent when that is empty.
- Else, when `content` is an array: one tool part per element with a `functionCall` object, `name`
  and `arg` from `functionCall.name` / `functionCall.args` by the same rules (no `description`
  fallback), no `result` (a later user `functionResponse` may set it, rule above). This is the shape
  of a rewritten file. When `toolCalls` is present these parts are NOT also emitted.
- Tool parts are registered by their call id (`toolCalls[].id` / `functionCall.id`) for the
  `functionResponse` rule above.
- `thoughts` and `thought: true` parts are dropped, as Claude's reader drops thinking. A turn with
  only thoughts emits nothing.

**Response text** of a part: `functionResponse.response.output` if a string, else
`functionResponse.response.error` if a string, else none.

**Summarized**: split on `\n`, keep the first 3 lines joined by one space, then the first 500 UTF-16
units. The same rule as Claude's `summarizeResult`.

**`type: "info"`, `"warning"`, `"error"`** (the TUI's own notes: a compression, a cancel, an API
error) → one assistant text part `"[<type>] " + <visible texts joined by "\n">`. Nothing when that
text is empty. Never a user bubble.

**Any other `type`** (including none) is **skipped and counted**.

**`model`**: walking in the same order, every `type: "gemini"` record whose `model` is a string of 1
to 100 UTF-16 units sets it. A record with no model, or an over-long one, leaves the previous value.
Absent (the key) when none sets it. There is no `effort`: gemini records none.

`skipped` = rule 1 lines + unknown `$rewindTo` targets + rule 6 records + unknown message types +
non-object `toolCalls` elements. It is never sent over the wire; it exists so a port can prove it
drops the same records.

## What each fixture pins

| fixture | pins |
|---|---|
| `plain-turns` | The session-start `$set.messages` preamble (never shown); typed prompts as a part array and as a string; two text parts in one user turn; a model turn with `thoughts`, `tokens` and `model` (thoughts dropped); markdown and non-ASCII text; a part-array model reply. |
| `tool-calls` | The measured tool lifecycle: a call recorded as `executing`, its output as a user turn of `functionResponse` parts (no bubble), then the SAME id rewritten with results (one tool part, the final result, summarized to three lines). Every `arg` key, the `description` fallback, the 200-unit arg cap, the 500-unit result cap, an error response, a string `resultDisplay`, an object `resultDisplay` (no result), a nameless call (`"tool"`), and two non-object entries (skipped). |
| `upsert-rewind` | A rewrite keeps the first position; `$rewindTo` a known id drops it and everything after; `$rewindTo` an unknown id is ignored and counted; `model` after a rewind comes from what remains. |
| `history-sync` | `$set.messages` at session start, at a compression (re-minted ids, `<state_snapshot>`, the "Got it" turn) and at a cancelled turn's rollback: none of it shown, nothing erased; the metadata-only `$set` shapes (`summary`, `memoryScratchpad`, `directories`, `sessionId`); `info` notes. |
| `harness-and-display` | A `<session_context>`-only user turn (no bubble); a `<hook_context>` part dropped beside the prompt it was appended to; `displayContent` preferred over an `@file`-expanded `content`; an image part beside text; a thoughts-only turn, a thought-part-only turn and an image-only `info` record (all emit nothing); a thought part beside visible text. |
| `notes-and-junk` | A header carrying `messages`; `info` / `warning` / `error`; an empty `info`; and every skip: an unknown `type`, a torn line, `null`, a number, an array, an object that is no record kind, a numeric `id`. Missing and unparseable timestamps (no `at`). |
| `function-call-content` | A rewritten file's model turns: `functionCall` parts in `content` beside thought parts, answered by a later user `functionResponse` record; a turn carrying both `toolCalls` and `functionCall` parts (`toolCalls` wins, no duplicate, the late response does not overwrite). |
| `model` | Newest wins; a turn without a model keeps the previous; 50 × U+1F9EA (100 UTF-16 units) is kept; 101 units is ignored; an `info` record's `model` is never read. |
