import { afterEach, describe, expect, it } from 'vitest'
import { TerminalEmulator, setEmulatorParseErrorReporter } from './terminal-emulator'

type ParserHost = {
  term: {
    parser: {
      registerCsiHandler(id: { prefix?: string; final: string }, cb: () => boolean): unknown
    }
  }
}

/** Resolves to 'timeout' instead of hanging the test when a write never completes. */
function within<T>(p: Promise<T>, ms = 1000): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))])
}

describe('TerminalEmulator parse guard', () => {
  afterEach(() => setEmulatorParseErrorReporter(() => {}))

  it('installs on the pinned xterm internals', () => {
    const reports: string[] = []
    setEmulatorParseErrorReporter((d) => reports.push(d))
    const emu = new TerminalEmulator({ cols: 40, rows: 5, scrollback: 100 })
    expect(reports).toEqual([])
    emu.dispose()
  })

  it('keeps writing after the parser throws instead of wedging every later write', async () => {
    // Unguarded, @xterm/headless 6.0.0 never runs another write callback after one parser throw,
    // so the session host's outputTail (and every attach/serialize behind it) hung for good.
    const reports: string[] = []
    setEmulatorParseErrorReporter((d) => reports.push(d))
    const emu = new TerminalEmulator({ cols: 40, rows: 5, scrollback: 100 })
    ;(emu as unknown as ParserHost).term.parser.registerCsiHandler(
      { prefix: '>', final: 'q' },
      () => {
        throw new Error('boom')
      }
    )
    await emu.write('one ')
    expect(await within(emu.write('\x1b[>qlost'))).toBeUndefined()
    expect(await within(emu.write(' three'))).toBeUndefined()
    // The parser is back in ground state: the next chunk is text, not the tail of a sequence.
    expect(emu.serialize()).toContain('one  three')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('boom')
    emu.dispose()
  })
})
