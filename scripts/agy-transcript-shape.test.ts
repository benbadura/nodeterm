import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  redactShape,
  shapeLines,
  summarize,
  snapshotOf,
  compareSnapshot
  // @ts-expect-error — plain .mjs repo tooling, deliberately outside the typechecked projects.
} from './agy-transcript-shape.mjs'

// Synthetic lines in the shape the agy 1.2.12 binary DESCRIBES (docs/antigravity-agent.md §7.1).
// They are inputs to a redaction tool, not a claim about the real format.
const USER =
  '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE",' +
  '"created_at":"2026-09-28T10:00:00.123Z","content":"please list my secret files in /home/x"}'
const MODEL =
  '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",' +
  '"content":"Sure. Here","thinking":"the user wants","tool_calls":' +
  '[{"name":"run_command","args":{"CommandLine":"ls -la ~","WaitMsBeforeAsync":500}}]}'

describe('redactShape', () => {
  it('replaces free text with its length and keeps enum-like values', () => {
    expect(redactShape(JSON.parse(USER))).toEqual({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-09-28T10:00:00.123Z',
      content: '<text:38>'
    })
  })

  it('walks nested objects and arrays, keeping snake_case identifiers and numbers', () => {
    const s = redactShape(JSON.parse(MODEL))
    expect(s.tool_calls).toEqual([
      { name: 'run_command', args: { CommandLine: '<text:8>', WaitMsBeforeAsync: 500 } }
    ])
    expect(s.thinking).toBe('<text:14>')
  })

  it('never keeps a single ordinary word, a sentence or a path', () => {
    // A one-word reply is conversation, not schema; `Sure.` would pass an identifier regex.
    for (const v of ['hi', 'Sure.', 'Hello world', '/home/x/.ssh/id_rsa', 'C:\\Users\\x', 'Ok']) {
      expect(redactShape(v), v).toBe(`<text:${v.length}>`)
    }
  })

  it('keeps UUIDs (conversation ids) and ISO timestamps, which are schema, not content', () => {
    expect(redactShape('00000000-0000-4000-8000-000000000001')).toBe(
      '00000000-0000-4000-8000-000000000001'
    )
    expect(redactShape('2026-09-28T10:00:00Z')).toBe('2026-09-28T10:00:00Z')
    expect(redactShape('2026-09-28T10:00:00+03:00')).toBe('2026-09-28T10:00:00+03:00')
  })

  it('keeps booleans, null and numbers as they are', () => {
    expect(redactShape({ a: true, b: null, c: 1.5 })).toEqual({ a: true, b: null, c: 1.5 })
  })
})

describe('shapeLines', () => {
  it('reports each line with its byte offset and never echoes a non-JSON line', () => {
    const text = `${USER}\nnot json: my password is hunter2\n\n${MODEL}\n`
    const out = shapeLines(Buffer.from(text, 'utf8'))
    expect(out.map((l: { offset: number }) => l.offset)).toEqual([
      0,
      Buffer.byteLength(USER) + 1,
      Buffer.byteLength(`${USER}\nnot json: my password is hunter2\n\n`)
    ])
    expect(out[1].shape).toBe('<non-json:32 bytes>')
    expect(JSON.stringify(out)).not.toContain('hunter2')
    expect(JSON.stringify(out)).not.toContain('secret')
  })

  it('counts offsets in BYTES, not UTF-16 units', () => {
    const first = '{"content":"çok güzel 🧪"}'
    const out = shapeLines(Buffer.from(`${first}\n{"a":1}\n`, 'utf8'))
    expect(out[1].offset).toBe(Buffer.byteLength(first, 'utf8') + 1)
  })
})

describe('summarize', () => {
  it('tallies type/source/status, the keys per type and the tool_calls element keys', () => {
    const s = summarize(Buffer.from(`${USER}\n${MODEL}\n{"type":"RUN_COMMAND","content":"x y"}\n`))
    expect(s.lines).toBe(3)
    expect(s.nonJson).toBe(0)
    expect(s.enums).toEqual({
      'USER_INPUT|USER_EXPLICIT|DONE': 1,
      'PLANNER_RESPONSE|MODEL|DONE': 1,
      'RUN_COMMAND|-|-': 1
    })
    expect(s.keysByType.PLANNER_RESPONSE).toEqual([
      'content',
      'source',
      'status',
      'step_index',
      'thinking',
      'tool_calls',
      'type'
    ])
    expect(s.toolCallKeys).toEqual(['args,name'])
    expect(JSON.stringify(s)).not.toContain('Sure')
  })

  it('redacts a non-enum type value rather than printing it as a key', () => {
    const s = summarize(Buffer.from('{"type":"a sentence someone typed","content":"x"}\n'))
    expect(Object.keys(s.enums)).toEqual(['<text:24>|-|-'])
    expect(Object.keys(s.keysByType)).toEqual(['<text:24>'])
  })
})

describe('snapshot / compare (is the file append-only?)', () => {
  const before = Buffer.from(`${USER}\n`)
  const snap = snapshotOf(before)

  it('records the size and the sha256 of the bytes', () => {
    expect(snap).toEqual({ size: before.length, sha256: createHash('sha256').update(before).digest('hex') })
  })

  it('answers append-only when the old bytes are an untouched prefix', () => {
    expect(compareSnapshot(Buffer.concat([before, Buffer.from(`${MODEL}\n`)]), snap)).toBe('append-only')
  })

  it('answers rewritten when an old line changed in place (a status flip)', () => {
    const flipped = Buffer.from(`${USER.replace('"DONE"', '"RUNS"')}\n${MODEL}\n`)
    expect(compareSnapshot(flipped, snap)).toBe('rewritten')
  })

  it('answers shrunk when the file got smaller', () => {
    expect(compareSnapshot(before.subarray(0, 10), snap)).toBe('shrunk')
  })
})
