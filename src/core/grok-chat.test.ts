import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { chatMessagesFromGrok, parseGrokChat } from './grok-chat'

const RAW = fs.readFileSync(path.join(__dirname, '__fixtures__/grok/chat_history.jsonl'), 'utf8')

describe('chatMessagesFromGrok', () => {
  it('builds bubbles from a real session', () => {
    const msgs = chatMessagesFromGrok(RAW)
    expect(msgs.length).toBeGreaterThan(0)
    expect(msgs.some((m) => m.role === 'user')).toBe(true)
    expect(msgs.some((m) => m.role === 'assistant')).toBe(true)
  })

  it('never gives harness-injected text the user role', () => {
    // The panel has two roles and no third place to put tooling text. grok marks these only with
    // `synthetic_reason` under the `user` type, so an unlabelled read shows a skill reminder in the
    // same shape as a typed prompt. Every injected line is assistant-side and carries its reason.
    const msgs = chatMessagesFromGrok(RAW)
    for (const reason of [
      'system_reminder',
      'compaction_meta',
      'project_instructions',
      'task_completed'
    ]) {
      const hit = msgs.find((m) =>
        m.parts.some((p) => p.kind === 'text' && p.text.startsWith(`[${reason}]`))
      )
      expect(hit, reason).toBeDefined()
      expect(hit!.role).toBe('assistant')
    }
    // …and no user bubble carries one.
    for (const m of msgs.filter((x) => x.role === 'user')) {
      for (const p of m.parts) {
        if (p.kind === 'text') expect(p.text.startsWith('[')).toBe(false)
      }
    }
  })

  it('correlates a tool result back onto the call it answers', () => {
    const msgs = chatMessagesFromGrok(RAW)
    const tools = msgs.flatMap((m) => m.parts).filter((p) => p.kind === 'tool')
    expect(tools.length).toBeGreaterThan(0)
    // The fixture's results reference ids that its assistant lines declare, so at least one lands.
    expect(tools.some((t) => t.kind === 'tool' && typeof t.result === 'string')).toBe(true)
    // A result is never a bubble of its own.
    expect(msgs.some((m) => m.parts.some((p) => p.kind === 'text' && p.text.startsWith('  =')))).toBe(
      false
    )
  })

  it('emits no model reasoning', () => {
    const msgs = chatMessagesFromGrok(RAW)
    const all = JSON.stringify(msgs)
    expect(all).not.toContain('encrypted_content')
  })

  it('is empty, not thrown, for junk and for nothing', () => {
    expect(chatMessagesFromGrok('')).toEqual([])
    expect(chatMessagesFromGrok('{broken\n')).toEqual([])
  })

  it('does not parse a CLAUDE transcript — the two readers are not interchangeable', () => {
    // A claude line nests its content under `message.content`, which this reader does not read.
    // The point is that pointing the wrong reader at a file yields NOTHING rather than a plausible
    // half-transcript: silence is the failure we can see.
    const claudeLine = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'hello from claude' }] }
    })
    expect(chatMessagesFromGrok(claudeLine)).toEqual([])
  })
})

// ── The structured reader behind the paged ⌘M read and the phone (`parseGrokChat`) ──────────────
// Synthetic lines in the shapes MEASURED on grok 1.0.13 (the real-derived fixture above, plus the
// record vocabulary in the shipped binary): `assistant` carries `model_id`, `model_fingerprint` and
// `reasoning_effort` at top level; `tool_calls[].arguments` is a JSON STRING; `tool_result.content`
// is a string. No record carries a timestamp.
const jl = (...rows: object[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const asst = (content: string, extra: Record<string, unknown> = {}): object => ({
  type: 'assistant',
  content,
  model_id: 'grok-4.6-build',
  model_fingerprint: 'fp_synthetic',
  reasoning_effort: 'high',
  ...extra
})

describe('parseGrokChat', () => {
  it('reports the newest assistant record\'s model and effort', () => {
    const r = parseGrokChat(
      jl(asst('one', { reasoning_effort: 'medium' }), { type: 'user', content: 'go on' }, asst('two', { model_id: 'grok-5', reasoning_effort: 'xhigh' }))
    )
    expect(r.model).toBe('grok-5')
    expect(r.effort).toBe('xhigh')
  })

  it('never carries an effort forward from an older record', () => {
    // The newest record states no effort: the key is ABSENT, same rule as claude's reader.
    const r = parseGrokChat(jl(asst('old', { reasoning_effort: 'xhigh' }), asst('new', { reasoning_effort: undefined })))
    expect(r.model).toBe('grok-4.6-build')
    expect('effort' in r).toBe(false)
  })

  it('drops a model or effort longer than 100 UTF-16 units instead of reporting it', () => {
    const r = parseGrokChat(jl(asst('x', { model_id: 'm'.repeat(101), reasoning_effort: 'e'.repeat(100) })))
    expect('model' in r).toBe(false)
    expect(r.effort).toBe('e'.repeat(100))
  })

  it('omits both keys when no assistant record exists', () => {
    const r = parseGrokChat(jl({ type: 'user', content: 'hi' }))
    expect('model' in r).toBe(false)
    expect('effort' in r).toBe(false)
  })

  it('names a tool call by its salient argument, not its raw JSON', () => {
    const r = parseGrokChat(
      jl(
        asst('', {
          tool_calls: [
            { id: 'call-1', name: 'read_file', arguments: JSON.stringify({ target_file: '/srv/app/a.ts' }) },
            { id: 'call-2', name: 'list_dir', arguments: JSON.stringify({ target_directory: '/srv/app' }) },
            { id: 'call-3', name: 'run_terminal_cmd', arguments: JSON.stringify({ command: 'ls -la', is_background: false }) }
          ]
        })
      )
    )
    const tools = r.messages[0].parts
    expect(tools).toEqual([
      { kind: 'tool', name: 'read_file', arg: '/srv/app/a.ts' },
      { kind: 'tool', name: 'list_dir', arg: '/srv/app' },
      { kind: 'tool', name: 'run_terminal_cmd', arg: 'ls -la' }
    ])
  })

  it('falls back to the raw arguments text, capped at 200 units, when no salient key exists', () => {
    const odd = JSON.stringify({ something: 'x'.repeat(300) })
    const r = parseGrokChat(
      jl(asst('', { tool_calls: [{ id: 'c', name: 'weird', arguments: odd }, { id: 'd', name: 'broken', arguments: '{not json' }] }))
    )
    const [a, b] = r.messages[0].parts as Array<{ arg: string }>
    expect(a.arg).toBe(odd.slice(0, 200))
    expect(b.arg).toBe('{not json')
  })

  it('summarizes a result like claude: first three lines joined, capped at 500', () => {
    const body = ['l1', 'l2', 'l3', 'l4'].join('\n')
    const long = 'y'.repeat(900)
    const r = parseGrokChat(
      jl(
        asst('', { tool_calls: [{ id: 'a', name: 'read_file', arguments: '{}' }, { id: 'b', name: 'read_file', arguments: '{}' }] }),
        { type: 'tool_result', tool_call_id: 'a', content: body },
        { type: 'tool_result', tool_call_id: 'b', content: long }
      )
    )
    const [a, b] = r.messages[0].parts as Array<{ result?: string }>
    expect(a.result).toBe('l1 l2 l3')
    expect(b.result).toBe('y'.repeat(500))
  })

  it('counts every line it could not map, and nothing it deliberately hides', () => {
    const r = parseGrokChat(
      [
        '{broken',
        '42',
        '[1,2]',
        JSON.stringify({ type: 'some_future_record', content: 'x' }),
        JSON.stringify({ type: 'reasoning', encrypted_content: 'zz', summary: [] }),
        JSON.stringify({ type: 'user', content: 'kept' })
      ].join('\n')
    )
    expect(r.skipped).toBe(4)
    expect(r.messages).toEqual([{ role: 'user', parts: [{ kind: 'text', text: 'kept' }] }])
  })

  it('survives hostile shapes: one bad field costs that field, never the thread', () => {
    const r = parseGrokChat(
      jl(
        { type: 'assistant', content: 'a', tool_calls: { not: 'an array' } },
        { type: 'assistant', content: 'b', tool_calls: [null, 7, ['an', 'array'], { id: 'k', name: 42, arguments: null }] },
        { type: 'tool_result', tool_call_id: 'k', content: { weird: true } },
        { type: 'backend_tool_call', kind: ['web_search'] },
        { type: 'user', content: 'still here' }
      )
    )
    expect(r.messages.map((m) => m.role)).toEqual(['assistant', 'assistant', 'assistant', 'user'])
    expect(r.messages[1].parts).toEqual([
      { kind: 'text', text: 'b' },
      { kind: 'tool', name: 'tool', arg: '' }
    ])
    expect(r.messages[2].parts).toEqual([{ kind: 'tool', name: 'backend_tool', arg: '' }])
  })

  it('agrees with chatMessagesFromGrok on the messages', () => {
    expect(parseGrokChat(RAW).messages).toEqual(chatMessagesFromGrok(RAW))
  })
})
