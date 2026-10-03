// The ⌘M reader for a codex rollout. Every input is SYNTHETIC (codex-rollout-fake.ts), in the
// record shapes measured on real rollouts — see that file's header for the versions.
import { describe, it, expect } from 'vitest'
import {
  chatMessagesFromCodex,
  parseCodexChatRecords,
  parseCodexChatWindow,
  codexToolArg,
  codexResultSummary
} from './codex-chat'
import { parseChatWindow } from './transcript-reader'
import {
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
  rolloutLine,
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

const records = (text: string): Array<{ raw: string; offset: number }> => {
  const out: Array<{ raw: string; offset: number }> = []
  let offset = 0
  for (const raw of text.split('\n')) {
    out.push({ raw, offset })
    offset += Buffer.byteLength(raw) + 1
  }
  return out
}
const parsePaged = (text: string) => parseCodexChatRecords(records(text), true)
const texts = (msgs: ReturnType<typeof chatMessagesFromCodex>) =>
  msgs.map((m) => `${m.role}:${m.parts.map((p) => (p.kind === 'text' ? p.text : p.kind === 'tool' ? `[${p.name}] ${p.arg}` : `<${p.kind}>`)).join('|')}`)

describe('user turns', () => {
  it('reads the TYPED prompt from the UI record, never the model-side copy or the injected context (paginated)', () => {
    const msgs = chatMessagesFromCodex(
      rollout([
        sessionMeta('paginated'),
        ...injectedContext(),
        riMessage('user', ['fix the build']),
        userMessageItem(['fix the build']),
        assistantText('On it.')
      ])
    )
    expect(texts(msgs)).toEqual(['user:fix the build', 'assistant:On it.'])
  })

  it('reads the typed prompt from event_msg/user_message on the LEGACY format', () => {
    const msgs = chatMessagesFromCodex(
      rollout(
        [sessionMeta('legacy'), ...injectedContext(), userMessageEvent('why is CI red?'), riMessage('user', ['why is CI red?'])],
        'legacy'
      )
    )
    expect(texts(msgs)).toEqual(['user:why is CI red?'])
  })

  it('keeps each text item of a UserMessage as its own part and drops a pasted image', () => {
    const msgs = chatMessagesFromCodex(
      rollout([userMessageItem(['look at this', { type: 'local_image', path: '/tmp/shot.png' }, 'and this'])])
    )
    expect(msgs).toHaveLength(1)
    expect(msgs[0].parts).toEqual([
      { kind: 'text', text: 'look at this' },
      { kind: 'text', text: 'and this' }
    ])
  })

  it('an image-only or blank prompt yields no bubble (same rule as claude)', () => {
    const msgs = chatMessagesFromCodex(
      rollout([userMessageItem([{ type: 'local_image', path: '/tmp/shot.png' }]), userMessageEvent('   '), userMessageEvent(42)])
    )
    expect(msgs).toEqual([])
  })
})

describe('assistant turns', () => {
  it('renders commentary and final answers from the response_item, and skips the UI duplicates', () => {
    const msgs = chatMessagesFromCodex(
      rollout([
        assistantText('Looking at the logs.', 'commentary'),
        agentMessageItem('Looking at the logs.', 'commentary'),
        agentMessageEvent('Looking at the logs.', 'commentary'),
        assistantText('The build is fixed.'),
        agentMessageItem('The build is fixed.')
      ])
    )
    expect(texts(msgs)).toEqual(['assistant:Looking at the logs.', 'assistant:The build is fixed.'])
  })

  it('one text part per output_text item; an empty item is dropped', () => {
    const msgs = chatMessagesFromCodex(
      rollout([riMessage('assistant', ['first', { type: 'output_text', text: '' }, 'second'], 'final_answer')])
    )
    expect(msgs[0].parts).toEqual([
      { kind: 'text', text: 'first' },
      { kind: 'text', text: 'second' }
    ])
  })

  it('never renders reasoning (encrypted, and dropped for claude too)', () => {
    expect(chatMessagesFromCodex(rollout([reasoning(), reasoningItem()]))).toEqual([])
  })
})

describe('tool calls', () => {
  it('a function_call becomes a tool part and its output is attached by call_id', () => {
    const msgs = chatMessagesFromCodex(
      rollout([
        functionCall('call_1', 'exec_command', { cmd: 'npm test', workdir: '/srv/demo', max_output_tokens: 4000 }),
        functionOutput(
          'call_1',
          'Chunk ID: 7f\nWall time: 1.2 seconds\nProcess exited with code 0\nOriginal token count: 12\nOutput:\n12 passed\n0 failed'
        )
      ])
    )
    expect(msgs).toEqual([
      { role: 'assistant', parts: [{ kind: 'tool', name: 'exec_command', arg: 'npm test', result: '12 passed 0 failed' }], at: expect.any(Number) }
    ])
  })

  it('a custom tool (`exec`, JavaScript input) keeps its input as the arg and its array output as the result', () => {
    const input = 'const r = await tools.exec_command({cmd:"ls"})\ntext(r.output)'
    const msgs = chatMessagesFromCodex(
      rollout([
        customToolCall('call_2', 'exec', `  ${input}  `),
        customToolOutput('call_2', [
          { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
          { type: 'input_text', text: 'a.txt\nb.txt' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
        ])
      ])
    )
    expect(msgs[0].parts).toEqual([{ kind: 'tool', name: 'exec', arg: input, result: 'a.txt b.txt' }])
  })

  it('tool_search pairs with its output by call_id; an output with no text sets no result', () => {
    const msgs = chatMessagesFromCodex(rollout([toolSearchCall('call_3', 'calendar'), toolSearchOutput('call_3')]))
    expect(msgs[0].parts).toEqual([{ kind: 'tool', name: 'tool_search', arg: 'calendar' }])
  })

  it('an orphan output (its call is not in the read) is dropped on the unpaged read', () => {
    expect(chatMessagesFromCodex(rollout([functionOutput('call_gone', 'x')]))).toEqual([])
  })

  it('a missing / empty name falls back to "tool"', () => {
    const msgs = chatMessagesFromCodex(rollout([functionCall('c', '', { cmd: 'ls' })]))
    expect(msgs[0].parts[0]).toMatchObject({ kind: 'tool', name: 'tool', arg: 'ls' })
  })
})

describe('codexToolArg', () => {
  it('picks the first known string field, in order', () => {
    expect(codexToolArg('{"cmd":"ls -la","workdir":"/x"}')).toBe('ls -la')
    expect(codexToolArg('{"target":"/root/w","message":"please rebase"}')).toBe('please rebase')
    expect(codexToolArg({ query: 'calendar' })).toBe('calendar')
    expect(codexToolArg('{"command":["bash","-lc","make"]}')).toBe('bash -lc make')
    expect(codexToolArg('{"path":"a","cmd":"b"}')).toBe('b') // cmd outranks path
  })
  it('is empty for arguments it cannot name, never raw JSON', () => {
    expect(codexToolArg('{"duration_ms":5000}')).toBe('')
    expect(codexToolArg('not json')).toBe('')
    expect(codexToolArg('null')).toBe('')
    expect(codexToolArg('[1,2]')).toBe('')
    expect(codexToolArg('{"cmd":42}')).toBe('')
    expect(codexToolArg(undefined)).toBe('')
  })
  it('caps at 200 UTF-16 units', () => {
    expect(codexToolArg(JSON.stringify({ cmd: 'x'.repeat(300) }))).toBe('x'.repeat(200))
  })
})

describe('codexResultSummary', () => {
  it('drops the preamble up to the `Output:` line, then keeps three lines capped at 500', () => {
    expect(codexResultSummary('Chunk ID: 1\nWall time: 1s\nProcess exited with code 1\nOriginal token count: 3\nOutput:\nE1\nE2\nE3\nE4')).toBe(
      'E1 E2 E3'
    )
    expect(codexResultSummary([{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: 'y'.repeat(900) }])).toBe(
      'y'.repeat(500)
    )
  })
  it('an empty body falls back to the preamble (it still says how the call ended)', () => {
    expect(codexResultSummary('Script completed\nWall time 0.1 seconds\nOutput:\n')).toBe('Script completed Wall time 0.1 seconds')
  })
  it('text without a preamble is summarized as is; `Output:` past the sixth line is content', () => {
    expect(codexResultSummary('plain\nresult')).toBe('plain result')
    expect(codexResultSummary('1\n2\n3\n4\n5\n6\nOutput:\nx')).toBe('1 2 3')
  })
  it('non-text output yields nothing', () => {
    expect(codexResultSummary(undefined)).toBe('')
    expect(codexResultSummary({ content: 'x' })).toBe('')
    expect(codexResultSummary([{ type: 'input_image', image_url: 'data:' }])).toBe('')
  })
})

describe('notes the harness writes', () => {
  it('a failed turn shows its error message as an assistant note', () => {
    const msgs = chatMessagesFromCodex(rollout([taskFailed("You've hit your usage limit.")]))
    expect(texts(msgs)).toEqual(["assistant:[error] You've hit your usage limit."])
  })
  it('an interrupted turn says so; a non-string reason is dropped from the note', () => {
    const msgs = chatMessagesFromCodex(rollout([turnAborted('interrupted'), turnAborted(7)]))
    expect(texts(msgs)).toEqual(['assistant:[turn aborted: interrupted]', 'assistant:[turn aborted]'])
  })
  it('a completed turn, and an error with no message, show nothing', () => {
    expect(chatMessagesFromCodex(rollout([taskComplete(), taskFailed(''), taskFailed(5)]))).toEqual([])
  })
})

describe('skipped records', () => {
  const SKIPPED: CodexRec[] = [
    sessionMeta('paginated'),
    turnContext('gpt-5.6-sol', 'medium'),
    taskStarted(),
    taskComplete(),
    tokenCount(),
    tokenUsageRecord(),
    worldState(),
    threadSettingsApplied(),
    interAgentMeta(),
    compacted(),
    reasoning(),
    ...injectedContext(),
    riAgentMessage('/root/worker_1', '/root', 'done with the rebase'),
    agentMessageEvent('dup'),
    agentMessageItem('dup'),
    commandExecutionItem(),
    fileChangeItem(),
    reasoningItem(),
    extensionItem(),
    contextCompactionItem(),
    subAgentActivityItem()
  ]
  it('render nothing and are counted, never shown as raw JSON', () => {
    const out = parsePaged(rollout(SKIPPED))
    expect(out.messages).toEqual([])
    expect(out.skipped).toBe(SKIPPED.length)
  })

  it('a malformed line costs one line, never the read', () => {
    const body =
      'not json\nnull\n[1]\n"str"\n{"type":"response_item","payload":null}\n{"type":"response_item","payload":[1]}\n' +
      '{"type":"event_msg","payload":{"type":"item_completed","item":null}}\n' +
      '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":"x"}}}\n' +
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":null}}\n' +
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[null,1,{"type":"output_text","text":5}]}}\n' +
      rolloutLine(assistantText('survived'), 0)
    const out = parsePaged(body)
    expect(texts(out.messages)).toEqual(['assistant:survived'])
    expect(out.skipped).toBe(10)
  })
})

describe('timestamps, keys and model (paged)', () => {
  it('`at` is the line\'s own timestamp; keys are absolute byte offsets on the paged read only', () => {
    const body = rollout([sessionMeta('paginated'), userMessageItem(['hi']), assistantText('hello')])
    const lines = body.split('\n')
    const off1 = Buffer.byteLength(lines[0]) + 1
    const off2 = off1 + Buffer.byteLength(lines[1]) + 1
    const paged = parsePaged(body).messages
    expect(paged.map((m) => m.key)).toEqual([off1, off2])
    expect(paged.map((m) => m.at)).toEqual([Date.parse('2026-09-24T09:00:01.000Z'), Date.parse('2026-09-24T09:00:02.000Z')])
    const unpaged = chatMessagesFromCodex(body)
    expect(unpaged.every((m) => m.key === undefined)).toBe(true)
    expect(unpaged.map((m) => m.at)).toEqual(paged.map((m) => m.at))
  })

  it('a line without a valid timestamp has no `at`', () => {
    const raw = JSON.stringify({ timestamp: 'nope', type: 'event_msg', payload: { type: 'user_message', message: 'x' } })
    expect(chatMessagesFromCodex(raw)[0].at).toBeUndefined()
  })

  it('tool parts carry the call_id as `id` on the paged read only', () => {
    const body = rollout([functionCall('call_9', 'exec_command', { cmd: 'ls' })])
    expect(parsePaged(body).messages[0].parts[0]).toMatchObject({ id: 'call_9' })
    expect(chatMessagesFromCodex(body)[0].parts[0]).not.toHaveProperty('id')
  })

  it('an output whose call is in an OLDER window is carried (paged), keyed by call_id', () => {
    const out = parsePaged(rollout([customToolOutput('call_old', [{ type: 'input_text', text: 'late result' }])]))
    expect(out.messages).toEqual([])
    expect([...out.unmatched]).toEqual([['call_old', 'late result']])
  })

  it('model and effort come from the NEWEST turn_context, both from that one record', () => {
    const out = parsePaged(rollout([turnContext('gpt-5.5', 'high'), assistantText('a'), turnContext('gpt-5.6-sol', 'medium')]))
    expect(out.model).toBe('gpt-5.6-sol')
    expect(out.effort).toBe('medium')
  })

  it('an effort the newest turn_context does not state is ABSENT, never carried from an older one', () => {
    const out = parsePaged(rollout([turnContext('gpt-5.5', 'high'), turnContext('gpt-5.6-sol')]))
    expect(out.model).toBe('gpt-5.6-sol')
    expect('effort' in out).toBe(false)
  })

  it('a model that is not a short string is absent; the unpaged read reports neither', () => {
    const out = parsePaged(rollout([turnContext('m'.repeat(101), 'x'.repeat(100))]))
    expect('model' in out).toBe(false)
    expect(out.effort).toBe('x'.repeat(100))
    expect(parseCodexChatRecords(records(rollout([turnContext('gpt-5.5', 'high')])), false)).not.toHaveProperty('model')
  })
})

describe('parseCodexChatWindow', () => {
  const body = rollout([
    userMessageItem(['first']),
    assistantText('a'.repeat(300)),
    userMessageItem(['second']),
    assistantText('done')
  ])
  const buf = Buffer.from(body)

  it('splits the window exactly like claude\'s parseChatWindow (cursor, partial line, lookbehind)', () => {
    for (const start of [0, 1, 40, 200, buf.length - 30, buf.indexOf(0x0a) , buf.indexOf(0x0a) + 1]) {
      const codex = parseCodexChatWindow(buf.subarray(start), start)
      const claude = parseChatWindow(buf.subarray(start), start)
      expect(codex.olderCursor, `start ${start}`).toBe(claude.olderCursor)
      expect(codex.noCompleteLine, `start ${start}`).toBe(claude.noCompleteLine)
    }
  })

  it('returns exactly the ChatWindowParse shape — no internal counters on the wire', () => {
    const w = parseCodexChatWindow(buf, 0)
    expect(Object.keys(w).sort()).toEqual(['messages', 'noCompleteLine', 'olderCursor', 'unmatchedResults'])
    expect(texts(w.messages)).toEqual(['user:first', `assistant:${'a'.repeat(300)}`, 'user:second', 'assistant:done'])
  })

  it('a window holding no complete line says so and points before itself', () => {
    const w = parseCodexChatWindow(buf.subarray(10, 20), 10)
    expect(w).toEqual({ messages: [], olderCursor: 10, unmatchedResults: [], noCompleteLine: true })
  })

  it('carries model/effort keys only when stated', () => {
    const w = parseCodexChatWindow(Buffer.from(rollout([turnContext('gpt-5.6-sol', 'low'), assistantText('x')])), 0)
    expect(w.model).toBe('gpt-5.6-sol')
    expect(w.effort).toBe('low')
  })
})
