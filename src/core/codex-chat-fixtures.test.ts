// Golden fixtures for the CODEX half of the mobile chat view's parser port
// (src/shared/chat-fixtures/codex/). Same contract as chat-fixtures.test.ts for claude: the TS
// reader is the REFERENCE, `nodeterm-ios` keeps a byte-identical copy of the directory, and its
// Swift port must reproduce every `expected/*.pages.json` from the same inputs. This file is both
// the drift test and the regenerator:
//
//   UPDATE_CHAT_FIXTURES=1 npx vitest run src/core/codex-chat-fixtures.test.ts
//
// Inputs are SYNTHETIC (codex-rollout-fake.ts), in the record shapes measured on real rollouts —
// never slices of real ones. See codex/README.md for what each fixture pins.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readChatWindow, type ChatWindowParse } from './transcript-reader'
import { parseCodexChatWindow, resetCodexRolloutCacheForTests } from './codex-chat'
import { readChatTranscript } from './transcript-ipc'
import { CHAT_PAGE_DEFAULT_BYTES, CHAT_PAGE_MAX_BYTES } from '../shared/chat-page'
import {
  CODEX_SID,
  agentMessageEvent,
  agentMessageItem,
  assistantText,
  commandExecutionItem,
  compacted,
  contextCompactionItem,
  customToolCall,
  customToolOutput,
  extensionItem,
  fileChangeItem,
  functionCall,
  functionOutput,
  injectedContext,
  interAgentMeta,
  reasoning,
  reasoningItem,
  riAgentMessage,
  riMessage,
  rollout,
  sessionMeta,
  subAgentActivityItem,
  taskComplete,
  taskFailed,
  taskStarted,
  threadSettingsApplied,
  tokenCount,
  tokenUsageRecord,
  toolSearchCall,
  toolSearchOutput,
  turnAborted,
  turnContext,
  userMessageEvent,
  userMessageItem,
  worldState,
  type CodexRec
} from './codex-rollout-fake'

const DIR = path.join(__dirname, '..', 'shared', 'chat-fixtures', 'codex')
const UPDATE = process.env.UPDATE_CHAT_FIXTURES === '1'
if (UPDATE && process.env.CI) throw new Error('UPDATE_CHAT_FIXTURES must not be set in CI')

// ── The phone's pager — identical to claude's (chat-fixtures.test.ts), only the parser differs ────
const TAIL_BYTES = 262144
const OLDER_BYTES = 524288
const GROWTH = 4
const MAX_BYTES = 5242880

interface PageStep {
  before: number | null
  maxBytes: number
  grownMaxBytes: number
  start: number
  parse: ChatWindowParse
}

async function pageFile(file: string): Promise<PageStep[]> {
  const steps: PageStep[] = []
  let before: number | null = null
  let maxBytes = TAIL_BYTES
  for (;;) {
    let m = maxBytes
    let w = await readChatWindow(file, { before, maxBytes: m })
    if (!w) throw new Error(`unreadable fixture ${file}`)
    let parse = parseCodexChatWindow(w.data, w.start)
    while (parse.noCompleteLine && w.start !== 0 && m < MAX_BYTES) {
      m = Math.min(MAX_BYTES, m * GROWTH)
      w = await readChatWindow(file, { before, maxBytes: m })
      if (!w) throw new Error(`unreadable fixture ${file}`)
      parse = parseCodexChatWindow(w.data, w.start)
    }
    steps.push({ before, maxBytes, grownMaxBytes: m, start: w.start, parse })
    if (parse.olderCursor === null) return steps
    if (steps.length > 64) throw new Error('pager did not terminate')
    before = parse.olderCursor
    maxBytes = OLDER_BYTES
  }
}

// ── Synthetic rollouts ───────────────────────────────────────────────────────────────────────────
const LOREM = 'lorem ipsum dolor sit amet '

/** `n` deterministic ~1 KB turns (paginated shape). */
function filler(n: number, tag: string): CodexRec[] {
  const out: CodexRec[] = []
  for (let i = 0; i < n; i++) {
    out.push(userMessageItem([`${tag} question ${i}`]), assistantText(`${tag} answer ${i}: ` + LOREM.repeat(36)))
  }
  return out
}

/** Legacy format (codex ≤ 0.146): no `ordinal`, the typed prompt in `event_msg/user_message`, and the
 *  UI's `event_msg/agent_message` copies of every assistant message. */
function legacyTurns(): string {
  return rollout(
    [
      sessionMeta('legacy'),
      taskStarted(),
      turnContext('gpt-5.5'),
      ...injectedContext(),
      userMessageEvent('Why does `npm test` fail on CI?'),
      riMessage('user', ['Why does `npm test` fail on CI?']),
      reasoning(),
      agentMessageEvent('Let me run the suite first.', 'commentary'),
      assistantText('Let me run the suite first.', 'commentary'),
      functionCall('call_legacy_1', 'exec_command', { cmd: 'npm test', workdir: '/srv/demo', max_output_tokens: 4000 }),
      functionOutput(
        'call_legacy_1',
        'Chunk ID: 3fa9\nWall time: 4.2 seconds\nProcess exited with code 1\nOriginal token count: 58\nOutput:\n\nFAIL src/app.test.ts\n  ✕ renders the header (12 ms)\n  ✓ loads config\n\nTests: 1 failed, 1 passed'
      ),
      functionCall('call_legacy_2', 'write_stdin', { session_id: 7, chars: 'q', yield_time_ms: 500 }),
      functionOutput('call_legacy_2', 'Chunk ID: 3fb0\nWall time: 0.5 seconds\nProcess exited with code 0\nOriginal token count: 0\nOutput:\n'),
      tokenCount(),
      agentMessageEvent('The header test fails because the fixture date is in UTC.'),
      assistantText('The header test fails because the fixture date is in UTC.\n\n- fix: pin the timezone\n- or: compare dates, not strings'),
      taskComplete('The header test fails because the fixture date is in UTC.')
    ],
    'legacy'
  )
}

/** Paginated format (codex ≥ 0.151): `ordinal` on every line, the typed prompt as an `item_completed`
 *  `UserMessage`, and every other thread item beside the model stream. */
function paginatedTurns(): string {
  const js = 'const r = await tools.exec_command({cmd:"rg -n TODO src"})\ntext(r.output)'
  return rollout([
    sessionMeta('paginated'),
    worldState(),
    threadSettingsApplied(),
    taskStarted(),
    turnContext('gpt-5.6-sol', 'medium'),
    ...injectedContext(),
    riMessage('user', ['Şu ekran görüntüsündeki hatayı düzelt 🙏', '<image name=[Image #1] path="/tmp/shot.png">', { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }, '</image>']),
    userMessageItem(['Şu ekran görüntüsündeki hatayı düzelt 🙏', { type: 'local_image', path: '/tmp/shot.png' }]),
    reasoning(),
    reasoningItem(),
    assistantText('I will look for the TODO first.', 'commentary'),
    agentMessageItem('I will look for the TODO first.', 'commentary'),
    customToolCall('call_pg_1', 'exec', `  ${js}\n`),
    customToolOutput('call_pg_1', [
      { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'input_text', text: 'src/app.ts:12: // TODO: handle empty header\nsrc/app.ts:40: // TODO: i18n' }
    ]),
    commandExecutionItem(),
    customToolCall('call_pg_2', 'exec', 'const img = await tools.view_image({path:"/tmp/shot.png"})\nimage(img)'),
    customToolOutput('call_pg_2', [
      { type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' },
      { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }
    ]),
    toolSearchCall('call_pg_3', 'calendar events'),
    toolSearchOutput('call_pg_3'),
    functionCall('call_pg_4', 'spawn_agent', { task_name: 'review', message: 'Review the header fix for regressions.' }, 'collaboration'),
    functionOutput('call_pg_4', '{"task_name":"review"}'),
    functionCall('call_pg_5', 'wait', { cell_id: 3, yield_time_ms: 30000, max_tokens: 2000 }),
    functionOutput('call_pg_5', [{ type: 'input_text', text: 'Script running with cell ID 3\nWall time 30.0 seconds\nOutput:\n' }]),
    functionCall('call_pg_6', 'sleep', { duration_ms: 5000 }, 'clock'),
    functionOutput('call_pg_6', 'Wall time: 5.0 seconds\nslept'),
    extensionItem(),
    interAgentMeta(),
    riAgentMessage('/root/review', '/root', 'No regressions found.'),
    subAgentActivityItem(),
    fileChangeItem(),
    tokenUsageRecord(),
    tokenCount(),
    assistantText('Fixed.\n\n```ts\nconst header = title ?? "Untitled"\n```\n\n> The i18n TODO is left for later.'),
    agentMessageItem('Fixed.'),
    taskComplete('Fixed.')
  ])
}

/** A turn that failed (the only place codex says why) and one the user interrupted. */
function errorsAndAborts(): string {
  return rollout([
    turnContext('gpt-5.6-sol'),
    userMessageItem(['Summarise the diff']),
    taskFailed("You've hit your usage limit. Upgrade to Pro or try again later."),
    userMessageItem(['Try again']),
    assistantText('Working on it.', 'commentary'),
    turnAborted('interrupted'),
    riMessage('developer', ['<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>']),
    taskFailed(''),
    turnAborted('x'.repeat(101))
  ])
}

/** Compaction: history before it stays readable — the rollout is append-only. */
function compaction(): string {
  return rollout([
    userMessageItem(['First question']),
    assistantText('First answer.'),
    compacted(),
    contextCompactionItem(),
    userMessageItem(['After compaction']),
    assistantText('Still here.')
  ])
}

/** A call in the OLDER page whose output lands in the tail: carried in `unmatchedResults`. */
function toolsCrossPage(): string {
  return rollout([
    userMessageItem(['Run the long migration']),
    functionCall('call_cross_1', 'exec_command', { cmd: 'npm run migrate -- --all' }),
    ...filler(270, 'mid'),
    functionOutput('call_cross_1', 'Chunk ID: 9\nWall time: 812.0 seconds\nProcess exited with code 0\nOriginal token count: 4\nOutput:\nmigrated 1204 rows\ndone'),
    functionCall('call_cross_2', 'exec_command', { cmd: 'git status --short' }),
    functionOutput('call_cross_2', 'Output:\n M db/schema.sql'),
    assistantText('Migration complete.')
  ])
}

/** The newest turn_context answers model AND effort. */
function modelEffort(): string {
  return rollout([
    turnContext('gpt-5.5', 'high'),
    userMessageItem(['one']),
    assistantText('a'),
    turnContext('gpt-5.6-sol', 'medium'),
    userMessageItem(['two']),
    assistantText('b')
  ])
}

/** The newest turn_context states no effort: the key is ABSENT, never carried from the older one. */
function modelEffortNoCarry(): string {
  return rollout([turnContext('gpt-5.5', 'high'), userMessageItem(['one']), turnContext('gpt-5.6-sol'), assistantText('b')])
}

/** A model name over the 100-unit cap is absent; an effort of exactly 100 units is kept. */
function modelEffortCap(): string {
  return rollout([turnContext('m'.repeat(101), 'e'.repeat(100)), assistantText('x')])
}

/** Lines another program wrote: each costs one line, never the page. */
function malformed(): string {
  return (
    'not json at all\n' +
    'null\n' +
    '[1,2]\n' +
    '"a string"\n' +
    '{"timestamp":"2026-09-24T09:00:00.000Z","type":"response_item","payload":null}\n' +
    '{"timestamp":"2026-09-24T09:00:00.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":"not an array"}}}\n' +
    '{"timestamp":"2026-09-24T09:00:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[null,7,{"type":"output_text","text":5}]}}\n' +
    '{"timestamp":"not a date","type":"event_msg","payload":{"type":"user_message","message":"no timestamp survives"}}\n' +
    '{"timestamp":"2026-09-24T09:00:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{not json","call_id":"c1"}}\n' +
    '{"timestamp":"2026-09-24T09:00:00.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":{"content":"an object is not text"}}}\n' +
    '{"timestamp":"2026-09-24T09:00:00.000Z","type":"brand_new_record","payload":{"type":"from_a_newer_codex"}}\n' +
    rollout([assistantText('The last line still renders.')])
  )
}

/** The last line is a ~600 KB prompt: the 256 KB tail holds no complete line and grows. */
function hugeLastLine(): string {
  return rollout([...filler(4, 'pre'), userMessageItem(['What is in this log? ' + LOREM.repeat(22_500)])])
}

const INPUTS: Record<string, string> = {
  'legacy-turns.jsonl': legacyTurns(),
  'paginated-turns.jsonl': paginatedTurns(),
  'errors-and-aborts.jsonl': errorsAndAborts(),
  'compaction.jsonl': compaction(),
  'tools-cross-page.jsonl': toolsCrossPage(),
  'model-effort.jsonl': modelEffort(),
  'model-effort-no-carry.jsonl': modelEffortNoCarry(),
  'model-effort-cap.jsonl': modelEffortCap(),
  'malformed.jsonl': malformed(),
  'huge-last-line.jsonl': hugeLastLine()
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

// The producer check reads each input under a real rollout NAME (the locator only accepts
// `rollout-*-<thread id>.jsonl`), so every input is copied into a scratch home for it.
let scratch: string
beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-codex-fixtures-'))
})
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

describe('codex chat golden fixtures', () => {
  it('the pager constants are the ones core uses', () => {
    expect(TAIL_BYTES).toBe(CHAT_PAGE_DEFAULT_BYTES)
    expect(MAX_BYTES).toBe(CHAT_PAGE_MAX_BYTES)
    expect(OLDER_BYTES).toBe(2 * TAIL_BYTES)
  })

  it('inputs are what the synthetic builders produce (checked in, never real rollouts)', () => {
    for (const [name, body] of Object.entries(INPUTS)) golden(`inputs/${name}`, body)
  })

  it('no orphan files: the directory holds exactly the generated set', () => {
    const listing = (dir: string): string[] => (fs.existsSync(fixture(dir)) ? fs.readdirSync(fixture(dir)).sort() : [])
    const expected = Object.keys(INPUTS).map((n) => n.replace(/\.jsonl$/, '.pages.json')).sort()
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
    it(`${base}: paged parse matches expected/${base}.pages.json`, async () => {
      const file = fixture(`inputs/${name}`)
      const steps = await pageFile(file)
      // The pager is not a second implementation: every page equals what the real producer
      // (`readChatTranscript` → codex branch → `parseGrowingWindow`) answers for that request.
      const named = path.join(scratch, `rollout-2026-09-24T09-00-00-${CODEX_SID}.jsonl`)
      fs.copyFileSync(file, named)
      resetCodexRolloutCacheForTests()
      for (const s of steps) {
        const served = await readChatTranscript(
          { sessionId: CODEX_SID, agentId: 'codex' },
          s.before === null ? { maxBytes: s.maxBytes } : { before: s.before, maxBytes: s.maxBytes },
          { codexPathFor: () => named }
        )
        const { noCompleteLine: _n, ...rest } = s.parse
        expect(served).toStrictEqual({ found: true, ...rest })
      }
      golden(`expected/${base}.pages.json`, serialize(steps))
    })
  }

  // What the structural fixtures exist to exercise — pinned so a builder edit cannot quietly turn
  // them into ordinary files.
  it('tools-cross-page: the tail carries the older call\'s output; the older page holds the call', async () => {
    const [tail, older] = await pageFile(fixture('inputs/tools-cross-page.jsonl'))
    expect(tail.parse.unmatchedResults).toEqual([{ id: 'call_cross_1', result: 'migrated 1204 rows done' }])
    const call = older.parse.messages.flatMap((m) => m.parts).find((p) => p.kind === 'tool' && p.id === 'call_cross_1')
    expect(call).toMatchObject({ name: 'exec_command', arg: 'npm run migrate -- --all' })
    expect(call).not.toHaveProperty('result')
  })

  it('huge-last-line: the tail grows past its first window and still shows the last message', async () => {
    const [tail] = await pageFile(fixture('inputs/huge-last-line.jsonl'))
    expect(tail.grownMaxBytes).toBeGreaterThan(TAIL_BYTES)
    expect(tail.parse.noCompleteLine).toBe(false)
    expect(JSON.stringify(tail.parse.messages.at(-1))).toContain('What is in this log?')
  })

  it('legacy and paginated: no injected context and no UI duplicate reaches the thread', async () => {
    for (const f of ['legacy-turns', 'paginated-turns']) {
      const [page] = await pageFile(fixture(`inputs/${f}.jsonl`))
      const all = JSON.stringify(page.parse.messages)
      expect(all).not.toContain('AGENTS.md')
      expect(all).not.toContain('environment_context')
      expect(all).not.toContain('<image name=')
      expect(all).not.toContain('No regressions found.')
      const texts = page.parse.messages.flatMap((m) => m.parts).filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text)
      expect(new Set(texts).size).toBe(texts.length)
    }
  })
})
