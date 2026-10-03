// Golden fixtures for the GROK half of the mobile chat view's parser port
// (`src/shared/chat-fixtures/grok/`, README section "Grok"). The TS implementation is the
// REFERENCE: `nodeterm-ios` carries a byte-identical copy and its Swift port must reproduce every
// `expected/*.json` from the same input. This file is both the drift test and the regenerator:
//
//   UPDATE_CHAT_FIXTURES=1 npx vitest run src/core/grok-chat-fixtures.test.ts
//
// Inputs are SYNTHETIC, built below from the record shapes MEASURED on grok 1.0.13 (the real-derived
// `__fixtures__/grok/chat_history.jsonl` plus the record vocabulary compiled into the shipped
// binary). None is a slice of a real session — those carry customer data.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseGrokChat } from './grok-chat'
import { readChatTranscript } from './transcript-ipc'
import { _resetGrokSessionDirsForTests, rememberGrokSessionDir } from './grok-session'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { CHAT_PAGE_DEFAULT_BYTES } from '../shared/chat-page'

const DIR = path.join(__dirname, '..', 'shared', 'chat-fixtures', 'grok')
const UPDATE = process.env.UPDATE_CHAT_FIXTURES === '1'
// Regenerating in CI would turn the drift test into a no-op that always passes.
if (UPDATE && process.env.CI) throw new Error('UPDATE_CHAT_FIXTURES must not be set in CI')

const SID = '01a06126-b981-73f1-8b68-4547e4d7da84'
/** The phone's first (and, for grok, only) request: the default tail. */
const REQUEST = { maxBytes: CHAT_PAGE_DEFAULT_BYTES }

// ── Synthetic records, in the measured shapes ────────────────────────────────────────────────────
type Rec = Record<string, unknown>
const system = (content: string): Rec => ({ type: 'system', content })
const user = (text: string, extra: Rec = {}): Rec => ({ type: 'user', content: [{ type: 'text', text }], ...extra })
const typed = (text: string, promptIndex: number): Rec => user(text, { prompt_index: promptIndex })
const injected = (reason: string, text: string, extra: Rec = {}): Rec => user(text, { synthetic_reason: reason, ...extra })
const assistant = (content: string, extra: Rec = {}): Rec => ({
  type: 'assistant',
  content,
  model_id: 'grok-4.6-build',
  model_fingerprint: 'fp_0000000000synthetic',
  reasoning_effort: 'xhigh',
  ...extra
})
const call = (id: string, name: string, args: unknown): Rec => ({
  id,
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args)
})
const result = (id: string, content: unknown): Rec => ({ type: 'tool_result', tool_call_id: id, content })
const reasoning = (id: string, summary: string[]): Rec => ({
  type: 'reasoning',
  id,
  summary: summary.map((text) => ({ type: 'summary_text', text })),
  encrypted_content: 'gAAAAABsyntheticSyntheticSynthetic==',
  status: 'completed'
})
const webSearch = (id: string, query: unknown): Rec => ({
  type: 'backend_tool_call',
  kind: {
    tool_type: 'web_search',
    action: {
      type: 'search',
      ...(query === undefined ? {} : { query }),
      sources: [{ type: 'url', url: 'https://example.com/a' }, { type: 'url', url: 'https://example.com/b' }]
    }
  },
  id,
  status: 'completed'
})
const jl = (...rows: Array<Rec | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'

function plainTurns(): string {
  return jl(
    system('You are a synthetic coding agent. Follow the rules.\n\n# Rules\n- be brief'),
    typed('Explain the **plan**:\n\n1. read\n2. write', 0),
    assistant('## Plan\n\n- Read `a.ts`\n- Then write\n\n```ts\nconst x = 1\n```\n\n> quoted'),
    // Two text items in one user record are joined with a newline.
    user('first half', { prompt_index: 1, content: [{ type: 'text', text: 'first half' }, { type: 'text', text: 'second half' }] }),
    // A string content (the shape `system` and `assistant` use) is read the same way.
    { type: 'user', content: 'a string-content prompt', prompt_index: 2 },
    typed('Türkçe karakterler: ğüşiöç — 中文 — emoji 🧪', 3),
    assistant('Tamam ✓ 🧪')
  )
}

function tools(): string {
  return jl(
    typed('look around', 0),
    assistant('Reading the project.', {
      tool_calls: [
        call('call-00000001', 'read_file', { target_file: '/srv/app/src/a.ts' }),
        call('call-00000002', 'list_dir', { target_directory: '/srv/app/src' }),
        call('call-00000003', 'run_terminal_cmd', { command: 'npm test -- --run', is_background: false }),
        call('call-00000004', 'search_replace', { file_path: '/srv/app/b.ts', old_string: 'x', new_string: 'y' }),
        call('call-00000005', 'grep', { pattern: 'TODO', path: '/srv/app' }),
        // No salient key: the raw arguments text, capped at 200 UTF-16 units.
        call('call-00000006', 'future_tool', { knob: 'k'.repeat(260) }),
        // Arguments that are not JSON: shown as written.
        call('call-00000007', 'odd_tool', 'not json at all')
      ]
    }),
    result('call-00000001', 'line one\nline two\nline three\nline four'),
    result('call-00000002', 'a.ts\nb.ts'),
    result('call-00000003', 'r'.repeat(700)),
    result('call-00000004', ''),
    // An orphan result (no call declares this id) is dropped, never a speaker-less bubble.
    result('call-99999999', 'orphan'),
    assistant('Done: tests pass.')
  )
}

function syntheticNotes(): string {
  return jl(
    injected('project_instructions', '# AGENTS.md\nUse tabs.'),
    injected('system_reminder', 'Remember to update the todo list.'),
    typed('real prompt', 0),
    assistant('working on it'),
    injected('task_completed', 'Background task t-1 finished.', { prompt_index: 1 }),
    injected('subagent_completed', 'Subagent explore-1 returned.'),
    injected('permission_rejected', 'The user rejected run_terminal_cmd.'),
    injected('compaction_meta', 'Summary of the conversation so far: the user asked for a plan.'),
    // A blank reason is no reason: the line is read as typed.
    injected('   ', 'blank reason reads as the user')
  )
}

function backendAndReasoning(): string {
  return jl(
    typed('search the web', 0),
    reasoning('rs_00000001', ['Considering the query.']),
    reasoning('rs_00000002', []),
    webSearch('ws_00000001', 'nodeterm canvas terminal manager'),
    webSearch('ws_00000002', undefined),
    assistant('Found two sources.')
  )
}

function modelEffort(): string {
  return jl(
    typed('go', 0),
    assistant('first', { model_id: 'grok-4.6-build', reasoning_effort: 'medium' }),
    typed('again', 1),
    assistant('second', { model_id: 'grok-4.6', reasoning_effort: 'high' })
  )
}

function modelEffortNoCarry(): string {
  const { reasoning_effort: _dropped, ...noEffort } = assistant('newest states no effort', { model_id: 'grok-code-fast' })
  return jl(typed('go', 0), assistant('older', { reasoning_effort: 'xhigh' }), noEffort)
}

function modelEffortCap(): string {
  // 100 UTF-16 units is kept, 101 is not (JS `.length`; Swift `utf16.count`).
  return jl(typed('go', 0), assistant('capped', { model_id: '\u{1F9EA}'.repeat(50), reasoning_effort: 'e'.repeat(101) }))
}

function skippedLines(): string {
  return jl(
    '{"type":"user","content":[{"type":"text","text":"truncat',
    '42',
    'null',
    '[1,2,3]',
    '   ',
    JSON.stringify({ type: 'some_future_record', content: 'never rendered' }),
    typed('the one line that survives', 0)
  )
}

function reasoningOnly(): string {
  // A session whose history holds nothing renderable yet: FOUND, with no messages.
  return jl(reasoning('rs_00000001', ['thinking']), reasoning('rs_00000002', []))
}

const INPUTS: Record<string, string> = {
  'plain-turns.jsonl': plainTurns(),
  'tools.jsonl': tools(),
  'synthetic-notes.jsonl': syntheticNotes(),
  'backend-and-reasoning.jsonl': backendAndReasoning(),
  'model-effort.jsonl': modelEffort(),
  'model-effort-no-carry.jsonl': modelEffortNoCarry(),
  'model-effort-cap.jsonl': modelEffortCap(),
  'skipped-lines.jsonl': skippedLines(),
  'reasoning-only.jsonl': reasoningOnly()
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
  expect(fs.existsSync(p), `grok/${rel} is missing — run UPDATE_CHAT_FIXTURES=1`).toBe(true)
  expect(fs.readFileSync(p, 'utf8'), `grok/${rel}`).toBe(content)
}

let home: string
let sessionDir: string
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-grok-fixtures-'))
  sessionDir = path.join(home, '.grok', 'sessions', '%2Fsrv%2Fapp', SID)
  fs.mkdirSync(sessionDir, { recursive: true })
})
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))
beforeEach(() => {
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  initPlatform(fakePlatform())
  _resetGrokSessionDirsForTests()
})
afterEach(() => {
  vi.restoreAllMocks()
  resetPlatformForTests()
  _resetGrokSessionDirsForTests()
})

describe('grok chat golden fixtures', () => {
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
  })

  for (const [name, body] of Object.entries(INPUTS)) {
    const base = name.replace(/\.jsonl$/, '')
    it(`${base}: parse + served page match expected/${base}.page.json`, async () => {
      // The page is what the REAL producer serves: the local leg over a real session directory…
      fs.writeFileSync(path.join(sessionDir, 'chat_history.jsonl'), body)
      rememberGrokSessionDir(SID, sessionDir)
      const page = await readChatTranscript({ sessionId: SID, agentId: 'grok' }, REQUEST, {})
      // …and the remote leg (the host's text through `readRemoteGrok`) serves the identical page.
      const remote = await readChatTranscript(
        { sessionId: SID, nodeId: 'n-remote', agentId: 'grok', remoteOnly: true },
        REQUEST,
        { readRemoteGrok: async () => ({ ok: true, text: body }) }
      )
      expect(remote).toStrictEqual(page)
      const parse = parseGrokChat(body)
      expect(page.messages).toStrictEqual(parse.messages)
      golden(`expected/${base}.page.json`, serialize({ request: REQUEST, parse, page }))
    })
  }

  it('tools: a salient argument names the call, the rest fall back to the raw text', () => {
    const tools = parseGrokChat(INPUTS['tools.jsonl']).messages[1].parts
    expect(tools.map((p) => (p.kind === 'tool' ? p.arg : null))).toEqual([
      null,
      '/srv/app/src/a.ts',
      '/srv/app/src',
      'npm test -- --run',
      '/srv/app/b.ts',
      // claude's `toolArg` order: `path` outranks `pattern`.
      '/srv/app',
      JSON.stringify({ knob: 'k'.repeat(260) }).slice(0, 200),
      'not json at all'
    ])
  })

  it('model-effort-no-carry: the newest record states no effort, so the key is ABSENT', () => {
    const p = parseGrokChat(INPUTS['model-effort-no-carry.jsonl'])
    expect(p.model).toBe('grok-code-fast')
    expect('effort' in p).toBe(false)
  })

  it('skipped-lines: five lines could not be mapped, and only the typed prompt renders', () => {
    const p = parseGrokChat(INPUTS['skipped-lines.jsonl'])
    expect(p.skipped).toBe(5)
    expect(p.messages).toHaveLength(1)
  })
})
