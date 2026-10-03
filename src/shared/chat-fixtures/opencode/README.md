# opencode chat golden fixtures

The reference outputs for the chat view's **opencode** reader (`src/core/opencode-chat.ts`). The TS
implementation is the reference. `nodeterm-ios` keeps a byte-identical copy of this directory, and
its Swift port must reproduce every `expected/*.json` from the same `inputs/*.json`.

Every input is **synthetic**: an `opencode export` document built by
`src/core/opencode-chat.fixtures.test.ts` from the schema measured on opencode 1.18.25. None is a
slice of a real session. Do not add one.

## Regenerate

```sh
UPDATE_CHAT_FIXTURES=1 npx vitest run src/core/opencode-chat.fixtures.test.ts
```

Refused when `CI` is set. Without the variable the test requires every file to equal what the code
produces, and `inputs/` / `expected/` to hold exactly the generated set.

## Where the input comes from

opencode has no transcript file. Since 1.18 it keeps sessions in SQLite, and the reader runs
`opencode export <sessionID>` (argv exactly `["export", id]`, no other flag: opencode's CLI is yargs
strict and exits 1 on an option an older build does not know). Measured on 1.18.25:

- stdout is the document alone, `JSON.stringify(doc, null, 2)` + EOL; stderr says `Exporting session: <id>`;
- an unknown id exits **1** with an **empty** stdout and `Session not found: <id>` on stderr (ANSI
  coloured) — the only answer read as a clean miss (`found: false`); every other failure is a
  failed read (`unreadable: true`);
- one export costs 1.0–1.7 s and ~320 MB peak RSS, so the desktop runs at most one per session at a
  time and two in total; the panel's background refreshes are spaced 5 s, and an unchanged
  database (stat of `opencode*.db` + `-wal`, never opened) is answered from a small cache.
- a page honours the request's `maxBytes`, grows ×4 up to 5 MB when it holds no whole message (as
  claude's reader does), and a newest message above 5 MB is served truncated with a note, never as
  an empty page. The phone should expect that note in the text, not a separate field.

The reader never runs an export without a session id (a bare `opencode export` opens a picker over
the newest sessions), never for an id outside `^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$`, and never for a
remote node (its sessions are in the host's database).

## Layout

| path | what it is |
|---|---|
| `inputs/<name>.json` | The export document, exactly as `opencode export` would print it. |
| `expected/<name>.json` | `{ sessionId, parse, page }` — see below. |

- `sessionId` — the id the reader was asked for (`ses_0a1b2c3d4ffeSynthetic000001` in every case).
- `parse` — `parseOpencodeExport(input, sessionId)` verbatim: `{ messages, skipped, model?, effort? }`,
  or `null` when the input is not an export of that session.
- `page` — what the desktop serves for a paged request (`{maxBytes: 262144}`), i.e. what the phone
  receives before `host-chat` adds `version` / `sessionId`.

Same serialization rules as the parent README: `JSON.stringify(value, null, 2) + "\n"`, keys in the
order the TS code builds them, optional keys **absent** when unset (never `null`).

## The page (one page, always)

An export is ONE JSON document, so there are no byte offsets to page by. A paged read returns:

- success: `{ messages, found: true, olderCursor: null, unmatchedResults: [], model?, effort? }`;
- a clean miss (no session id, an unsafe id, or opencode's `Session not found`):
  `{ messages: [], found: false, olderCursor: null, unmatchedResults: [] }`;
- a failed export, an export that is not this session's (`parse` is `null`), or a remote node:
  the same plus `unreadable: true`;
- a request WITH `before` (an older page): `{ messages: [], found: true, olderCursor: null,
  unmatchedResults: [] }` without running anything — this reader never hands out a cursor.

`messages` is the parse's messages cut to the NEWEST ones whose `JSON.stringify` UTF-8 sizes sum to
at most 5242880 bytes (`CHAT_PAGE_MAX_BYTES`), walking from the end and stopping at the first that
does not fit. No `key` is set (there are no offsets), no tool part carries an `id`, and
`unmatchedResults` is always `[]`.

An unpaged (legacy) read is `{ messages, found }` only, and a failure is `{ messages: [], found: false }`.

## The parse (the Swift port must replicate this exactly)

`parse` is `null` unless the input is valid JSON whose top level is an object with an object
`info` whose `id` equals the requested session id. Otherwise `messages` is built from
`doc.messages` (a missing or non-array `messages` is `[]`), one entry at a time, in order:

1. **Skipped and counted** (`skipped += 1`, nothing rendered): an entry that is not an object or has
   no object `info`; an `info.sessionID` that is present and not the requested id; a `role` other
   than `user` / `assistant`; `parts` that is not an array.
2. `at` = `info.time.created` when it is a finite number (epoch ms), else the key is absent. Every
   message pushed for the entry carries the same `at`.
3. Each part, in order. A part that is not an object or has no string `type` is skipped and counted.
   - `text`: a non-string `text` is skipped and counted. `synthetic: true`, `ignored: true` or an
     empty text is dropped silently. Otherwise `{kind:"text", text}` for the speaker (not trimmed).
   - `tool`: a non-object `state` is skipped and counted. Otherwise a tool part (below) — for the
     speaker in an assistant entry, as a **chip** in a user entry.
   - `compaction`: a chip `{kind:"tool", name:"compaction", arg: auto === true ? "auto" : ""}`.
   - `subtask`: a chip `{kind:"tool", name:"task", arg}` with `arg` from `{description, prompt}` by
     the tool-arg rule.
   - `reasoning`, `step-start`, `step-finish`, `snapshot`, `patch`, `retry`, `file`, `agent`: dropped
     silently (NOT counted).
   - any other type: skipped and counted.
4. An **assistant** entry: when `info.error` is present, a non-object error is skipped and counted;
   otherwise a text part is appended after the speaker's parts: `[<name>] <message>` where `name` is
   `error.name` when a non-empty string else `Error`, and `message` is `error.data.message` trimmed
   (JS `trim`) when a string; with an empty message it is `[<name>]`. Then one assistant message of
   speaker parts followed by chips, when there is at least one part.
5. A **user** entry: a user message of the speaker's text parts (when any), then an assistant
   message of the chips (when any).
6. `model` / `effort`: the LAST assistant entry that passed rule 1 (whether or not it produced a
   message) answers both — `info.modelID` and `info.variant`, each kept only when a string of 1 to
   100 UTF-16 code units. A field that entry does not state is absent; nothing is carried from an
   older entry.

**Tool part.** `name` = `tool` when a non-empty string, else `"tool"`. `arg` = the first STRING among
`state.input`'s `command`, `filePath`, `file_path`, `pattern`, `path`, `url`, `query`,
`description`, `prompt`, `name` (in that order — `pattern` before `path`); else
`state.input.questions[0].question` when a string; else `state.title` when a string; else `""`;
then cut to its first 200 UTF-16 units. `result`, only when set:

- `status: "completed"` with a string `output`: the summary of `output`, key absent when empty;
- `status: "error"` with a string `error`: the summary of `"Error: " + error`;
- anything else (`pending`, `running`): no `result` key.

The summary is the first three `\n`-separated lines joined by one space, then the first 500 UTF-16
units. A tool part never carries `body`, `questions` or `id`: opencode's `question` tool looks like
Claude's AskUserQuestion, but answer cards are Claude-only.

## What each fixture pins

| fixture | pins |
|---|---|
| `turns` | Markdown and non-ASCII text, two text parts in one message, `at`; reasoning and step parts dropped uncounted; a reasoning-only assistant entry yields no message but still answers `model` (and its missing `variant` leaves `effort` absent). |
| `tools` | Every tool state, the arg key order (`pattern` before `path`), the `questions[0].question` and `title` fallbacks, a missing tool name, the 200-unit arg cap, the 3-line / 500-unit summary, `Error: ` on an error, no `result` key while pending/running, no card fields on `question`. |
| `harness-text` | `synthetic` / `ignored` text, `file` and `agent` parts dropped; a user entry with only synthetic text yields nothing; a tool part in a user entry becomes an assistant chip after the user bubble. |
| `errors` | `[name] message` after the partial text, `[name]` for an empty `data`, a trimmed message, a malformed error counted while the entry's text is kept, `retry` dropped. |
| `compaction-subtask` | Auto and manual compaction chips, the `summary: true` message as ordinary text, a subtask chip after the user's text. |
| `unmappable` | Eleven counted shapes (bad entries, an unknown role, non-array parts, a message of another session, bad parts, a stateless tool); only `kept` renders. |
| `model-no-carry` | The newest assistant entry answers both fields; a user entry's `model` is never read. |
| `model-utf16` | 101 UTF-16 units (50 × U+1F9EA + 1) is over the cap; 100 is kept. |
| `foreign-session` | An export of another session: `parse` is `null` and the page is unreadable and empty. |
