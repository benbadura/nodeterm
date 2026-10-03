// Golden fixtures for the COPILOT chat reader (`core/copilot-chat.ts`), for the phone's Swift port
// (phase B). Same contract as the claude set in `src/shared/chat-fixtures/` — see the README there,
// section "Copilot": the TS code is the reference, `nodeterm-ios` keeps a byte-identical copy of
// `src/shared/chat-fixtures/copilot/`, and its port must reproduce every `expected/*.pages.json`.
//
//   UPDATE_CHAT_FIXTURES=1 npx vitest run src/core/copilot-chat-fixtures.test.ts
//
// rewrites `copilot/inputs/` and `copilot/expected/`. Without the variable every file must already
// equal what this code produces.
//
// Inputs are SYNTHETIC, built below in the event shapes MEASURED on copilot 1.0.88 (a real CLI run
// against a local fake model) and its own `session-events.schema.json`. None is a slice of a real
// session journal — those carry customer data.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readChatWindow, type ChatWindowParse } from './transcript-reader'
import { parseCopilotChatWindow } from './copilot-chat'
import { readChatTranscript } from './transcript-ipc'
import { CHAT_PAGE_DEFAULT_BYTES, CHAT_PAGE_MAX_BYTES } from '../shared/chat-page'

const DIR = path.join(__dirname, '..', 'shared', 'chat-fixtures', 'copilot')
const UPDATE = process.env.UPDATE_CHAT_FIXTURES === '1'
if (UPDATE && process.env.CI) throw new Error('UPDATE_CHAT_FIXTURES must not be set in CI')

// ── The phone's pager — identical to the claude set's, with copilot's window parser ──────────────
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
    let parse = parseCopilotChatWindow(w.data, w.start)
    while (parse.noCompleteLine && w.start !== 0 && m < MAX_BYTES) {
      m = Math.min(MAX_BYTES, m * GROWTH)
      w = await readChatWindow(file, { before, maxBytes: m })
      if (!w) throw new Error(`unreadable fixture ${file}`)
      parse = parseCopilotChatWindow(w.data, w.start)
    }
    steps.push({ before, maxBytes, grownMaxBytes: m, start: w.start, parse })
    if (parse.olderCursor === null) return steps
    if (steps.length > 64) throw new Error('pager did not terminate')
    before = parse.olderCursor
    maxBytes = OLDER_BYTES
  }
}

// ── Synthetic events, in the measured envelope ───────────────────────────────────────────────────
const SID = '7c1d8e0f-4b32-4e61-9a24-5f0c2a9e3b7d'
const T0 = Date.parse('2026-09-28T20:35:16.000Z')
const SUB_AGENT = '59ead169-ca66-48ea-b9eb-0e5f14ecf82c'

type Rec = Record<string, unknown>
/** An event before it is numbered: its type, its `data`, and envelope extras (`agentId`). */
interface Ev {
  type: string
  data: Rec
  extra?: Rec
}
const e = (type: string, data: Rec, extra?: Rec): Ev => ({ type, data, ...(extra ? { extra } : {}) })

const uuid = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
/** One JSONL line, keys in the measured order: type, data, [agentId], id, timestamp, parentId. */
function line(ev: Ev, i: number): string {
  return (
    JSON.stringify({
      type: ev.type,
      data: ev.data,
      ...(ev.extra ?? {}),
      id: uuid(i),
      timestamp: new Date(T0 + i * 1000).toISOString(),
      parentId: i === 0 ? null : uuid(i - 1)
    }) + '\n'
  )
}
const jsonl = (evs: Ev[]): string => evs.map((ev, i) => line(ev, i)).join('')

const start = (): Ev =>
  e('session.start', {
    sessionId: SID,
    version: 1,
    producer: 'copilot-agent',
    copilotVersion: '1.0.88',
    startTime: '2026-09-28T20:35:15.853Z',
    selectedModel: 'gpt-5.5',
    contextTier: null,
    context: { cwd: '/srv/demo', gitRoot: '/srv/demo', branch: 'main' },
    alreadyInUse: false,
    remoteSteerable: false
  })
let msgSeq = 0
const user = (content: string, more: Rec = {}): Ev =>
  e('user.message', {
    content,
    transformedContent: `<current_datetime>2026-09-28T23:35:16.459+03:00</current_datetime>\n\n${content}`,
    messageId: `msg-user-${msgSeq++}`,
    supportedNativeDocumentMimeTypes: [],
    delivery: 'idle',
    interactionId: 'interaction-1',
    turnId: '0',
    ...more
  })
const system = (): Ev =>
  e('system.message', {
    role: 'system',
    content: 'You are a SYNTHETIC system prompt standing in for the real ~21K-character one.',
    contentBlocks: [{ content: 'You are a SYNTHETIC system prompt', isStatic: true }],
    interactionId: 'interaction-1'
  })
const turnStart = (turnId = '0'): Ev => e('assistant.turn_start', { turnId, interactionId: 'interaction-1' })
const turnEnd = (turnId = '0'): Ev => e('assistant.turn_end', { turnId })
const req = (toolCallId: string, name: string, args: unknown, toolTitle?: string): Rec => ({
  toolCallId,
  name,
  arguments: args,
  type: typeof args === 'string' ? 'custom' : 'function',
  ...(toolTitle ? { toolTitle } : {})
})
const asst = (content: string, toolRequests: Rec[] = [], more: Rec = {}): Ev =>
  e('assistant.message', {
    messageId: `msg-asst-${msgSeq++}`,
    model: 'gpt-5.5',
    content,
    toolRequests,
    interactionId: 'interaction-1',
    turnId: '0',
    rte: false,
    ...more
  })
const toolStart = (toolCallId: string, toolName: string, args: unknown): Ev =>
  e('tool.execution_start', { toolCallId, toolName, arguments: args, turnId: '0', model: 'gpt-5.5' })
const ok = (toolCallId: string, content: string, more: Rec = {}): Ev =>
  e('tool.execution_complete', {
    toolCallId,
    model: 'gpt-5.5',
    interactionId: 'interaction-1',
    turnId: '0',
    rte: false,
    success: true,
    result: { content },
    toolTelemetry: {},
    ...more
  })
const fail = (toolCallId: string, message: string, more: Rec = {}): Ev =>
  e('tool.execution_complete', {
    toolCallId,
    model: 'gpt-5.5',
    interactionId: 'interaction-1',
    turnId: '0',
    rte: false,
    success: false,
    error: { message, code: 'denied' },
    ...more
  })
const shutdown = (): Ev => e('session.shutdown', { shutdownType: 'routine', totalPremiumRequests: 0, currentModel: 'gpt-5.5' })

/** `n` filler turns of ~1 KB each. */
function filler(n: number, tag: string): Ev[] {
  const out: Ev[] = []
  for (let i = 0; i < n; i++) {
    out.push(user(`${tag} question ${i}`), turnStart(), asst(`${tag} turn ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(36)), turnEnd())
  }
  return out
}

/** Deterministic pseudo-random bytes (LCG) as base64 — an incompressible-looking screenshot. */
function pseudoRandomBase64(nBytes: number): string {
  const b = Buffer.alloc(nBytes)
  let x = 0x2545f491
  for (let i = 0; i < nBytes; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    b[i] = x >>> 24
  }
  return b.toString('base64')
}

// ── The fixtures ─────────────────────────────────────────────────────────────────────────────────
function plainTurns(): string {
  return jsonl([
    start(),
    user('How do I list the files here?'),
    system(),
    turnStart(),
    asst('Use `ls`:\n\n```sh\nls -la\n```\n\n- `-l` long form\n- `-a` hidden files\n\n> Tip: `ls -lh` for sizes.'),
    turnEnd(),
    shutdown(),
    e('session.resume', {
      resumeTime: '2026-09-28T20:40:00.000Z',
      eventCount: 7,
      selectedModel: 'gpt-5.5',
      context: { cwd: '/srv/demo', branch: 'main' },
      alreadyInUse: false,
      remoteSteerable: false
    }),
    e('session.model_change', { source: 'startup', contextTier: null, newModel: 'claude-opus-5-5', previousModel: 'gpt-5.5', reasoningEffort: null }),
    user('Şimdi Türkçe: dosyaları göster 📁'),
    turnStart(),
    asst('Tamam — `ls` yeterli. 👍', [], { model: 'claude-opus-5-5' }),
    asst('Second message in the same turn.', [], { model: 'claude-opus-5-5' }),
    turnEnd(),
    e('session.usage_checkpoint', { totalNanoAiu: 0, totalPremiumRequests: 0 })
  ])
}

function tools(): string {
  return jsonl([
    start(),
    user('Inspect the repo'),
    turnStart(),
    asst('Let me look.', [
      req('call_bash', 'bash', { command: 'git status --short', description: 'Show status', mode: 'sync', initial_wait: 10 }, 'Running command'),
      req('call_view', 'view', { path: '/srv/demo/missing.txt' }, 'Viewing file'),
      req('call_create', 'create', { path: '/srv/demo/new.txt', file_text: 'body\n' }, 'Creating file'),
      req('call_edit', 'edit', { path: '/srv/demo/a.ts', old_str: 'a', new_str: 'b' }, 'Editing file'),
      req('call_grep', 'grep', { pattern: 'TODO', paths: ['src'], output_mode: 'content' }),
      req('call_sql', 'sql', { description: 'Count todos', query: 'select count(*) from todos' }),
      req('call_patch', 'apply_patch', '*** Begin Patch\n*** Update File: a.ts\n*** End Patch'),
      req('call_read_bash', 'read_bash', { shellId: '0', delay: 5 }),
      req('call_long', 'web_fetch', { url: 'https://example.test/' + 'p'.repeat(250) })
    ]),
    toolStart('call_bash', 'bash', { command: 'git status --short' }),
    e('permission.requested', {
      requestId: 'perm-1',
      permissionRequest: { kind: 'read', toolCallId: 'call_view', intention: 'Read file', path: '/srv/demo/missing.txt' },
      agentMode: 'interactive',
      permissionMode: 'manual'
    }),
    e('permission.completed', { requestId: 'perm-1', toolCallId: 'call_view', result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' } }),
    fail('call_view', 'Permission denied and could not request permission from user'),
    ok('call_bash', ' M src/a.ts\n?? new.txt\n?? other.txt\n?? fourth.txt\n<shellId: 0 completed with exit code 0>', { shellExecution: { exitCode: 0 } }),
    ok('call_create', 'Created file /srv/demo/new.txt with 5 characters', { result: { content: 'Created file /srv/demo/new.txt with 5 characters', detailedContent: '\ndiff --git a/new.txt b/new.txt\n+body\n' } }),
    ok('call_edit', ''),
    ok('call_grep', 'src/a.ts:1: // TODO ' + 'x'.repeat(600)),
    // A failure that states no error message falls back to the result's own content.
    e('tool.execution_complete', { toolCallId: 'call_sql', success: false, result: { content: 'no such table: todos' } }),
    ok('call_patch', 'Patch applied'),
    ok('call_read_bash', 'still running'),
    turnEnd(),
    turnStart('1'),
    asst('Done inspecting.'),
    turnEnd('1')
  ])
}

function toolsCrossPage(): string {
  // The call lands in the OLDER page, its completion in the 256 KB tail: the tail carries the result
  // in `unmatchedResults`, the older page carries the tool part with its `id`.
  return jsonl([
    start(),
    user('Run the long job'),
    turnStart(),
    asst('Starting the long job.', [req('call_long_job', 'bash', { command: './long-job.sh', description: 'Long job' })]),
    toolStart('call_long_job', 'bash', { command: './long-job.sh' }),
    ...filler(125, 'meanwhile'),
    ok('call_long_job', 'job finished\nexit 0'),
    turnStart('1'),
    asst('The long job finished.', [req('call_tail', 'bash', { command: 'echo tail' })]),
    ok('call_tail', 'tail'),
    turnEnd('1')
  ])
}

function subagent(): string {
  const sub = { agentId: SUB_AGENT }
  return jsonl([
    start(),
    user('delegate please'),
    turnStart(),
    asst('Delegating.', [req('call_task', 'task', { description: 'Explore synthetic', prompt: 'Find the synthetic things', agent_type: 'explore', name: 'synth-explorer', mode: 'sync' })]),
    toolStart('call_task', 'task', { description: 'Explore synthetic' }),
    e('subagent.started', { toolCallId: 'call_task', agentName: 'explore', agentDisplayName: 'synth-explorer', agentDescription: 'Explore synthetic', model: 'gpt-5.5-mini' }, sub),
    e('subagent.configured', { model: 'gpt-5.5-mini', reasoningEffort: 'low', multiTurn: true }, sub),
    e('session.model_change', { source: 'agent', contextTier: null, newModel: 'gpt-5.5-mini', reasoningEffort: 'low' }, sub),
    e('user.message', { content: 'Find the synthetic things', source: `agent-${SID}`, messageId: 'sub-user', turnId: '0' }, sub),
    e('assistant.turn_start', { turnId: '0', interactionId: 'sub-interaction' }, sub),
    e('assistant.message', { messageId: 'sub-a', model: 'gpt-5.5-mini', content: 'Sub-agent looking.', toolRequests: [req('call_sub_bash', 'bash', { command: 'echo sub-agent' })], parentToolCallId: 'call_task' }, sub),
    e('tool.execution_start', { toolCallId: 'call_sub_bash', toolName: 'bash', arguments: { command: 'echo sub-agent' }, parentToolCallId: 'call_task' }, sub),
    e('tool.execution_complete', { toolCallId: 'call_sub_bash', success: true, result: { content: 'sub-agent' }, parentToolCallId: 'call_task' }, sub),
    e('assistant.message', { messageId: 'sub-b', model: 'gpt-5.5-mini', content: 'Sub-agent final answer.', toolRequests: [], parentToolCallId: 'call_task' }, sub),
    e('assistant.turn_end', { turnId: '0' }, sub),
    e('subagent.completed', { toolCallId: 'call_task', agentName: 'explore', agentDisplayName: 'synth-explorer', model: 'gpt-5.5-mini', totalToolCalls: 1 }, sub),
    ok('call_task', 'Sub-agent final answer.'),
    turnEnd(),
    turnStart('1'),
    asst('Main done.'),
    turnEnd('1')
  ])
}

function notices(): string {
  return jsonl([
    start(),
    user('trigger an error'),
    turnStart(),
    turnEnd(),
    e('session.error', { errorType: 'query', message: '400 synthetic upstream failure', statusCode: 400 }),
    user('slow one'),
    turnStart(),
    turnEnd(),
    e('abort', { reason: 'user_initiated' }),
    e('session.warning', { warningType: 'mcp', message: 'An MCP server is slow to start' }),
    e('session.info', { infoType: 'tip', message: 'Press ctrl+s to stash a prompt' }),
    e('session.compaction_start', { systemTokens: 4601, conversationTokens: 4112, currentTokens: 14377, tokenLimit: 16000, trigger: 'threshold' }),
    e('session.compaction_complete', { success: true, preCompactionTokens: 14377, postCompactionTokens: 1200, messagesRemoved: 3, summaryContent: 'SYNTHETIC COMPACTION SUMMARY', checkpointNumber: 1 }),
    e('system.notification', { content: '<system_notification>Shell 0 completed</system_notification>', kind: { type: 'shell_completed', shellId: '0', exitCode: 0 } }),
    e('skill.invoked', { name: 'pdf', path: '/skills/pdf/SKILL.md', content: 'SYNTHETIC SKILL BODY', trigger: 'agent-invoked' }),
    e('session.context_cleared', { messagesCleared: 4 }),
    e('session.task_complete', { summary: 'SYNTHETIC TASK SUMMARY', success: true }),
    e('session.plan_changed', { operation: 'create' }),
    e('session.mode_changed', { previousMode: 'interactive', newMode: 'plan' }),
    e('hook.start', { hookType: 'preToolUse' }),
    e('hook.end', { hookType: 'preToolUse', success: true }),
    e('session.binary_asset', { assetId: 'asset-1', type: 'image', mimeType: 'image/png', byteLength: 3, data: 'AAAA' }),
    e('some.future_event', { anything: 'a type a newer CLI might add' }),
    user('still here'),
    turnStart(),
    asst('Recovered.'),
    turnEnd()
  ])
}

function hiddenPrompts(): string {
  return jsonl([
    start(),
    user('typed by the human'),
    user('typed, source user', { source: 'user' }),
    user('SYNTHETIC SKILL INJECTION', { source: 'skill-pdf' }),
    user('SYNTHETIC INTER-AGENT PROMPT', { source: 'agent-5f0c2a9e' }),
    user('ran a slash command', { source: 'command-review' }),
    user('a scheduled prompt fired', { source: 'schedule-every-10m' }),
    user('autopilot objective', { source: 'autopilot-objective' }),
    user('', { agentMode: 'autopilot', isAutopilotContinuation: true }),
    user('   \n  '),
    user('steered while busy', { delivery: 'steering' }),
    user('with an attachment', { attachments: [{ type: 'file', path: '/srv/demo/a.png', displayName: 'a.png' }] })
  ])
}

function reasoning(): string {
  return jsonl([
    start(),
    user('think first'),
    turnStart(),
    e('assistant.reasoning', { reasoningId: 'r1', content: 'SYNTHETIC REASONING EVENT' }),
    asst('', [], { reasoningText: 'SYNTHETIC REASONING ONLY' }),
    asst('The visible answer.', [], {
      reasoningText: 'SYNTHETIC REASONING TEXT',
      reasoningOpaque: 'SYNTHETIC-OPAQUE',
      encryptedContent: 'SYNTHETIC-ENCRYPTED'
    }),
    asst('  \n  '),
    turnEnd()
  ])
}

function model(): string {
  const sub = { agentId: SUB_AGENT }
  return jsonl([
    start(),
    user('one'),
    asst('first', [], { model: 'gpt-5.5' }),
    user('two'),
    asst('second', [], { model: 'claude-opus-5-5' }),
    // A sub-agent's message is newer, but it is not the main thread's model.
    e('assistant.message', { messageId: 'sub', model: 'gpt-5.5-mini', content: 'sub', toolRequests: [], parentToolCallId: 'call_task' }, sub)
  ])
}

function modelAbsent(): string {
  // ONE record answers: the newest main message states no model, so the key is ABSENT, never the
  // older record's value carried forward.
  return jsonl([
    start(),
    user('one'),
    asst('first', [], { model: 'gpt-5.5' }),
    e('assistant.message', { messageId: 'no-model', content: 'second, no model stated', toolRequests: [] })
  ])
}

function modelUtf16(): string {
  // The 100-unit cap counts UTF-16 code units (Swift `utf16.count`): 50 × U+1F9EA is exactly 100.
  return jsonl([start(), asst('capped', [], { model: '🧪'.repeat(50) })])
}

function modelOverCap(): string {
  return jsonl([start(), asst('over the cap', [], { model: 'm'.repeat(101) })])
}

function userRequested(): string {
  return jsonl([
    start(),
    e('tool.user_requested', { toolCallId: 'user_bash', toolName: 'bash', arguments: { command: '  git log --oneline -3  ' } }),
    e('tool.execution_start', { toolCallId: 'user_bash', toolName: 'bash', arguments: { command: 'git log --oneline -3' } }),
    ok('user_bash', 'a1 one\nb2 two\nc3 three', { isUserRequested: true }),
    e('tool.user_requested', { toolCallId: 'user_view', toolName: 'view', arguments: { path: '/srv/demo/README.md' } }),
    ok('user_view', '# Demo', { isUserRequested: true })
  ])
}

function malformed(): string {
  const good = jsonl([start(), user('before the junk'), asst('after the junk')]).split('\n')
  const junk = [
    '{broken json',
    'null',
    '42',
    '[]',
    '"a string"',
    JSON.stringify({ data: {} }),
    JSON.stringify({ type: 'user.message' }),
    JSON.stringify({ type: 'user.message', data: [] }),
    JSON.stringify({ type: 'user.message', data: { content: 7 } }),
    JSON.stringify({ type: 'assistant.message', data: { content: 'x', toolRequests: { not: 'an array' } } }),
    JSON.stringify({ type: 'assistant.message', data: { content: 'kept', toolRequests: [{ toolCallId: 'no-name' }, 'junk', req('ok', 'view', { path: '/p' })] } }),
    JSON.stringify({ type: 'tool.execution_complete', data: { success: true, result: { content: 'no call id' } } }),
    JSON.stringify({ type: 'session.error', data: { errorType: 'x' } }),
    JSON.stringify({ type: 'tool.user_requested', data: { toolName: 'bash' } })
  ]
  // start, user, JUNK…, assistant — every junk line between two good ones.
  return [good[0], good[1], ...junk, good[2], ''].join('\n')
}

function hugeLastLine(): string {
  // A tool result carrying an image for the model (`binaryResultsForLlm`) is bigger than the 256 KB
  // tail: the tail grows until the line fits, and the result still attaches to its call.
  const image = pseudoRandomBase64(225_000)
  return jsonl([
    start(),
    ...filler(40, 'before'),
    user('What is in this screenshot?'),
    turnStart(),
    asst('Let me view it.', [req('call_img', 'view', { path: '/srv/demo/shot.png' })]),
    e('session.binary_asset', { assetId: 'asset-shot', type: 'image', mimeType: 'image/png', byteLength: 168750, data: image.slice(0, 1000) }),
    ok('call_img', 'Viewed image /srv/demo/shot.png', {
      result: {
        content: 'Viewed image /srv/demo/shot.png',
        binaryResultsForLlm: [{ type: 'image', data: image, mimeType: 'image/png' }]
      }
    })
  ])
}

const INPUTS: Record<string, string> = {
  'plain-turns.jsonl': plainTurns(),
  'tools.jsonl': tools(),
  'tools-cross-page.jsonl': toolsCrossPage(),
  'subagent.jsonl': subagent(),
  'notices.jsonl': notices(),
  'hidden-prompts.jsonl': hiddenPrompts(),
  'reasoning.jsonl': reasoning(),
  'model.jsonl': model(),
  'model-absent.jsonl': modelAbsent(),
  'model-utf16.jsonl': modelUtf16(),
  'model-over-cap.jsonl': modelOverCap(),
  'user-requested.jsonl': userRequested(),
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
  expect(fs.existsSync(p), `copilot/${rel} is missing — run UPDATE_CHAT_FIXTURES=1`).toBe(true)
  expect(fs.readFileSync(p, 'utf8'), rel).toBe(content)
}

// The producer check reads each input where copilot writes it: a scratch COPILOT_HOME.
let copilotHome: string
beforeAll(() => {
  copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-copilot-fixtures-'))
})
afterAll(() => {
  vi.unstubAllEnvs()
  fs.rmSync(copilotHome, { recursive: true, force: true })
})

describe('copilot chat golden fixtures', () => {
  it('the pager constants are the ones core uses', () => {
    expect(TAIL_BYTES).toBe(CHAT_PAGE_DEFAULT_BYTES)
    expect(MAX_BYTES).toBe(CHAT_PAGE_MAX_BYTES)
    expect(OLDER_BYTES).toBe(2 * TAIL_BYTES)
  })

  it('inputs are what the synthetic builders produce (checked in, never real journals)', () => {
    for (const [name, body] of Object.entries(INPUTS)) golden(`inputs/${name}`, body)
  })

  it('no orphan files: each directory holds exactly the generated set', () => {
    const listing = (dir: string): string[] => (fs.existsSync(fixture(dir)) ? fs.readdirSync(fixture(dir)).sort() : [])
    const expected = Object.keys(INPUTS)
      .map((n) => n.replace(/\.jsonl$/, '.pages.json'))
      .sort()
    if (UPDATE) {
      for (const f of listing('expected')) if (!expected.includes(f)) fs.rmSync(fixture(`expected/${f}`))
      for (const f of listing('inputs')) if (!(f in INPUTS)) fs.rmSync(fixture(`inputs/${f}`))
      return
    }
    expect(listing('inputs')).toEqual(Object.keys(INPUTS).sort())
    expect(listing('expected')).toEqual(expected)
    expect(fs.readdirSync(DIR).sort()).toEqual(['expected', 'inputs'])
  })

  for (const name of Object.keys(INPUTS)) {
    const base = name.replace(/\.jsonl$/, '')
    it(`${base}: paged parse matches copilot/expected/${base}.pages.json`, async () => {
      const file = fixture(`inputs/${name}`)
      const steps = await pageFile(file)
      // The pager is not a second implementation: every page equals what the real producer
      // (`readChatTranscript` → copilot's route → `parseGrowingWindow`) serves for that request.
      const dir = path.join(copilotHome, base, 'session-state', SID)
      fs.mkdirSync(dir, { recursive: true })
      fs.copyFileSync(file, path.join(dir, 'events.jsonl'))
      vi.stubEnv('COPILOT_HOME', path.join(copilotHome, base))
      for (const s of steps) {
        const served = await readChatTranscript(
          { sessionId: SID, agentId: 'copilot' },
          s.before === null ? { maxBytes: s.maxBytes } : { before: s.before, maxBytes: s.maxBytes },
          {}
        )
        const { noCompleteLine: _n, ...rest } = s.parse
        expect(served).toStrictEqual({ found: true, ...rest })
      }
      golden(`expected/${base}.pages.json`, serialize(steps))
    })
  }

  // What the structural fixtures exist to exercise — pinned so a builder edit cannot quietly turn
  // them into ordinary files.
  it('tools-cross-page: the call is in the older page, its result carried by the tail', async () => {
    const [tail, older] = await pageFile(fixture('inputs/tools-cross-page.jsonl'))
    expect(tail.parse.unmatchedResults).toEqual([{ id: 'call_long_job', result: 'job finished exit 0' }])
    const part = older.parse.messages.flatMap((m) => m.parts).find((p) => p.kind === 'tool' && p.id === 'call_long_job')
    expect(part).toMatchObject({ name: 'bash', arg: './long-job.sh' })
    expect(part).not.toHaveProperty('result')
  })

  it('huge-last-line: the tail grows past its first window and the result still attaches', async () => {
    const [tail] = await pageFile(fixture('inputs/huge-last-line.jsonl'))
    expect(tail.grownMaxBytes).toBeGreaterThan(TAIL_BYTES)
    expect(tail.parse.noCompleteLine).toBe(false)
    const img = tail.parse.messages.flatMap((m) => m.parts).find((p) => p.kind === 'tool' && p.id === 'call_img')
    expect(img).toMatchObject({ result: 'Viewed image /srv/demo/shot.png' })
  })

  it('nothing hidden leaks into any expected page', () => {
    for (const name of Object.keys(INPUTS)) {
      if (UPDATE) continue
      const pages = fs.readFileSync(fixture(`expected/${name.replace(/\.jsonl$/, '.pages.json')}`), 'utf8')
      for (const hidden of ['SYNTHETIC system prompt', 'SYNTHETIC REASONING', 'SYNTHETIC-OPAQUE', 'SYNTHETIC-ENCRYPTED', 'SYNTHETIC SKILL', 'SYNTHETIC INTER-AGENT', 'SYNTHETIC COMPACTION', 'SYNTHETIC TASK', 'Sub-agent looking', 'current_datetime', 'gpt-5.5-mini']) {
        expect(pages, `${name} leaks ${hidden}`).not.toContain(hidden)
      }
    }
  })
})
