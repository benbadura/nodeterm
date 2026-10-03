// Golden fixtures for gemini's chat view (`src/shared/chat-fixtures/gemini/`), the reference the
// iOS Swift port locks to byte for byte — the same contract as the claude fixtures beside it
// (`chat-fixtures.test.ts`), for gemini's reader (`core/gemini-chat.ts`).
//
//   UPDATE_CHAT_FIXTURES=1 npx vitest run src/core/gemini-chat-fixtures.test.ts
//
// rewrites `gemini/inputs/` and `gemini/expected/`. Without the variable every file must already
// equal what this code produces.
//
// Inputs are SYNTHETIC, built below from the record shapes measured against gemini-cli 0.61.0's
// ChatRecordingService and on real session files — never slices of real ones (customer data).
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chatFromGemini } from './gemini-chat'
import { readChatTranscript } from './transcript-ipc'
import { CHAT_PAGE_DEFAULT_BYTES } from '../shared/chat-page'

const DIR = path.join(__dirname, '..', 'shared', 'chat-fixtures', 'gemini')
const UPDATE = process.env.UPDATE_CHAT_FIXTURES === '1'
if (UPDATE && process.env.CI) throw new Error('UPDATE_CHAT_FIXTURES must not be set in CI')

// ── Synthetic records, in the measured shapes ────────────────────────────────────────────────────
const SID = '3e7b9c21-4d5a-4f60-8b19-a2c3d4e5f607'
const T0 = Date.parse('2026-09-28T10:00:00.000Z')
const ts = (i: number): string => new Date(T0 + i * 1000).toISOString()

type Rec = Record<string, unknown>
const header = (extra: Rec = {}): Rec => ({
  sessionId: SID,
  projectHash: 'c0ffee'.padEnd(64, '0'),
  startTime: ts(0),
  lastUpdated: ts(0),
  kind: 'main',
  ...extra
})
/** A message record; `i` fixes its timestamp so the expected `at` is exact. */
const m = (i: number, id: string, type: string, content: unknown, extra: Rec = {}): Rec => ({
  id,
  timestamp: ts(i),
  type,
  content,
  ...extra
})
const tokens = { input: 1200, output: 40, cached: 800, thoughts: 60, tool: 0, total: 1300 }
const thought = (i: number, subject: string, description: string): Rec => ({ subject, description, timestamp: ts(i) })
const fr = (id: string, name: string, response: Rec): Rec => ({ functionResponse: { id, name, response } })
const call = (id: string, name: string, args: unknown, extra: Rec = {}): Rec => ({
  id,
  name,
  args,
  status: 'success',
  timestamp: ts(9),
  displayName: name,
  description: '',
  renderOutputAsMarkdown: false,
  ...extra
})
const lastUpdated = (i: number): Rec => ({ $set: { lastUpdated: ts(i) } })
const jsonl = (...recs: unknown[]): string => recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'
const PREAMBLE = '<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\n</session_context>'

const INPUTS: Record<string, string> = {
  // A plain exchange: the session-start history sync (preamble), typed prompts in both content
  // shapes, a model turn with thoughts + tokens + model, markdown and non-ASCII text.
  'plain-turns.jsonl': jsonl(
    header(),
    { $set: { messages: [m(0, 's0', 'user', [{ text: PREAMBLE }])], lastUpdated: ts(0) } },
    m(1, 'u1', 'user', [{ text: 'Özet çıkar: **README** — 3 madde ✓' }]),
    lastUpdated(1),
    m(2, 'g1', 'gemini', '## Özet\n\n- bir\n- iki\n- üç\n\n```ts\nconst x = 1\n```', {
      thoughts: [thought(2, 'Reading', 'The user wants a summary.')],
      tokens,
      model: 'gemini-3.5-flash'
    }),
    lastUpdated(2),
    m(3, 'u2', 'user', 'a string content (older record shape)'),
    m(4, 'u3', 'user', [{ text: 'first part' }, { text: 'second part' }]),
    m(5, 'g2', 'gemini', [{ text: 'answer as a part list' }], { tokens, model: 'gemini-3.5-flash' })
  ),

  // The measured tool lifecycle: the call is recorded, its output arrives as a user turn of
  // functionResponse parts, then the SAME message id is rewritten with the results. Plus every arg
  // key gemini's tools declare, the caps, an error, display-only results and malformed entries.
  'tool-calls.jsonl': jsonl(
    header(),
    m(1, 'u1', 'user', [{ text: 'look around' }]),
    m(2, 'g1', 'gemini', 'Let me look.', {
      thoughts: [],
      model: 'gemini-3.5-flash',
      toolCalls: [call('c1', 'run_shell_command', { command: 'ls -la', description: 'List files', dir_path: '/srv' }, { status: 'executing' })]
    }),
    m(3, 'g1_response', 'user', [fr('c1', 'run_shell_command', { output: 'a.txt\nb.txt' })]),
    m(2, 'g1', 'gemini', 'Let me look.', {
      thoughts: [],
      tokens,
      model: 'gemini-3.5-flash',
      toolCalls: [
        call('c1', 'run_shell_command', { command: 'ls -la', description: 'List files', dir_path: '/srv' }, {
          result: [fr('c1', 'run_shell_command', { output: 'total 2\na.txt\nb.txt\nc.txt\nd.txt' })],
          resultDisplay: 'total 2\na.txt\nb.txt\nc.txt\nd.txt'
        })
      ]
    }),
    m(4, 'g2', 'gemini', '', {
      model: 'gemini-3.5-flash',
      toolCalls: [
        call('c2', 'read_file', { file_path: 'src/app.ts', start_line: 1 }, { result: [fr('c2', 'read_file', { output: 'x'.repeat(520) })] }),
        call('c3', 'list_directory', { dir_path: 'src' }, { result: [fr('c3', 'list_directory', { output: 'app.ts' })] }),
        call('c4', 'glob', { pattern: '**/*.md' }, { resultDisplay: 'Found 2 matching file(s)' }),
        call('c5', 'grep_search', { pattern: 'TODO', include_pattern: '*.ts' }, { resultDisplay: { summary: 'not text' } }),
        call('c6', 'google_web_search', { query: 'gemini cli release notes' }),
        call('c7', 'web_fetch', { prompt: 'summarize https://example.com' }),
        call('c8', 'activate_skill', { name: 'pdf' }),
        call('c9', 'update_topic', { title: 'Reading the repo', summary: 's', strategic_intent: 'i' }),
        call('c10', 'write_todos', { todos: [] }, { description: 'Set 3 todo(s)' }),
        call('c11', 'replace', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }, {
          status: 'error',
          result: [fr('c11', 'replace', { error: 'Failed to edit: 0 occurrences found' })],
          resultDisplay: { fileDiff: '--- a\n+++ b', fileName: 'app.ts' }
        }),
        call('c12', 'run_shell_command', { command: 'echo ' + 'y'.repeat(240) }),
        { id: 'c13', args: {} },
        'not a call',
        null
      ]
    })
  ),

  // Upserts (first position, last content) and rewinds: to a known id, and to one the thread never
  // held (ignored and counted — gemini would wipe everything).
  'upsert-rewind.jsonl': jsonl(
    header(),
    m(1, 'u1', 'user', [{ text: 'keep this' }]),
    m(2, 'g1', 'gemini', 'draft answer', { model: 'gemini-3.5-flash' }),
    m(2, 'g1', 'gemini', 'draft answer', { model: 'gemini-3.5-flash', tokens }),
    m(3, 'u2', 'user', [{ text: 'this gets rewound' }]),
    m(4, 'g2', 'gemini', 'so does this', { model: 'gemini-2.5-pro' }),
    { $rewindTo: 'u2' },
    { $rewindTo: 'never-shown' },
    m(5, 'u3', 'user', [{ text: 'asked again' }]),
    m(6, 'g3', 'gemini', 'second try', { model: 'gemini-3.5-flash' })
  ),

  // `$set.messages` is the MODEL's context and never the thread: the session-start preamble, a
  // compression (every turn re-minted under a new id, a <state_snapshot> summary inserted), and an
  // aborted turn's rollback. Plus the metadata-only `$set` shapes.
  'history-sync.jsonl': jsonl(
    header(),
    { $set: { messages: [m(0, 's0', 'user', [{ text: PREAMBLE }])], lastUpdated: ts(0) } },
    m(1, 'u1', 'user', [{ text: 'first question' }]),
    m(2, 'g1', 'gemini', 'first answer', { model: 'gemini-3.5-flash' }),
    m(3, 'i1', 'info', 'Chat history compressed from 91200 to 12400 tokens.'),
    {
      $set: {
        messages: [
          m(3, 'x0', 'user', [{ text: PREAMBLE }]),
          m(3, 'x1', 'user', [{ text: '<state_snapshot>\n  <overall_goal>SNAPSHOT</overall_goal>\n</state_snapshot>' }]),
          m(3, 'x2', 'gemini', [{ text: 'Got it. Thanks for the additional context!' }])
        ],
        lastUpdated: ts(3)
      }
    },
    m(4, 'u2', 'user', [{ text: 'a prompt I cancelled' }]),
    m(5, 'i2', 'info', 'Request cancelled.'),
    { $set: { messages: [m(3, 'x0', 'user', [{ text: PREAMBLE }])], lastUpdated: ts(5) } },
    { $set: { summary: 'A session summary' } },
    { $set: { memoryScratchpad: { notes: 'n' } } },
    { $set: { directories: ['/srv/app'] } },
    { $set: { sessionId: SID } },
    m(6, 'u3', 'user', [{ text: 'after all that' }])
  ),

  // Harness text dropped per PART, what the user typed preferred over what was sent, thinking and
  // non-text parts dropped.
  'harness-and-display.jsonl': jsonl(
    header(),
    m(1, 'u0', 'user', [{ text: PREAMBLE }]),
    m(2, 'u1', 'user', [{ text: 'my prompt' }, { text: '<hook_context>added by a BeforeAgent hook</hook_context>' }]),
    m(3, 'u2', 'user', [{ text: 'explain @src/app.ts' }, { text: '\n--- Content from referenced files ---' }, { text: 'FILE BODY' }], {
      displayContent: [{ text: 'explain @src/app.ts' }]
    }),
    m(4, 'u3', 'user', [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }, { text: 'what is in this image?' }]),
    m(5, 'g1', 'gemini', '', { thoughts: [thought(5, 'Looking', 'at the image')], model: 'gemini-3.5-flash' }),
    m(6, 'g2', 'gemini', [{ text: 'Binary content received. Proceeding with analysis.', thought: true, thoughtSignature: 'sig' }]),
    m(7, 'i1', 'info', [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }]),
    m(8, 'g3', 'gemini', [{ text: '**Looking** at the image', thought: true }, { text: 'A cat.' }], { model: 'gemini-3.5-flash' })
  ),

  // The TUI's own notes, and everything that cannot be mapped (counted in `skipped`, never shown).
  'notes-and-junk.jsonl': jsonl(
    { ...header(), messages: [m(1, 'h1', 'user', [{ text: 'carried in the header record' }])] },
    m(2, 'i1', 'info', 'Switched to fallback model gemini-2.5-flash'),
    m(3, 'w1', 'warning', [{ text: 'Approaching the context limit.' }]),
    m(4, 'e1', 'error', '[API Error: 429 Resource exhausted]'),
    m(5, 'i2', 'info', ''),
    m(6, 'q1', 'mystery', 'an unknown message type'),
    '{truncated line',
    'null',
    '7',
    '["an","array"]',
    { unrelated: true },
    { id: 11, type: 'user', content: 'a numeric id is not a message record' },
    { id: 'u9', type: 'user', content: 'no timestamp at all' },
    m(0, 'u10', 'user', 'an unparseable timestamp', { timestamp: 'yesterday' })
  ),

  // A REWRITTEN file (`rewriteConversationFile` after a history sync): model turns carry their calls
  // as functionCall parts in `content` (next to thought parts), answered by a separate user record.
  // When `toolCalls` is also present it wins and the parts are not duplicated.
  'function-call-content.jsonl': jsonl(
    header(),
    m(1, 'u1', 'user', [{ text: 'read it' }]),
    m(2, 'g1', 'gemini', [
      { text: '**Plan** read the file', thought: true },
      { text: 'Reading.' },
      { functionCall: { id: 'f1', name: 'read_file', args: { file_path: 'x.ts' } } }
    ]),
    m(3, 'g1_response', 'user', [fr('f1', 'read_file', { output: 'export const x = 1' })]),
    m(4, 'g2', 'gemini', [{ functionCall: { id: 'f2', name: 'glob', args: { pattern: '*.ts' } } }], {
      toolCalls: [call('f2', 'glob', { pattern: '*.ts' }, { result: [fr('f2', 'glob', { output: 'x.ts' })] })]
    }),
    m(5, 'g2_response', 'user', [fr('f2', 'glob', { output: 'a DIFFERENT late answer' })])
  ),

  // The model label: the newest model turn that states a usable one. A turn without one does not
  // clear it, and a value over 100 UTF-16 units is not a model (50 × U+1F9EA = 100 units is kept).
  'model.jsonl': jsonl(
    header(),
    m(1, 'g1', 'gemini', 'one', { model: 'gemini-2.5-pro' }),
    m(2, 'g2', 'gemini', 'two', { model: '🧪'.repeat(50) }),
    m(3, 'g3', 'gemini', 'three'),
    m(4, 'g4', 'gemini', 'four', { model: 'x'.repeat(101) }),
    m(5, 'i1', 'info', 'an info record carrying a model', { model: 'not-a-model-turn' })
  )
}

// ── Plumbing ─────────────────────────────────────────────────────────────────────────────────────
const serialize = (x: unknown): string => JSON.stringify(x, null, 2) + '\n'
const fixture = (rel: string): string => path.join(DIR, rel)

function golden(rel: string, content: string): void {
  const p = fixture(rel)
  if (UPDATE) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
    return
  }
  expect(fs.existsSync(p), `${rel} is missing — run UPDATE_CHAT_FIXTURES=1`).toBe(true)
  expect(fs.readFileSync(p, 'utf8'), rel).toBe(content)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('gemini chat golden fixtures', () => {
  it('inputs are what the synthetic builders produce (checked in, never real sessions)', () => {
    for (const [name, body] of Object.entries(INPUTS)) golden(`inputs/${name}`, body)
  })

  it('no orphan files: inputs/ and expected/ hold exactly the generated set', () => {
    const listing = (dir: string): string[] => (fs.existsSync(fixture(dir)) ? fs.readdirSync(fixture(dir)).sort() : [])
    const expected = Object.keys(INPUTS).map((n) => n.replace(/\.jsonl$/, '.page.json')).sort()
    if (UPDATE) {
      for (const f of listing('expected')) if (!expected.includes(f)) fs.rmSync(fixture(`expected/${f}`))
      for (const f of listing('inputs')) if (!(f in INPUTS)) fs.rmSync(fixture(`inputs/${f}`))
      return
    }
    expect(listing('inputs')).toEqual(Object.keys(INPUTS).sort())
    expect(listing('expected')).toEqual(expected)
    expect(fs.readdirSync(DIR).sort()).toEqual(['README.md', 'expected', 'inputs'])
  })

  for (const name of Object.keys(INPUTS)) {
    const base = name.replace(/\.jsonl$/, '')
    it(`${base}: the served page matches expected/${base}.page.json`, async () => {
      // Served through the REAL producer — the phone's `chat.page` path (`readChatTranscript`, paged,
      // the default tail request) with the real locator over a scratch GEMINI_CLI_HOME — so the
      // fixture pins what the wire carries, not a second implementation of it.
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-gemini-fixtures-'))
      try {
        const chats = path.join(home, '.gemini', 'tmp', 'fixture', 'chats')
        fs.mkdirSync(chats, { recursive: true })
        fs.copyFileSync(fixture(`inputs/${name}`), path.join(chats, `session-2026-09-28T10-00-${SID.slice(0, 8)}.jsonl`))
        vi.stubEnv('GEMINI_CLI_HOME', home)
        const page = await readChatTranscript({ sessionId: SID, agentId: 'gemini' }, { maxBytes: CHAT_PAGE_DEFAULT_BYTES }, {})
        const parsed = chatFromGemini(fs.readFileSync(fixture(`inputs/${name}`), 'utf8'))
        // The pure parser and the served page agree; the page adds only the paging constants.
        const { skipped, model, messages } = parsed
        expect(page).toStrictEqual({
          messages,
          found: true,
          olderCursor: null,
          unmatchedResults: [],
          ...(model !== undefined ? { model } : {})
        })
        golden(`expected/${base}.page.json`, serialize({ page, skipped }))
      } finally {
        fs.rmSync(home, { recursive: true, force: true })
      }
    })
  }
})
