// The ⌘M reader for GitHub Copilot CLI's session journal (`<COPILOT_HOME>/session-state/<id>/
// events.jsonl`). Every record shape below was MEASURED on copilot 1.0.88 (a real CLI run against a
// local fake model, BYOK mode) or read from the CLI's own `session-events.schema.json`; the content
// is synthetic. What these pin: the main thread only (never a sub-agent's, never the system
// prompt), results attached to their calls, and a line we cannot read costing one line.
import { describe, it, expect } from 'vitest'
import { chatMessagesFromCopilot, parseCopilotChatWindow, parseCopilotRecords } from './copilot-chat'
import { parseChatMessages } from './transcript-reader'

type Rec = Record<string, unknown>
const T0 = Date.parse('2026-09-28T20:35:16.000Z')
let seq = 0
/** One event line in the measured envelope: `{type, data, [agentId], id, timestamp, parentId}`. */
function ev(type: string, data: Rec, extra: Rec = {}): string {
  const i = seq++
  return (
    JSON.stringify({
      type,
      data,
      ...extra,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      timestamp: new Date(T0 + i * 1000).toISOString(),
      parentId: null
    }) + '\n'
  )
}
const userMsg = (content: string, more: Rec = {}): string =>
  ev('user.message', { content, transformedContent: `<current_datetime>x</current_datetime>\n\n${content}`, ...more })
const asst = (content: string, toolRequests: Rec[] = [], more: Rec = {}): string =>
  ev('assistant.message', { messageId: 'm', model: 'gpt-5.5', content, toolRequests, ...more })
const req = (toolCallId: string, name: string, args: unknown): Rec => ({
  toolCallId,
  name,
  arguments: args,
  type: 'function'
})
const done = (toolCallId: string, content: string, more: Rec = {}): string =>
  ev('tool.execution_complete', { toolCallId, success: true, result: { content }, ...more })
const failed = (toolCallId: string, message: string): string =>
  ev('tool.execution_complete', { toolCallId, success: false, error: { message, code: 'denied' } })

const paged = (text: string) => parseCopilotChatWindow(Buffer.from(text), 0)
const legacy = (text: string) => chatMessagesFromCopilot(text)
const partsOf = (text: string) => paged(text).messages.flatMap((m) => m.parts)

describe('copilot chat — turns', () => {
  it('renders the typed prompt, never the model-facing transformedContent', () => {
    const r = paged(userMsg('Say hello') + asst('Hello **there**.'))
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(r.messages[0].parts).toEqual([{ kind: 'text', text: 'Say hello' }])
    expect(JSON.stringify(r.messages)).not.toContain('current_datetime')
    expect(r.messages[1].parts).toEqual([{ kind: 'text', text: 'Hello **there**.' }])
  })

  it('keys each message by its line offset and stamps it with the event time (paged)', () => {
    seq = 0
    const a = userMsg('one')
    const b = asst('two')
    const r = paged(a + b)
    expect(r.messages.map((m) => m.key)).toEqual([0, Buffer.byteLength(a)])
    expect(r.messages.map((m) => m.at)).toEqual([T0, T0 + 1000])
  })

  it('the legacy read carries `at` but neither keys nor tool ids', () => {
    const msgs = legacy(asst('x', [req('c1', 'bash', { command: 'ls' })]))
    expect(msgs[0].key).toBeUndefined()
    expect(msgs[0].at).toBeTypeOf('number')
    expect(msgs[0].parts[1]).toEqual({ kind: 'tool', name: 'bash', arg: 'ls' })
  })

  it('never renders the system prompt', () => {
    const r = paged(userMsg('hi') + ev('system.message', { role: 'system', content: 'You are the GitHub Copilot CLI SECRET-PROMPT' }))
    expect(JSON.stringify(r.messages)).not.toContain('SECRET-PROMPT')
    expect(r.messages).toHaveLength(1)
  })

  it('never renders reasoning: not the separate event, not the fields on a message', () => {
    const r = paged(
      ev('assistant.reasoning', { reasoningId: 'r', content: 'REASONING-EVENT' }) +
        asst('visible', [], { reasoningText: 'REASONING-TEXT', reasoningOpaque: 'OPAQUE', encryptedContent: 'ENC' })
    )
    const s = JSON.stringify(r.messages)
    for (const hidden of ['REASONING-EVENT', 'REASONING-TEXT', 'OPAQUE', 'ENC']) expect(s).not.toContain(hidden)
    expect(r.messages[0].parts).toEqual([{ kind: 'text', text: 'visible' }])
  })

  it('an assistant message with blank content and no tools yields nothing', () => {
    expect(paged(asst('  \n ')).messages).toEqual([])
  })
})

describe('copilot chat — tools', () => {
  it('turns toolRequests into tool parts with the id (paged) and attaches each result by call id', () => {
    const parts = partsOf(
      asst('Let me look.', [req('c1', 'bash', { command: 'echo a; echo b', description: 'Echo' }), req('c2', 'view', { path: '/x/y.txt' })]) +
        ev('tool.execution_start', { toolCallId: 'c1', toolName: 'bash', arguments: { command: 'echo a; echo b' } }) +
        failed('c2', 'Permission denied and could not request permission from user') +
        done('c1', 'a\nb\n<shellId: 0 completed with exit code 0>')
    )
    expect(parts).toEqual([
      { kind: 'text', text: 'Let me look.' },
      { kind: 'tool', name: 'bash', arg: 'echo a; echo b', result: 'a b <shellId: 0 completed with exit code 0>', id: 'c1' },
      { kind: 'tool', name: 'view', arg: '/x/y.txt', result: 'Error: Permission denied and could not request permission from user', id: 'c2' }
    ])
  })

  it('summarizes a result to its first three lines, capped at 500', () => {
    const [tool] = partsOf(asst('', [req('c1', 'bash', { command: 'x' })]) + done('c1', `l1\nl2\nl3\nl4\n${'z'.repeat(900)}`))
    expect(tool).toMatchObject({ result: 'l1 l2 l3' })
    const [big] = partsOf(asst('', [req('c2', 'bash', { command: 'x' })]) + done('c2', 'q'.repeat(900)))
    expect((big as { result: string }).result).toHaveLength(500)
  })

  it('an empty result sets nothing', () => {
    const [tool] = partsOf(asst('', [req('c1', 'create', { path: '/p' })]) + done('c1', ''))
    expect(tool).toEqual({ kind: 'tool', name: 'create', arg: '/p', id: 'c1' })
  })

  it('picks the arg by key order, caps it at 200, and takes a custom tool\'s raw string', () => {
    const arg = (name: string, a: unknown): string =>
      (partsOf(asst('', [req('c', name, a)]))[0] as { arg: string }).arg
    expect(arg('bash', { description: 'Echo', command: 'ls -la' })).toBe('ls -la')
    expect(arg('edit', { path: '/src/a.ts', old_str: 'a', new_str: 'b' })).toBe('/src/a.ts')
    expect(arg('grep', { pattern: 'TODO', paths: ['src'] })).toBe('TODO')
    expect(arg('web_fetch', { url: 'https://example.test/' })).toBe('https://example.test/')
    expect(arg('sql', { description: 'Count rows', query: 'select 1' })).toBe('select 1')
    expect(arg('task', { prompt: 'Find it', description: 'Explore', agent_type: 'explore' })).toBe('Explore')
    expect(arg('skill', { skill: 'pdf' })).toBe('pdf')
    expect(arg('read_bash', { shellId: '0' })).toBe('')
    expect(arg('apply_patch', '*** Begin Patch\n*** End Patch')).toBe('*** Begin Patch\n*** End Patch')
    expect(arg('bash', { command: 'y'.repeat(300) })).toHaveLength(200)
    // A non-string under an earlier key does not hide a string under a later one.
    expect(arg('view', { command: 7, path: '/ok' })).toBe('/ok')
  })

  it('carries a result whose call is in an OLDER window, and only on the paged read', () => {
    const r = paged(done('old-call', 'from the older page'))
    expect(r.unmatchedResults).toEqual([{ id: 'old-call', result: 'from the older page' }])
    expect(r.messages).toEqual([])
    expect(legacy(done('old-call', 'x'))).toEqual([])
  })

  it('a user-requested bash command reads like claude\'s `!` line; its result attaches', () => {
    const parts = partsOf(
      ev('tool.user_requested', { toolCallId: 'u1', toolName: 'bash', arguments: { command: '  git status  ' } }) +
        done('u1', 'clean', { isUserRequested: true }) +
        ev('tool.user_requested', { toolCallId: 'u2', toolName: 'view', arguments: { path: '/README.md' } })
    )
    expect(parts).toEqual([
      { kind: 'tool', name: '!', arg: 'git status', result: 'clean', id: 'u1' },
      { kind: 'tool', name: 'view', arg: '/README.md', id: 'u2' }
    ])
  })
})

describe('copilot chat — only the main thread', () => {
  it('drops every sub-agent event: top-level agentId, data.agentId, data.parentToolCallId', () => {
    const sub = { agentId: '59ead169-ca66-48ea-b9eb-0e5f14ecf82c' }
    const r = paged(
      userMsg('delegate please') +
        asst('Delegating.', [req('t1', 'task', { description: 'Explore', prompt: 'Find', agent_type: 'explore' })]) +
        ev('subagent.started', { toolCallId: 't1', agentName: 'explore', agentDisplayName: 'x', agentDescription: 'y' }, sub) +
        ev('user.message', { content: 'SUB-PROMPT', source: 'agent-5f0c2a9e' }, sub) +
        ev('assistant.message', { messageId: 's', model: 'sub-model', content: 'SUB-TEXT', toolRequests: [req('s1', 'bash', { command: 'SUB-CMD' })], parentToolCallId: 't1' }, sub) +
        ev('tool.execution_complete', { toolCallId: 's1', success: true, result: { content: 'SUB-RESULT' }, parentToolCallId: 't1' }, sub) +
        // The same markers, each ALONE, so no one of them carries the rule for the others.
        ev('assistant.message', { messageId: 'x', content: 'ONLY-PARENT-TOOL-CALL-ID', parentToolCallId: 't1' }) +
        ev('assistant.message', { messageId: 'y', content: 'ONLY-DATA-AGENT-ID', agentId: 'a1' }) +
        ev('assistant.message', { messageId: 'z', content: 'ONLY-ENVELOPE-AGENT-ID' }, sub) +
        ev('user.message', { content: 'ONLY-ENVELOPE-AGENT-ID-PROMPT' }, sub) +
        done('t1', 'Subagent final answer.') +
        asst('Main done.')
    )
    const s = JSON.stringify(r)
    for (const hidden of ['SUB-PROMPT', 'SUB-TEXT', 'SUB-CMD', 'SUB-RESULT', 'sub-model', 'ONLY-PARENT-TOOL-CALL-ID', 'ONLY-DATA-AGENT-ID', 'ONLY-ENVELOPE-AGENT-ID']) {
      expect(s).not.toContain(hidden)
    }
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(r.messages[1].parts[1]).toMatchObject({ name: 'task', arg: 'Explore', result: 'Subagent final answer.' })
    expect(r.unmatchedResults).toEqual([])
  })

  it('hides injected prompts the CLI\'s own timeline hides, and shows the ones it shows', () => {
    const r = paged(
      userMsg('typed', {}) +
        userMsg('typed-as-user', { source: 'user' }) +
        userMsg('SKILL-INJECTION', { source: 'skill-pdf' }) +
        userMsg('AGENT-PROMPT', { source: 'agent-123' }) +
        userMsg('WEIRD-SOURCE', { source: 42 }) +
        userMsg('ran a command', { source: 'command-review' }) +
        userMsg('scheduled prompt', { source: 'schedule-abc' }) +
        userMsg('autopilot objective', { source: 'autopilot-objective' }) +
        userMsg('', { isAutopilotContinuation: true }) +
        userMsg('   ')
    )
    expect(r.messages.map((m) => (m.parts[0] as { text: string }).text)).toEqual([
      'typed',
      'typed-as-user',
      'ran a command',
      'scheduled prompt',
      'autopilot objective'
    ])
    expect(r.messages.every((m) => m.role === 'user')).toBe(true)
  })
})

describe('copilot chat — notices and metadata', () => {
  it('shows errors, warnings and info the way copilot\'s own chat adapter does', () => {
    const r = paged(
      ev('session.error', { errorType: 'query', message: '400 synthetic upstream failure', statusCode: 400 }) +
        ev('session.warning', { warningType: 'x', message: 'careful' }) +
        ev('session.info', { infoType: 'tip', message: 'did you know' })
    )
    expect(r.messages).toEqual([
      expect.objectContaining({ role: 'assistant', parts: [{ kind: 'text', text: 'Error: 400 synthetic upstream failure' }] }),
      expect.objectContaining({ role: 'assistant', parts: [{ kind: 'text', text: 'Warning: careful' }] }),
      expect.objectContaining({ role: 'assistant', parts: [{ kind: 'text', text: 'Info: did you know' }] })
    ])
  })

  it('bookkeeping events produce no message', () => {
    const r = paged(
      ev('session.start', { sessionId: 's', version: 1, producer: 'copilot-agent', copilotVersion: '1.0.88', startTime: 't' }) +
        ev('assistant.turn_start', { turnId: '0' }) +
        ev('permission.requested', { requestId: 'p' }) +
        ev('permission.completed', { requestId: 'p' }) +
        ev('session.model_change', { newModel: 'b', previousModel: 'a' }) +
        ev('session.compaction_start', { trigger: 'threshold' }) +
        ev('session.compaction_complete', { success: true, summaryContent: 'SUMMARY' }) +
        ev('abort', { reason: 'user_initiated' }) +
        ev('system.notification', { content: 'NOTE', kind: { type: 'shell_completed', shellId: '0' } }) +
        ev('skill.invoked', { name: 'pdf', path: '/p', content: 'SKILL-BODY' }) +
        ev('session.binary_asset', { assetId: 'a', type: 'image', mimeType: 'image/png', byteLength: 3, data: 'AAAA' }) +
        ev('assistant.turn_end', { turnId: '0' }) +
        ev('session.shutdown', { shutdownType: 'routine' }) +
        ev('some.future_event', { anything: true })
    )
    expect(r.messages).toEqual([])
  })

  it('model: the newest main assistant message states it; effort is never stated', () => {
    const r = paged(asst('a', [], { model: 'gpt-5.5' }) + asst('b', [], { model: 'claude-opus-5-5' }))
    expect(r.model).toBe('claude-opus-5-5')
    expect('effort' in r).toBe(false)
  })

  it('model: a sub-agent\'s model never answers, and the newest record stating none leaves it absent', () => {
    const sub = ev('assistant.message', { messageId: 's', model: 'sub-model', content: 'x', parentToolCallId: 't' }, { agentId: 'a' })
    expect(paged(asst('a', [], { model: 'main-model' }) + sub).model).toBe('main-model')
    const noModel = ev('assistant.message', { messageId: 'n', content: 'y' })
    expect('model' in paged(asst('a', [], { model: 'main-model' }) + noModel)).toBe(false)
    expect('model' in paged(asst('a', [], { model: 'm'.repeat(101) }))).toBe(false)
    expect(paged(asst('a', [], { model: 'm'.repeat(100) })).model).toHaveLength(100)
  })
})

describe('copilot chat — hostile and malformed input', () => {
  it('skips and COUNTS a line it cannot read; never throws, never shows raw JSON', () => {
    const good = userMsg('still here')
    const bad = [
      '{broken\n',
      'null\n',
      '42\n',
      '[]\n',
      '"a string"\n',
      JSON.stringify({ data: {} }) + '\n', // no type
      JSON.stringify({ type: 'user.message' }) + '\n', // no data
      JSON.stringify({ type: 'user.message', data: [] }) + '\n', // data not an object
      ev('user.message', { content: 7 }),
      ev('assistant.message', { messageId: 'm', content: 'x', toolRequests: { not: 'an array' } }),
      ev('assistant.message', { messageId: 'm', content: 9 }),
      ev('tool.execution_complete', { success: true, result: { content: 'no id' } }),
      ev('session.error', { errorType: 'x' }), // no message
      ev('tool.user_requested', { toolName: 'bash' }) // no call id
    ]
    const text = bad.join('') + good
    const out = parseCopilotRecords(
      text.split('\n').map((raw, i) => ({ raw, offset: i })),
      true
    )
    expect(out.skipped).toBe(bad.length)
    // Only the good line is rendered — no bad line becomes a bubble of raw JSON.
    expect(out.messages.map((m) => m.parts)).toEqual([[{ kind: 'text', text: 'still here' }]])
  })

  it('a malformed tool request inside a good message is skipped alone, and counted', () => {
    const out = parseCopilotRecords(
      // `'junk'` is deliberately not a record: hostile input the types cannot rule out.
      [{ raw: asst('ok', [{ toolCallId: 'c' }, 'junk' as unknown as Rec, req('c2', 'view', { path: '/a' })]).trimEnd(), offset: 0 }],
      true
    )
    expect(out.skipped).toBe(2)
    expect(out.messages[0].parts).toEqual([
      { kind: 'text', text: 'ok' },
      { kind: 'tool', name: 'view', arg: '/a', id: 'c2' }
    ])
  })

  it('an own-property check guards the id map: `__proto__` / `constructor` ids do not reach the prototype', () => {
    const parts = partsOf(asst('', [req('constructor', 'bash', { command: 'a' })]) + done('__proto__', 'x') + done('constructor', 'ok'))
    expect(parts).toEqual([{ kind: 'tool', name: 'bash', arg: 'a', result: 'ok', id: 'constructor' }])
  })

  it('reads NOTHING from a claude transcript, and claude\'s reader reads nothing from this one', () => {
    // The two readers are not interchangeable; pointing the wrong one at a file must yield silence
    // rather than a plausible half-transcript.
    const claudeLine = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hello from claude' }] } })
    expect(chatMessagesFromCopilot(claudeLine)).toEqual([])
    expect(parseChatMessages((userMsg('from copilot') + asst('reply')).split('\n'))).toEqual([])
  })
})
