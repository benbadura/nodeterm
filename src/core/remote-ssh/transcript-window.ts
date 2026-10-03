import { posixQuote } from '../../shared/ssh'
import { CHAT_PAGE_MAX_BYTES } from '../../shared/chat-page'

const BLOCK = 65536
const STATUS = '\nNODETERM_READ_STATUS:0\n'
const ABSENT = 'NODETERM_ABSENT'

/** One size snapshot and at most cap + two blocks of file bytes. POSIX sh + BSD/GNU dd.
 * The dd status travels INSIDE base64: pipeline success alone hides a failed file read.
 * A path that does not exist answers `NODETERM_ABSENT` with status 0: Claude creates its transcript
 * on the first prompt while SessionStart already hands us the path, so an unused session has no
 * file for as long as it stays unused (measured on 2.1.283). That is an answer, not a failed read. */
export function transcriptWindowCommand(path: string, offset: number | null, cap: number): string {
  if ((offset !== null && (!Number.isSafeInteger(offset) || offset < 0)) ||
      !Number.isSafeInteger(cap) || cap < 1 || cap > 1024 * 1024) throw new Error('Invalid transcript read bounds')
  return `if [ ! -e ${posixQuote(path)} ]; then echo ${ABSENT}; exit 0; fi
exec 3< ${posixQuote(path)} || exit 1
size=$(wc -c < ${posixQuote(path)}) || exit 1
size=$((size + 0))
start=${offset ?? -1}
initial=0
if [ "$start" -lt 0 ] || [ "$size" -lt "$start" ]; then
  initial=1
  start=$((size > ${cap} ? size - ${cap} : 0))
fi
count=$((size - start))
if [ "$count" -gt ${cap} ]; then count=${cap}; fi
printf '%s %s %s %s\n' "$start" "$count" "$size" "$initial"
if [ "$count" -gt 0 ]; then
  skip=$((start / ${BLOCK}))
  blocks=$(((start % ${BLOCK} + count + ${BLOCK - 1}) / ${BLOCK}))
  { dd bs=${BLOCK} skip="$skip" count="$blocks" <&3 2>/dev/null; result=$?; printf '\nNODETERM_READ_STATUS:%s\n' "$result"; } | base64
fi`
}

export interface TranscriptWindow {
  data: Buffer
  start: number
  newOffset: number
  initial: boolean
  /** The file does not exist (yet). `data` is empty and the offsets carry no meaning. */
  absent?: boolean
}

export function parseTranscriptWindow(stdout: string, cap: number): TranscriptWindow {
  if (stdout === `${ABSENT}\n`) return { data: Buffer.alloc(0), start: 0, newOffset: 0, initial: false, absent: true }
  const end = stdout.indexOf('\n')
  const match = /^(\d+) (\d+) (\d+) ([01])$/.exec(stdout.slice(0, end))
  if (!match) throw new Error('Invalid transcript read header')
  const [start, count, size, initial] = match.slice(1).map(Number)
  if (![start, count, size].every(Number.isSafeInteger) || count > cap || start + count > size) {
    throw new Error('Invalid transcript read range')
  }
  const data = decodeFramedBlocks(stdout.slice(end + 1), start, count, cap)
  return { data, start, newOffset: start + count, initial: !!initial }
}

/** Decode the base64 dd payload shared by both commands: verify the in-band dd status, then trim
 *  the block alignment back to exactly `count` bytes from `start`. */
function decodeFramedBlocks(payload: string, start: number, count: number, cap: number): Buffer {
  const encoded = payload.replace(/\s/g, '')
  if (!count) {
    if (encoded) throw new Error('Unexpected transcript read payload')
    return Buffer.alloc(0)
  }
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.toString('base64') !== encoded || !decoded.subarray(-STATUS.length).equals(Buffer.from(STATUS))) {
    throw new Error('Failed transcript read')
  }
  const bytes = decoded.subarray(0, -STATUS.length)
  const leading = start % BLOCK
  if (bytes.length < leading + count || bytes.length > cap + 2 * BLOCK) throw new Error('Short or oversized transcript read')
  return bytes.subarray(leading, leading + count)
}

/**
 * The ⌘M panel's PAGED read (`chat:read-transcript` with a page): at most `maxBytes` ending at
 * byte offset `before` (`null`, or past EOF = the file size), plus ONE byte of lookbehind when the
 * window does not start at 0 — `parseChatWindow` needs it to recognize a line that begins exactly
 * on the window edge. One round trip answers the size too, which is what "the end of the file"
 * means on the host.
 *
 * Same shape and guarantees as `transcriptWindowCommand` above (read-forward, for the context
 * tail): one fd opened up front, the size snapshotted once, whole dd blocks read and trimmed by
 * the parser, and the dd exit status carried INSIDE the base64 so a failed read cannot pass for a
 * short one. Only integers we validated here and a `posixQuote`d path reach the line; the path is
 * already jailed by `isSafeRemoteTranscriptPath` before any caller gets here.
 */
export function transcriptPageCommand(path: string, before: number | null, maxBytes: number): string {
  if ((before !== null && (!Number.isSafeInteger(before) || before < 0)) ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CHAT_PAGE_MAX_BYTES) {
    throw new Error('Invalid transcript page bounds')
  }
  return `exec 3< ${posixQuote(path)} || exit 1
size=$(wc -c < ${posixQuote(path)}) || exit 1
size=$((size + 0))
end=${before ?? -1}
if [ "$end" -lt 0 ] || [ "$end" -gt "$size" ]; then end=$size; fi
start=$((end > ${maxBytes} ? end - ${maxBytes} - 1 : 0))
count=$((end - start))
printf '%s %s %s\n' "$start" "$count" "$size"
if [ "$count" -gt 0 ]; then
  skip=$((start / ${BLOCK}))
  blocks=$(((start % ${BLOCK} + count + ${BLOCK - 1}) / ${BLOCK}))
  { dd bs=${BLOCK} skip="$skip" count="$blocks" <&3 2>/dev/null; result=$?; printf '\nNODETERM_READ_STATUS:%s\n' "$result"; } | base64
fi`
}

export interface TranscriptPage {
  /** Bytes `[start, end)` of the file — `start` includes the lookbehind byte, when there is one. */
  data: Buffer
  start: number
  end: number
  size: number
}

/**
 * Strict parser for `transcriptPageCommand`'s reply: anything malformed, short or failed throws.
 *
 * `before` / `maxBytes` are what was ASKED, and the reply must be exactly that window: the header's
 * range is re-derived from them and the reported size (`end = min(before ?? size, size)`, `start =
 * end - maxBytes - 1` or 0) rather than trusted. A reply for some other window — a desynced master,
 * a stale command — would otherwise splice the wrong bytes into the panel under keys (absolute
 * offsets) that look perfectly valid.
 */
export function parseTranscriptPage(stdout: string, before: number | null, maxBytes: number): TranscriptPage {
  const nl = stdout.indexOf('\n')
  // Explicit: with no newline, `slice(0, -1)` would drop the reply's last character and could
  // leave a well-formed header behind ('0 0 00' → '0 0 0', an "empty page").
  if (nl < 0) throw new Error('Invalid transcript page header')
  const match = /^(\d+) (\d+) (\d+)$/.exec(stdout.slice(0, nl))
  if (!match) throw new Error('Invalid transcript page header')
  const [start, count, size] = match.slice(1).map(Number)
  // +1: the lookbehind byte rides on top of the window.
  const cap = maxBytes + 1
  if (![start, count, size].every(Number.isSafeInteger) || count > cap || start + count > size) {
    throw new Error('Invalid transcript page range')
  }
  const end = before === null ? size : Math.min(before, size)
  if (start + count !== end || start !== (end > maxBytes ? end - maxBytes - 1 : 0)) {
    throw new Error('Invalid transcript page range: not the window asked for')
  }
  const data = decodeFramedBlocks(stdout.slice(nl + 1), start, count, cap)
  return { data, start, end: start + count, size }
}
