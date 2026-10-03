// opencode's conversation as the ⌘M panel's structured messages, and the read that produces it.
//
// Every record shape below is SYNTHETIC, built from the schema measured on opencode 1.18.25 (the
// `opencode export` document: `{info, messages:[{info, parts}]}`, see opencode-chat.ts). None of
// it is a slice of a real session.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOpencodeExportGate,
  newestWithinBytes,
  opencodeToolArg,
  parseOpencodeExport
} from './opencode-chat'
import { readChatTranscript, type TranscriptIpcDeps } from './transcript-ipc'
import type { OpencodeExportOutcome } from './opencode-export'
import { setCustomAgentBaseResolver } from '../shared/agents/config'
import type { ChatMessage } from '../shared/types'

const SID = 'ses_0a1b2c3d4ffeSynthetic000001'
const T0 = 1_780_000_000_000

let n = 0
const pid = () => `prt_${String(++n).padStart(4, '0')}`
const doc = (messages: unknown[], id: string = SID): string =>
  JSON.stringify(
    {
      info: { id, slug: 'demo', projectID: 'p1', directory: '/srv/demo', title: 't', version: '1.18.25', time: { created: T0, updated: T0 } },
      messages
    },
    null,
    2
  ) + '\n'
const user = (id: string, parts: unknown[], extra: Record<string, unknown> = {}) => ({
  info: {
    role: 'user',
    time: { created: T0 + Number(id.replace(/\D/g, '')) * 1000 },
    agent: 'build',
    model: { providerID: 'opencode', modelID: 'demo-model' },
    summary: { diffs: [] },
    id,
    sessionID: SID,
    ...extra
  },
  parts
})
const asst = (id: string, parts: unknown[], extra: Record<string, unknown> = {}) => ({
  info: {
    parentID: 'msg_u',
    role: 'assistant',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/srv/demo', root: '/srv/demo' },
    cost: 0,
    tokens: { total: 10, input: 5, output: 5, reasoning: 0, cache: { write: 0, read: 0 } },
    modelID: 'demo-model',
    providerID: 'opencode',
    time: { created: T0 + Number(id.replace(/\D/g, '')) * 1000, completed: T0 + 1 },
    finish: 'stop',
    id,
    sessionID: SID,
    ...extra
  },
  parts
})
const part = (type: string, fields: Record<string, unknown> = {}) => ({ type, ...fields, id: pid(), sessionID: SID, messageID: 'msg_x' })
const text = (t: string, fields: Record<string, unknown> = {}) => part('text', { text: t, ...fields })
const tool = (name: string | undefined, state: Record<string, unknown>) =>
  part('tool', { ...(name === undefined ? {} : { tool: name }), callID: `call_${n}`, state })
const bookkeeping = () => [
  part('step-start', { snapshot: 'abc' }),
  part('step-finish', { reason: 'stop', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })
]

const parse = (raw: string) => {
  const r = parseOpencodeExport(raw, SID)
  if (!r) throw new Error('expected a parse')
  return r
}

describe('parseOpencodeExport — turns', () => {
  it('maps user and assistant text into bubbles, stamped with opencode\'s own created time', () => {
    const r = parse(
      doc([
        user('msg_1', [text('merhaba — ğüşçöı')]),
        asst('msg_2', [...bookkeeping().slice(0, 1), text('selam'), text('ikinci blok'), ...bookkeeping().slice(1)])
      ])
    )
    expect(r.messages).toEqual([
      { role: 'user', parts: [{ kind: 'text', text: 'merhaba — ğüşçöı' }], at: T0 + 1000 },
      {
        role: 'assistant',
        parts: [
          { kind: 'text', text: 'selam' },
          { kind: 'text', text: 'ikinci blok' }
        ],
        at: T0 + 2000
      }
    ])
    expect(r.skipped).toBe(0)
  })

  it('never states a time it was not given', () => {
    const m = user('msg_1', [text('hi')])
    delete (m.info as { time?: unknown }).time
    expect(parse(doc([m])).messages[0]).not.toHaveProperty('at')
  })

  it('drops reasoning and bookkeeping parts on purpose — and does not count them as unmappable', () => {
    const r = parse(
      doc([
        asst('msg_1', [
          ...bookkeeping(),
          part('reasoning', { text: 'private thinking', time: { start: 1, end: 2 } }),
          part('snapshot', { snapshot: 'h' }),
          part('patch', { hash: 'h', files: ['/srv/demo/a.ts'] }),
          part('retry', { attempt: 1, error: { name: 'APIError', data: { message: 'x', isRetryable: true } }, time: { created: 1 } }),
          part('agent', { name: 'plan' }),
          part('file', { mime: 'image/png', url: 'data:image/png;base64,AAAA', filename: 'shot.png' })
        ]),
        asst('msg_2', [part('reasoning', { text: 'only thinking', time: { start: 1 } })])
      ])
    )
    expect(r.messages).toEqual([])
    expect(r.skipped).toBe(0)
    expect(JSON.stringify(r)).not.toContain('private thinking')
  })

  it('never renders harness text as something the human said', () => {
    // opencode injects `synthetic` text into USER messages (a file an @-mention read in full, the
    // "tool was executed by the user" note) and marks some text `ignored`. Neither was typed.
    const r = parse(
      doc([
        user('msg_1', [text('typed by the human'), text('Called the Read tool with …', { synthetic: true }), text('x', { ignored: true })]),
        user('msg_2', [text('only injected', { synthetic: true })]),
        asst('msg_3', [text('synthetic assistant note', { synthetic: true }), text('real answer')])
      ])
    )
    expect(r.messages).toEqual([
      { role: 'user', parts: [{ kind: 'text', text: 'typed by the human' }], at: T0 + 1000 },
      { role: 'assistant', parts: [{ kind: 'text', text: 'real answer' }], at: T0 + 3000 }
    ])
  })

  it('keeps an empty text part out of the thread', () => {
    expect(parse(doc([user('msg_1', [text('')]), asst('msg_2', [text('')])])).messages).toEqual([])
  })
})

describe('parseOpencodeExport — tools', () => {
  it('completed: the output summarized like claude\'s tool results (three lines, 500 units)', () => {
    const out = ['line one', 'line two', 'line three', 'line four'].join('\n')
    const long = 'y'.repeat(600)
    const r = parse(
      doc([
        asst('msg_1', [
          tool('bash', { status: 'completed', input: { command: 'ls -la', description: 'List' }, output: out, title: 'List', metadata: {}, time: { start: 1, end: 2 } }),
          tool('read', { status: 'completed', input: { filePath: '/srv/demo/a.ts' }, output: long, title: 'a.ts', metadata: {}, time: { start: 1, end: 2 } })
        ])
      ])
    )
    expect(r.messages[0].parts).toEqual([
      { kind: 'tool', name: 'bash', arg: 'ls -la', result: 'line one line two line three' },
      { kind: 'tool', name: 'read', arg: '/srv/demo/a.ts', result: 'y'.repeat(500) }
    ])
  })

  it('error: the tool\'s error text becomes its result, marked as an error', () => {
    const r = parse(
      doc([asst('msg_1', [tool('edit', { status: 'error', input: { filePath: '/srv/demo/b.ts' }, error: 'oldString not found\nsecond', time: { start: 1, end: 2 } })])])
    )
    expect(r.messages[0].parts).toEqual([{ kind: 'tool', name: 'edit', arg: '/srv/demo/b.ts', result: 'Error: oldString not found second' }])
  })

  it('pending and running calls have no result yet — the key is absent, never empty', () => {
    const r = parse(
      doc([
        asst('msg_1', [
          tool('bash', { status: 'pending', input: {}, raw: '{"comm' }),
          tool('webfetch', { status: 'running', input: { url: 'https://example.test/a' }, title: 'Fetching', time: { start: 1 } })
        ])
      ])
    )
    expect(r.messages[0].parts).toEqual([
      { kind: 'tool', name: 'bash', arg: '' },
      { kind: 'tool', name: 'webfetch', arg: 'https://example.test/a' }
    ])
    for (const p of r.messages[0].parts) expect(p).not.toHaveProperty('result')
  })

  it('never carries claude-only card fields: no body, questions or id on any tool part', () => {
    // opencode's `question` tool is an AskUserQuestion look-alike, but plan / question answer cards
    // are claude-only: a `questions` field would be read as a card to answer.
    const r = parse(
      doc([
        asst('msg_1', [
          tool('question', {
            status: 'completed',
            input: { questions: [{ question: 'Which colour?', header: 'Colour', options: [{ label: 'Red', description: 'r' }] }] },
            output: 'User answered: Red',
            title: 'Asked 1 question',
            metadata: { answers: [['Red']], truncated: false },
            time: { start: 1, end: 2 }
          })
        ])
      ])
    )
    const p = r.messages[0].parts[0]
    expect(p).toEqual({ kind: 'tool', name: 'question', arg: 'Which colour?', result: 'User answered: Red' })
    expect(p).not.toHaveProperty('body')
    expect(p).not.toHaveProperty('questions')
    expect(p).not.toHaveProperty('id')
  })

  it('a tool part with no tool name is still a tool, never raw JSON', () => {
    const r = parse(doc([asst('msg_1', [tool(undefined, { status: 'running', input: {}, time: { start: 1 } })])]))
    expect(r.messages[0].parts).toEqual([{ kind: 'tool', name: 'tool', arg: '' }])
  })
})

describe('opencodeToolArg', () => {
  it('picks the meaningful input of each builtin tool', () => {
    expect(opencodeToolArg({ command: 'npm test', description: 'Run tests' })).toBe('npm test')
    expect(opencodeToolArg({ filePath: '/a/b.ts', oldString: 'x', newString: 'y' })).toBe('/a/b.ts')
    expect(opencodeToolArg({ file_path: '/a/c.ts' })).toBe('/a/c.ts')
    expect(opencodeToolArg({ pattern: 'TODO', path: '/a' })).toBe('TODO') // grep/glob: the pattern
    expect(opencodeToolArg({ path: '/a' })).toBe('/a') // list
    expect(opencodeToolArg({ url: 'https://x.test' })).toBe('https://x.test')
    expect(opencodeToolArg({ query: 'effect schema' })).toBe('effect schema')
    expect(opencodeToolArg({ description: 'Explore', prompt: 'long…', subagent_type: 'general' })).toBe('Explore')
    expect(opencodeToolArg({ prompt: 'p' })).toBe('p')
    expect(opencodeToolArg({ name: 'my-skill' })).toBe('my-skill')
    expect(opencodeToolArg({ questions: [{ question: 'Q1?' }, { question: 'Q2?' }] })).toBe('Q1?')
  })

  it('falls back to the title opencode wrote, then to nothing', () => {
    expect(opencodeToolArg({ todos: [] }, 'Updated 3 todos')).toBe('Updated 3 todos')
    expect(opencodeToolArg({ todos: [] })).toBe('')
    expect(opencodeToolArg(undefined, undefined)).toBe('')
    expect(opencodeToolArg({ command: 42 }, 'Title')).toBe('Title') // a non-string key never renders
  })

  it('caps at 200 UTF-16 units, like every other tool arg', () => {
    expect(opencodeToolArg({ command: 'z'.repeat(250) })).toBe('z'.repeat(200))
    expect(opencodeToolArg({}, 't'.repeat(250))).toBe('t'.repeat(200))
  })
})

describe('parseOpencodeExport — errors, compaction, subtasks', () => {
  it('an assistant turn that failed says so, after whatever it managed to write', () => {
    const r = parse(
      doc([
        asst('msg_1', [text('partial')], { error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } } }),
        asst('msg_2', [], { error: { name: 'APIError', data: { message: 'Rate limited', isRetryable: true, statusCode: 429 } } }),
        asst('msg_3', [], { error: { name: 'MessageOutputLengthError', data: {} } }),
        asst('msg_4', [], { error: 'not an object' })
      ])
    )
    expect(r.messages.map((m) => m.parts)).toEqual([
      [
        { kind: 'text', text: 'partial' },
        { kind: 'text', text: '[MessageAbortedError] The operation was aborted.' }
      ],
      [{ kind: 'text', text: '[APIError] Rate limited' }],
      [{ kind: 'text', text: '[MessageOutputLengthError]' }]
    ])
    expect(r.skipped).toBe(1) // the malformed error object
  })

  it('a compaction is a chip, and the summary opencode wrote is the assistant\'s text', () => {
    const r = parse(
      doc([
        user('msg_1', [part('compaction', { auto: true })]),
        asst('msg_2', [text('Summary of the conversation so far.')], { summary: true }),
        user('msg_3', [part('compaction', { auto: false, overflow: true })])
      ])
    )
    expect(r.messages).toEqual([
      { role: 'assistant', parts: [{ kind: 'tool', name: 'compaction', arg: 'auto' }], at: T0 + 1000 },
      { role: 'assistant', parts: [{ kind: 'text', text: 'Summary of the conversation so far.' }], at: T0 + 2000 },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'compaction', arg: '' }], at: T0 + 3000 }
    ])
  })

  it('a tool part inside a USER message is a chip on the assistant side, never in the user bubble', () => {
    const r = parse(
      doc([user('msg_1', [text('run it'), tool('bash', { status: 'completed', input: { command: 'ls' }, output: 'a', title: 'ls', metadata: {}, time: { start: 1, end: 2 } })])])
    )
    expect(r.messages).toEqual([
      { role: 'user', parts: [{ kind: 'text', text: 'run it' }], at: T0 + 1000 },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'bash', arg: 'ls', result: 'a' }], at: T0 + 1000 }
    ])
  })

  it('a subtask part becomes a task chip beside the user\'s own words', () => {
    const r = parse(
      doc([user('msg_1', [text('/review the diff'), part('subtask', { prompt: 'full prompt', description: 'Review changes', agent: 'general', command: 'review' })])])
    )
    expect(r.messages).toEqual([
      { role: 'user', parts: [{ kind: 'text', text: '/review the diff' }], at: T0 + 1000 },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'task', arg: 'Review changes' }], at: T0 + 1000 }
    ])
  })
})

describe('parseOpencodeExport — shapes it cannot map', () => {
  it('skips and COUNTS them, never crashes and never renders raw JSON', () => {
    const r = parse(
      doc([
        'a string where a message should be',
        null,
        { parts: [text('no info')] },
        { info: { role: 'system', id: 'msg_s', sessionID: SID }, parts: [text('unknown role')] },
        user('msg_1', 'parts is not an array' as unknown as unknown[]),
        user('msg_2', [text('kept'), 7, { no: 'type' }, part('future-kind', { secret: 'RAWJSON' }), text(42 as unknown as string)])
      ])
    )
    expect(r.messages).toEqual([{ role: 'user', parts: [{ kind: 'text', text: 'kept' }], at: T0 + 2000 }])
    // string, null, no-info, unknown role, non-array parts, then 7 / {no:type} / future-kind / non-string text
    expect(r.skipped).toBe(9)
    expect(JSON.stringify(r.messages)).not.toContain('RAWJSON')
  })

  it('a message filed under ANOTHER session is skipped, never shown', () => {
    const foreign = user('msg_1', [text('SOMEONE ELSE PRIVATE')])
    ;(foreign.info as { sessionID: string }).sessionID = 'ses_someoneElse00000000000'
    const r = parse(doc([foreign, user('msg_2', [text('mine')])]))
    expect(JSON.stringify(r.messages)).not.toContain('SOMEONE ELSE PRIVATE')
    expect(r.messages.map((m) => m.parts)).toEqual([[{ kind: 'text', text: 'mine' }]])
    expect(r.skipped).toBe(1)
  })

  it('refuses the whole document when it is not this session\'s export', () => {
    expect(parseOpencodeExport(doc([user('msg_1', [text('SOMEONE ELSE PRIVATE')])], 'ses_other000000000000000000'), SID)).toBeNull()
    expect(parseOpencodeExport(JSON.stringify({ messages: [] }), SID)).toBeNull() // no info.id at all
    expect(parseOpencodeExport('not json', SID)).toBeNull()
    expect(parseOpencodeExport('[]', SID)).toBeNull()
    expect(parseOpencodeExport(JSON.stringify({ info: { id: SID } }), SID)).toEqual({ messages: [], skipped: 0 })
  })
})

describe('parseOpencodeExport — model and effort', () => {
  it('the newest assistant message answers both fields, and nothing is carried from an older one', () => {
    const r = parse(
      doc([
        asst('msg_1', [text('a')], { modelID: 'old-model', variant: 'high' }),
        user('msg_2', [text('b')], { model: { providerID: 'x', modelID: 'user-picked', variant: 'max' } }),
        asst('msg_3', [text('c')], { modelID: 'new-model' })
      ])
    )
    expect(r.model).toBe('new-model')
    expect('effort' in r).toBe(false)
  })

  it('the newest assistant message stating NO model leaves the key absent', () => {
    const newest = asst('msg_2', [text('b')])
    delete (newest.info as { modelID?: unknown }).modelID
    const r = parse(doc([asst('msg_1', [text('a')], { modelID: 'old-model' }), newest]))
    expect('model' in r).toBe(false)
  })

  it('states the variant as effort when the newest assistant message carries one', () => {
    const r = parse(doc([asst('msg_1', [text('a')], { modelID: 'm', variant: 'high' })]))
    expect(r).toMatchObject({ model: 'm', effort: 'high' })
  })

  it('a value over 100 UTF-16 units is not a model name', () => {
    const r = parse(doc([asst('msg_1', [text('a')], { modelID: 'm'.repeat(101), variant: 'v'.repeat(100) })]))
    expect('model' in r).toBe(false)
    expect(r.effort).toBe('v'.repeat(100))
  })

  it('no assistant message = neither key', () => {
    const r = parse(doc([user('msg_1', [text('a')])]))
    expect(Object.keys(r)).toEqual(['messages', 'skipped'])
  })
})

describe('newestWithinBytes', () => {
  const m = (t: string): ChatMessage => ({ role: 'user', parts: [{ kind: 'text', text: t }] })
  it('keeps the newest messages whose JSON fits the cap, in order', () => {
    const msgs = [m('a'.repeat(100)), m('b'.repeat(100)), m('c'.repeat(100))]
    const one = Buffer.byteLength(JSON.stringify(msgs[0]))
    expect(newestWithinBytes(msgs, one * 2)).toEqual(msgs.slice(1))
    expect(newestWithinBytes(msgs, one * 3)).toEqual(msgs)
    expect(newestWithinBytes(msgs, one - 1)).toEqual([])
  })
  it('counts UTF-8 bytes, not UTF-16 units', () => {
    const msgs = [m('ş'.repeat(10)), m('x')]
    const last = Buffer.byteLength(JSON.stringify(msgs[1]))
    const first = Buffer.byteLength(JSON.stringify(msgs[0]))
    expect(first).toBeGreaterThan(JSON.stringify(msgs[0]).length)
    expect(newestWithinBytes(msgs, last + first - 1)).toEqual([msgs[1]])
  })
})

// ── The read (readChatTranscript's opencode branch) ────────────────────────────────────────────

const exportOf = (outcome: OpencodeExportOutcome) => vi.fn(async (_sid: string) => outcome)
const read = (q: Parameters<typeof readChatTranscript>[0], page: unknown, deps: TranscriptIpcDeps) =>
  readChatTranscript(q, page, deps)
const OK_DOC = doc([user('msg_1', [text('mine')]), asst('msg_2', [text('answer')], { modelID: 'm1', variant: 'low' })])

afterEach(() => setCustomAgentBaseResolver(null))

describe('readChatTranscript — opencode', () => {
  it('serves a paged read as ONE page: nothing older, no carried results, model + effort', async () => {
    const opencodeExport = exportOf({ ok: true, stdout: OK_DOC })
    const res = await read({ sessionId: SID, agentId: 'opencode' }, { maxBytes: 262144 }, { opencodeExport })
    expect(res).toStrictEqual({
      messages: [
        { role: 'user', parts: [{ kind: 'text', text: 'mine' }], at: T0 + 1000 },
        { role: 'assistant', parts: [{ kind: 'text', text: 'answer' }], at: T0 + 2000 }
      ],
      found: true,
      olderCursor: null,
      unmatchedResults: [],
      model: 'm1',
      effort: 'low'
    })
    expect(opencodeExport).toHaveBeenCalledWith(SID, { background: false })
  })

  it('an unpaged read keeps the legacy shape exactly', async () => {
    const res = await read({ sessionId: SID, agentId: 'opencode' }, undefined, { opencodeExport: exportOf({ ok: true, stdout: OK_DOC }) })
    expect(Object.keys(res).sort()).toEqual(['found', 'messages'])
    expect(res.found).toBe(true)
  })

  it('NEVER reaches claude\'s resolver, whose cwd fallback would hand over a stranger\'s session', async () => {
    const pathFor = vi.fn(() => '/definitely/claude.jsonl')
    const readRemotePage = vi.fn(async () => null)
    const readRemote = vi.fn(async () => 'SOMEONE ELSE PRIVATE')
    for (const page of [undefined, { maxBytes: 262144 }]) {
      const res = await read(
        { sessionId: SID, cwd: '/srv/demo', agentId: 'opencode' },
        page,
        { pathFor, readRemote, readRemotePage, opencodeExport: exportOf({ ok: false, absent: true }) }
      )
      expect(res.found).toBe(false)
      expect(JSON.stringify(res)).not.toContain('SOMEONE ELSE PRIVATE')
    }
    expect(pathFor).not.toHaveBeenCalled()
    expect(readRemote).not.toHaveBeenCalled()
    expect(readRemotePage).not.toHaveBeenCalled()
  })

  it('a REMOTE node never reads this machine: refused before any export runs', async () => {
    const opencodeExport = exportOf({ ok: true, stdout: OK_DOC })
    expect(await read({ sessionId: SID, agentId: 'opencode', remoteOnly: true }, { maxBytes: 262144 }, { opencodeExport })).toStrictEqual({
      messages: [],
      found: false,
      olderCursor: null,
      unmatchedResults: [],
      unreadable: true
    })
    expect(await read({ sessionId: SID, agentId: 'opencode', remoteOnly: true }, undefined, { opencodeExport })).toStrictEqual({
      messages: [],
      found: false
    })
    expect(opencodeExport).not.toHaveBeenCalled()
  })

  it('no session id, or one we would not put on argv, is not found — and nothing runs', async () => {
    // `opencode export` with NO id opens an interactive picker over the NEWEST sessions — i.e.
    // someone else's. It must never be invoked without one.
    const opencodeExport = exportOf({ ok: true, stdout: OK_DOC })
    for (const sessionId of [undefined, '', '--help', '-s', 'ses a', "ses';rm -rf ~;'"]) {
      const res = await read({ sessionId, agentId: 'opencode' }, { maxBytes: 262144 }, { opencodeExport })
      expect(res).toStrictEqual({ messages: [], found: false, olderCursor: null, unmatchedResults: [] })
    }
    expect(opencodeExport).not.toHaveBeenCalled()
  })

  it('a clean miss is not-found; a failed export is UNREADABLE', async () => {
    const absent = await read({ sessionId: SID, agentId: 'opencode' }, { maxBytes: 262144 }, { opencodeExport: exportOf({ ok: false, absent: true }) })
    expect(absent).toStrictEqual({ messages: [], found: false, olderCursor: null, unmatchedResults: [] })
    const failed = await read({ sessionId: SID, agentId: 'opencode' }, { maxBytes: 262144 }, { opencodeExport: exportOf({ ok: false }) })
    expect(failed).toStrictEqual({ messages: [], found: false, olderCursor: null, unmatchedResults: [], unreadable: true })
    const legacy = await read({ sessionId: SID, agentId: 'opencode' }, undefined, { opencodeExport: exportOf({ ok: false }) })
    expect(legacy).toStrictEqual({ messages: [], found: false })
  })

  it('an export of ANOTHER session (or garbage) is unreadable, and none of it is shown', async () => {
    for (const stdout of [doc([user('msg_1', [text('SOMEONE ELSE PRIVATE')])], 'ses_other000000000000000000'), 'garbage']) {
      const res = await read({ sessionId: SID, agentId: 'opencode' }, { maxBytes: 262144 }, { opencodeExport: exportOf({ ok: true, stdout }) })
      expect(res).toStrictEqual({ messages: [], found: false, olderCursor: null, unmatchedResults: [], unreadable: true })
    }
  })

  it('a page too small for one message grows like claude\'s (×4); the legacy read keeps 5 MB', async () => {
    const big = (i: number) => asst(`msg_${i}`, [text(String(i).repeat(1024 * 1024))])
    const stdout = doc([1, 2, 3, 4, 5, 6].map(big))
    const first = (r: { messages: ChatMessage[] }) => r.messages.map((m) => (m.parts[0] as { text: string }).text[0])
    // 256 KB and 1 MB hold no whole ~1 MB message; 4 MB holds three.
    const paged = await read({ sessionId: SID, agentId: 'opencode' }, { maxBytes: 262144 }, { opencodeExport: exportOf({ ok: true, stdout }) })
    expect(first(paged)).toEqual(['4', '5', '6'])
    const legacy = await read({ sessionId: SID, agentId: 'opencode' }, undefined, { opencodeExport: exportOf({ ok: true, stdout }) })
    expect(first(legacy)).toEqual(['3', '4', '5', '6'])
  })

  it('an OLDER-page request has nothing older to give, and costs no export', async () => {
    const opencodeExport = exportOf({ ok: true, stdout: OK_DOC })
    const res = await read({ sessionId: SID, agentId: 'opencode' }, { before: 1000, maxBytes: 524288 }, { opencodeExport })
    expect(res).toStrictEqual({ messages: [], found: true, olderCursor: null, unmatchedResults: [] })
    expect(opencodeExport).not.toHaveBeenCalled()
  })

  it('a custom agent built on opencode reads through opencode, not claude', async () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:oc' ? 'opencode' : undefined))
    const pathFor = vi.fn(() => '/definitely/claude.jsonl')
    const opencodeExport = exportOf({ ok: true, stdout: OK_DOC })
    const res = await read({ sessionId: SID, agentId: 'custom:oc' }, { maxBytes: 262144 }, { pathFor, opencodeExport })
    expect(res.found).toBe(true)
    expect(pathFor).not.toHaveBeenCalled()
  })
})

// ── The gate: one bounded export at a time ─────────────────────────────────────────────────────

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('createOpencodeExportGate', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('callers arriving before an export STARTS share it', async () => {
    const d = deferred<OpencodeExportOutcome>()
    const run = vi.fn(() => d.promise)
    const gate = createOpencodeExportGate(run, { minSpacingMs: 0, maxConcurrent: 2 })
    const a = gate(SID)
    const b = gate(SID)
    await flush()
    d.resolve({ ok: true, stdout: 'x' })
    expect(await a).toEqual({ ok: true, stdout: 'x' })
    expect(await b).toEqual({ ok: true, stdout: 'x' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a caller arriving while an export RUNS gets a fresh one started after it — shared with its peers', async () => {
    const first = deferred<OpencodeExportOutcome>()
    const second = deferred<OpencodeExportOutcome>()
    const run = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const gate = createOpencodeExportGate(run, { minSpacingMs: 0, maxConcurrent: 2 })
    const a = gate(SID)
    await flush() // the first export has started
    const b = gate(SID)
    const c = gate(SID)
    await flush()
    expect(run).toHaveBeenCalledTimes(1) // the fresh export waits for the running one
    first.resolve({ ok: true, stdout: 'old' })
    expect(await a).toEqual({ ok: true, stdout: 'old' })
    await flush()
    expect(run).toHaveBeenCalledTimes(2)
    second.resolve({ ok: true, stdout: 'new' })
    expect(await b).toEqual({ ok: true, stdout: 'new' })
    expect(await c).toEqual({ ok: true, stdout: 'new' })
  })

  it('spaces export starts for one session', async () => {
    let t = 1000
    const sleeps: number[] = []
    const run = vi.fn(async () => ({ ok: true as const, stdout: String(t) }))
    const gate = createOpencodeExportGate(run, {
      minSpacingMs: 2000,
      maxConcurrent: 2,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms)
        t += ms
      }
    })
    await gate(SID)
    t += 500
    await gate(SID)
    expect(sleeps).toEqual([1500])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('never reuses a failure: the next call runs again', async () => {
    const run = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, stdout: 'y' })
    const gate = createOpencodeExportGate(run, { minSpacingMs: 0, maxConcurrent: 2 })
    expect(await gate(SID)).toEqual({ ok: false })
    expect(await gate(SID)).toEqual({ ok: true, stdout: 'y' })
  })

  it('sessions do not share an export', async () => {
    const run = vi.fn(async (id: string) => ({ ok: true as const, stdout: id }))
    const gate = createOpencodeExportGate(run, { minSpacingMs: 0, maxConcurrent: 2 })
    expect(await Promise.all([gate('ses_a'), gate('ses_b')])).toEqual([
      { ok: true, stdout: 'ses_a' },
      { ok: true, stdout: 'ses_b' }
    ])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('caps concurrent exports across sessions (each one is a ~320 MB process)', async () => {
    const ds = [deferred<OpencodeExportOutcome>(), deferred<OpencodeExportOutcome>(), deferred<OpencodeExportOutcome>()]
    let i = 0
    const run = vi.fn(() => ds[i++].promise)
    const gate = createOpencodeExportGate(run, { minSpacingMs: 0, maxConcurrent: 2 })
    const a = gate('ses_a')
    const b = gate('ses_b')
    const c = gate('ses_c')
    await flush()
    expect(run).toHaveBeenCalledTimes(2)
    ds[0].resolve({ ok: true, stdout: 'a' })
    await a
    await flush()
    expect(run).toHaveBeenCalledTimes(3)
    ds[1].resolve({ ok: true, stdout: 'b' })
    ds[2].resolve({ ok: true, stdout: 'c' })
    expect(await b).toEqual({ ok: true, stdout: 'b' })
    expect(await c).toEqual({ ok: true, stdout: 'c' })
  })

  it('a runner that throws is a failed read, and does not wedge the session', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ ok: true, stdout: 'z' })
    const gate = createOpencodeExportGate(run, { minSpacingMs: 0, maxConcurrent: 1 })
    expect(await gate(SID)).toEqual({ ok: false })
    expect(await gate(SID)).toEqual({ ok: true, stdout: 'z' })
  })
})
