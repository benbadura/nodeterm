#!/usr/bin/env node

/**
 * Capture tool for the Antigravity (`agy`) chat-view device checklist
 * (docs/antigravity-agent.md §7.1 and §8, items 17–24).
 *
 * nodeterm has no ⌘M chat view for agy because the record shapes of
 * `<agy home>/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl` were never
 * captured. The agy binary describes them in prose, but a parser built from that prose would be a
 * guess. Run this on a machine with a signed-in `agy` and it prints what a parser needs: the SHAPE of
 * every line (keys, nesting, enum values, lengths), never the conversation.
 *
 * Redaction rule: every key is kept (keys are schema). A string VALUE is kept only when it looks
 * like schema: an UPPER_SNAKE enum (`PLANNER_RESPONSE`), a snake_case identifier with at least one
 * underscore (`run_command`), a UUID or an ISO 8601 timestamp. Everything else, a one-word reply
 * included, becomes `<text:N>` (N in UTF-16 units). A line that is not JSON prints its byte length
 * only. Review the output before sharing it anyway: a key can be data (a map keyed by file names).
 *
 *   node scripts/agy-transcript-shape.mjs <transcript_full.jsonl>
 *       one line per record: `<line> <byte offset> <shape>`, then a JSON summary
 *   node scripts/agy-transcript-shape.mjs <file> --snapshot <out.json>
 *       records the file's size and sha256
 *   node scripts/agy-transcript-shape.mjs <file> --compare <out.json>
 *       prints append-only | rewritten | shrunk: are the snapshot's bytes still an untouched prefix?
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const ENUM = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/

function keepString(s) {
  return ENUM.test(s) || SNAKE.test(s) || UUID.test(s) || ISO.test(s)
}

/** The value with every free-text string replaced by `<text:N>`. */
export function redactShape(v) {
  if (typeof v === 'string') return keepString(v) ? v : `<text:${v.length}>`
  if (Array.isArray(v)) return v.map(redactShape)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = redactShape(x)
    return out
  }
  return v
}

/** Every non-empty line: its 1-based number, its byte offset and its redacted shape. */
export function shapeLines(buf) {
  const out = []
  let start = 0
  let n = 0
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start)
    if (end < 0) end = buf.length
    n++
    const raw = buf.subarray(start, end)
    if (raw.length > 0) {
      let shape
      try {
        shape = redactShape(JSON.parse(raw.toString('utf8')))
      } catch {
        shape = `<non-json:${raw.length} bytes>`
      }
      out.push({ line: n, offset: start, shape })
    }
    start = end + 1
  }
  return out
}

/** A field of an already-redacted shape, as a label. */
function field(shape, k) {
  if (!shape || typeof shape !== 'object' || !(k in shape)) return '-'
  return typeof shape[k] === 'string' ? shape[k] : JSON.stringify(shape[k])
}

/** Counts of `type|source|status`, the union of keys per type, and the tool_calls element keys. */
export function summarize(buf) {
  const lines = shapeLines(buf)
  const enums = {}
  const keysByType = {}
  const toolCallKeys = new Set()
  let nonJson = 0
  for (const { shape } of lines) {
    if (typeof shape === 'string') {
      nonJson++
      continue
    }
    const tri = `${field(shape, 'type')}|${field(shape, 'source')}|${field(shape, 'status')}`
    enums[tri] = (enums[tri] ?? 0) + 1
    if (shape && typeof shape === 'object' && !Array.isArray(shape)) {
      const t = field(shape, 'type')
      const set = new Set(keysByType[t] ?? [])
      for (const k of Object.keys(shape)) set.add(k)
      keysByType[t] = [...set].sort()
      if (Array.isArray(shape.tool_calls)) {
        for (const c of shape.tool_calls) {
          if (c && typeof c === 'object' && !Array.isArray(c)) toolCallKeys.add(Object.keys(c).sort().join(','))
          else toolCallKeys.add(`<${Array.isArray(c) ? 'array' : typeof c}>`)
        }
      }
    }
  }
  return { lines: lines.length, nonJson, enums, keysByType, toolCallKeys: [...toolCallKeys].sort() }
}

export function snapshotOf(buf) {
  return { size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }
}

/** Are the snapshot's bytes still an untouched prefix of `buf`? */
export function compareSnapshot(buf, snap) {
  if (buf.length < snap.size) return 'shrunk'
  const h = createHash('sha256').update(buf.subarray(0, snap.size)).digest('hex')
  return h === snap.sha256 ? 'append-only' : 'rewritten'
}

function main(argv) {
  const [file, flag, arg] = argv
  if (!file) {
    process.stderr.write('usage: agy-transcript-shape.mjs <file> [--snapshot <out> | --compare <snap>]\n')
    return 2
  }
  const buf = fs.readFileSync(file)
  if (flag === '--snapshot' && arg) {
    fs.writeFileSync(arg, JSON.stringify(snapshotOf(buf)) + '\n')
    return 0
  }
  if (flag === '--compare' && arg) {
    process.stdout.write(compareSnapshot(buf, JSON.parse(fs.readFileSync(arg, 'utf8'))) + '\n')
    return 0
  }
  for (const l of shapeLines(buf)) process.stdout.write(`${l.line} ${l.offset} ${JSON.stringify(l.shape)}\n`)
  process.stdout.write(JSON.stringify(summarize(buf), null, 2) + '\n')
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2))
}
