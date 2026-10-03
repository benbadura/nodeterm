import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTranscriptPage, parseTranscriptWindow, transcriptPageCommand, transcriptWindowCommand } from './transcript-window'

const frame = (payload: string, status = 0): string => Buffer.from(payload + `\nNODETERM_READ_STATUS:${status}\n`).toString('base64')
describe('strict transcript window framing', () => {
  it('preserves bytes rather than re-encoding UTF-8 and trims block alignment', () => {
    const r = parseTranscriptWindow('1 1 3 0\n' + frame('aé'), 2)
    expect(r.data).toEqual(Buffer.from([0xc3]))
    expect(r.newOffset).toBe(2)
  })
  it.each([
    'bad\n', '0 5 4 0\n', '0 5 5 0\n', '0 0 0 1\nAAAA',
    '0 1 1 0\n' + frame('a', 1), '0 1 1 0\n' + frame(''),
    '0 1 1 0\n' + frame('a') + '!', '0 1 1 0\n' + Buffer.from('a').toString('base64')
  ])('rejects malformed, oversized, failed or short responses: %s', response => {
    expect(() => parseTranscriptWindow(response, 4)).toThrow()
  })
  it.each([-1, 1.5, NaN, Infinity])('rejects an invalid offset %s before invoking a shell', offset => {
    expect(() => transcriptWindowCommand('/fixture', offset, 1024)).toThrow()
  })
  it('reads the absent marker as an empty, absent window — and only the exact marker', () => {
    expect(parseTranscriptWindow('NODETERM_ABSENT\n', 4)).toMatchObject({ absent: true, data: Buffer.alloc(0) })
    for (const reply of ['NODETERM_ABSENT', 'NODETERM_ABSENT\n0 0 0 1\n', 'x NODETERM_ABSENT\n']) {
      expect(() => parseTranscriptWindow(reply, 4)).toThrow()
    }
  })
  it.each([0, -1, 1.5, Infinity, 1024 * 1024 + 1])('rejects an invalid cap %s', cap => {
    expect(() => transcriptWindowCommand('/fixture', null, cap)).toThrow()
  })
})

// Generated shell: run it for real, as the other remote scripts are (a composed fixture cannot tell
// you what `sh` does with it).
describe.skipIf(process.platform === 'win32')('transcript window command under a real /bin/sh', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nt-window-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const run = (path: string, offset: number | null): string =>
    execFileSync('/bin/sh', ['-c', transcriptWindowCommand(path, offset, 1024)], { encoding: 'utf8' })

  it('answers a missing file — or a missing project directory — with the marker and status 0', () => {
    for (const path of [join(dir, "not ' yet.jsonl"), join(dir, 'no-project-dir', 'x.jsonl')]) {
      const stdout = run(path, null)
      expect(stdout).toBe('NODETERM_ABSENT\n')
      expect(parseTranscriptWindow(stdout, 1024).absent).toBe(true)
    }
  })
  it('still reads an existing file, empty or not', () => {
    const path = join(dir, "here ' now.jsonl")
    writeFileSync(path, '')
    expect(parseTranscriptWindow(run(path, null), 1024)).toMatchObject({ initial: true, newOffset: 0, data: Buffer.alloc(0) })
    writeFileSync(path, 'abc\n')
    const r = parseTranscriptWindow(run(path, null), 1024)
    expect(r).toMatchObject({ initial: true, start: 0, newOffset: 4 })
    expect(r.absent).toBeUndefined()
    expect(r.data.toString()).toBe('abc\n')
  })
})

describe('paged transcript read (⌘M panel) framing', () => {
  it('trims block alignment to exactly the asked range, lookbehind byte included', () => {
    const r = parseTranscriptPage('1 2 3\n' + frame('aéb'), null, 1)
    expect(r.data).toEqual(Buffer.from('é'))
    expect(r).toMatchObject({ start: 1, end: 3, size: 3 })
  })
  it('an empty file is a valid empty page', () => {
    expect(parseTranscriptPage('0 0 0\n', null, 65536)).toMatchObject({ start: 0, end: 0, size: 0 })
  })
  it.each([
    'bad\n', '0 5 4\n', '0 1 1 0\n' + frame('a'), '0 0 0\nAAAA',
    '0 1 1\n' + frame('a', 1), '0 1 1\n' + frame(''), '0 1 1\n' + Buffer.from('a').toString('base64')
  ])('rejects malformed, failed or short responses: %s', response => {
    expect(() => parseTranscriptPage(response, null, 65536)).toThrow()
  })
  it('rejects a reply wider than maxBytes + the lookbehind byte', () => {
    expect(() => parseTranscriptPage('0 3 3\n' + frame('abc'), null, 1)).toThrow()
    expect(parseTranscriptPage('0 2 2\n' + frame('ab'), null, 1).data.toString()).toBe('ab')
  })
  // The header is the host's word about WHICH window it read. A reply for another window than the
  // one asked for (a desynced master, a stale command) would splice the wrong history in under keys
  // that look right — so the window is re-derived here and compared, not trusted.
  it.each([
    ['end short of EOF when no `before` was asked', '0 1 3\n' + frame('a'), null, 65536],
    ['end past the asked `before`', '0 3 3\n' + frame('abc'), 2, 65536],
    ['end short of the asked `before`', '0 1 3\n' + frame('a'), 2, 65536],
    ['a `before` past EOF must end at EOF', '0 2 3\n' + frame('ab'), 10, 65536],
    ['start not where the window + lookbehind begins', '0 3 3\n' + frame('abc'), null, 1]
  ])('rejects a reply for another window than the one asked: %s', (_why, response, before, maxBytes) => {
    expect(() => parseTranscriptPage(response, before, maxBytes)).toThrow(/range/)
  })
  it('accepts the exact window for a `before` inside, and past, the file', () => {
    expect(parseTranscriptPage('0 2 3\n' + frame('ab'), 2, 65536)).toMatchObject({ start: 0, end: 2, size: 3 })
    expect(parseTranscriptPage('0 3 3\n' + frame('abc'), 10, 65536)).toMatchObject({ start: 0, end: 3, size: 3 })
  })
  it('rejects a reply with no newline at all — even one whose text would parse as a header', () => {
    // `'0 0 00'.slice(0, -1)` is '0 0 0': without the explicit check this read as an empty page.
    expect(() => parseTranscriptPage('0 0 00', null, 65536)).toThrow(/header/)
    expect(() => parseTranscriptPage('', null, 65536)).toThrow(/header/)
  })
  it.each([-1, 1.5, NaN, Infinity])('rejects an invalid before %s before invoking a shell', before => {
    expect(() => transcriptPageCommand('/fixture', before, 65536)).toThrow()
  })
  it.each([0, -1, 1.5, Infinity, 5 * 1024 * 1024 + 1])('rejects an invalid maxBytes %s', maxBytes => {
    expect(() => transcriptPageCommand('/fixture', null, maxBytes)).toThrow()
  })
})
