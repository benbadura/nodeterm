import { Terminal, type ITerminalAddon } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'

// @xterm/addon-serialize's published types are written against @xterm/xterm's (browser) Terminal,
// which has a superset of DOM-specific members @xterm/headless's Terminal lacks. The addon only
// ever touches buffer/modes/cols/rows at runtime — all present on the headless Terminal — so this
// is a real type mismatch between two packages that are runtime-compatible, not a runtime risk.

/**
 * One session's server-side screen. This is the piece that makes the session host able to
 * reconstruct a fresh client's screen on attach WITHOUT itself being a "painter" the way a real
 * tmux client is — see docs/windows-session-host.md ("The seeding trap") before touching any of
 * this, and CLAUDE.md's "Seeding a fresh xterm" section for why a tmux-shaped answer here
 * (seed nothing on warm attach) would ship a blank terminal or duplicated screens depending on
 * which half you got wrong.
 *
 * MODE RESTORATION, VERIFIED NOT ASSUMED: xterm.js's own `SerializeAddon` already restores most
 * DEC private modes as part of its `serialize()` output (bracketed paste, application cursor
 * keys, origin mode, insert mode, reverse-wraparound, send-focus, wraparound, and — when the
 * active buffer is the alternate screen — the `?1049h` switch). Read directly from the compiled
 * `_serializeModes()` in `node_modules/@xterm/addon-serialize/lib/addon-serialize.js` rather than
 * assumed from the docs. It does NOT emit `CSI ?1006h` (SGR extended mouse coordinates) — there
 * is no separate field on the public `IModes` API for it to read; `modes.mouseTrackingMode` only
 * says which tracking PROTOCOL is on (x10/vt200/drag/any), not the coordinate ENCODING. This app
 * always turns mouse tracking on together with SGR (`CO_ATTACH_MOUSE_SEQ` in the renderer mirrors
 * real tmux's `mouse on`, which always pairs `?1000h`/`?1002h` with `?1006h`), so that one
 * sequence is appended by hand below whenever tracking is active. If a future xterm.js version
 * starts emitting it itself, appending it twice is a harmless idempotent DECSET, not a bug.
 */
/** Where a swallowed parser exception is reported. The session host points this at its own log;
 *  the default stays silent rather than writing to a console nobody reads. */
let reportParseError: (detail: string) => void = () => {}
export function setEmulatorParseErrorReporter(fn: (detail: string) => void): void {
  reportParseError = fn
}

/** The private xterm internals `guardWriteBuffer` patches, pinned by terminal-emulator.test.ts. */
interface XtermWriteInternals {
  _core?: {
    _writeBuffer?: { _action?: (data: string | Uint8Array, promiseResult?: boolean) => unknown }
    _inputHandler?: { _parser?: { reset?: () => void } }
  }
}

/**
 * ONE parser exception must not wedge the emulator for the rest of the session's life.
 *
 * xterm's WriteBuffer runs the parser from a `setTimeout`. When the parser throws, the throw
 * escapes `_innerWrite` before that chunk's callback runs and before the next turn is scheduled,
 * so every later `write` is queued behind it forever and its callback never fires (measured on
 * @xterm/headless 6.0.0). In the session host every screen read waits on that callback
 * (`HostSession.outputTail`), so a single throw turned into: `attachExisting` timing out on every
 * reattach (the client then drops the whole socket, detaching every other terminal too), sendKeys
 * and captures hanging, and the output backlog pausing the ConPTY so the program in the pane froze.
 * The host process outlives the app, so an app restart did not clear it.
 *
 * The guard catches the throw at the parse call, resets the parser to ground state (otherwise the
 * next bytes are read as the rest of the broken sequence) and lets the write complete. The rest of
 * that one chunk is lost from the server-side screen; the pty itself is untouched.
 */
function guardWriteBuffer(term: Terminal): boolean {
  const core = (term as unknown as XtermWriteInternals)._core
  const buffer = core?._writeBuffer
  const original = buffer?._action
  if (!buffer || typeof original !== 'function') return false
  let reported = 0
  buffer._action = (data, promiseResult) => {
    try {
      return original(data, promiseResult)
    } catch (error) {
      try {
        core?._inputHandler?._parser?.reset?.()
      } catch {
        /* a parser that cannot reset still must not wedge the buffer */
      }
      // Bounded: a pane that keeps producing the bad sequence must not flood the host log. The
      // chunk itself is never logged — it is the user's terminal output.
      if (reported++ < 20) {
        const e = error as Error
        reportParseError(`emulator parse error (chunk dropped): ${e?.stack ?? String(error)}`)
      }
      return undefined
    }
  }
  return true
}

export class TerminalEmulator {
  private readonly term: Terminal
  private readonly serializer: SerializeAddon
  private readonly defaultScrollback: number

  constructor(opts: { cols: number; rows: number; scrollback: number }) {
    this.defaultScrollback = Math.max(0, opts.scrollback)
    this.term = new Terminal({
      cols: Math.max(1, opts.cols),
      rows: Math.max(1, opts.rows),
      scrollback: this.defaultScrollback,
      allowProposedApi: true
    })
    if (!guardWriteBuffer(this.term)) {
      reportParseError('emulator parse guard not installed: xterm write-buffer internals changed')
    }
    this.serializer = new SerializeAddon()
    this.term.loadAddon(this.serializer as unknown as ITerminalAddon)
  }

  /**
   * Feed one chunk of PTY output. Resolves once xterm has fully applied it — `Terminal.write`'s
   * own write queue can defer processing of a large chunk past the current tick, and a caller
   * that called `serialize()` without waiting for this would race a partially-applied write (the
   * screen it hands back could be missing the tail of what just arrived).
   */
  write(data: string): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve))
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.term.resize(cols, rows)
  }

  /**
   * The reconstructed screen: serialized content (scrollback capped at `scrollback`, defaulting
   * to this emulator's construction-time cap — smaller for `captureSession`'s "recent lines"
   * callers) plus the mode-restore/alt-buffer/cursor tail `SerializeAddon` already produces, with
   * the SGR-mouse gap above patched in by hand. Returns '' for a session that has never painted
   * anything (a cold session moments after spawn) — callers treat '' the same way the rest of
   * this app already treats an empty tmux capture: "nothing to seed", never a screen reset.
   */
  serialize(scrollback = this.defaultScrollback): string {
    let out = this.serializer.serialize({ scrollback: Math.max(0, scrollback) })
    if (this.term.modes.mouseTrackingMode !== 'none' && !out.includes('\x1b[?1006h')) {
      out += '\x1b[?1006h'
    }
    return out
  }

  /**
   * Has the app running in this session REQUESTED bracketed paste (`CSI ?2004h`)?
   *
   * This is the session host's answer to the question `paste-buffer -p` asks tmux's pane state,
   * and it is answerable here for a reason the tmux side cannot claim: the emulator is fed the
   * session's OWN pty output, so a `?2004h` it saw was written by the app in the pane. (The
   * tombstone in `pty-manager.ts` for `bracketPasteRequested` and CLAUDE.md's "the emulator is
   * NOT the answer here" both concern a RENDERER xterm attached as a tmux CLIENT, where the mode
   * it observes is tmux's own paste-through on the outer terminal and reads true for every pane.
   * No tmux sits between this emulator and the pane's app.)
   *
   * Read through `HostSession.bracketedPasteRequested()`, never directly: emulator writes are
   * queued, so the answer is only current behind `outputTail`.
   */
  bracketedPasteRequested(): boolean {
    return this.term.modes.bracketedPasteMode
  }

  dispose(): void {
    try {
      this.serializer.dispose()
    } catch {
      /* already disposed */
    }
    try {
      this.term.dispose()
    } catch {
      /* already disposed */
    }
  }
}
