// Reads remote files over the project's existing ControlMaster (`ssh <childArgs> 'tail …'`).
// Pure builders + an injected-runner class so the read logic is electron-free and unit-testable;
// the actual ssh spawn is injected by the caller (Tasks 2/3 wire it to the project's runner).
import {
  transcriptWindowCommand,
  parseTranscriptWindow,
  transcriptPageCommand,
  parseTranscriptPage,
  type TranscriptWindow,
  type TranscriptPage
} from '../../core/remote-ssh/transcript-window'
import { childArgs } from '../../core/remote-ssh/control-master'
import { posixQuote, type SshConnection } from '../../shared/ssh'

export interface RemoteFileRef {
  conn: SshConnection
  controlPath: string
  path: string
}

export function tailFromOffsetArgs(conn: SshConnection, controlPath: string, path: string, offset: number): string[] {
  return childArgs(conn, controlPath, `tail -c +${offset + 1} ${posixQuote(path)}`)
}
export function tailFromOffsetCappedArgs(
  conn: SshConnection,
  controlPath: string,
  path: string,
  offset: number,
  maxBytes: number
): string[] {
  // base64 wraps at 76 cols on GNU and not at all on BSD — the reader strips whitespace, so
  // no -w flag is used (macOS/BSD base64 has none).
  return childArgs(conn, controlPath, `tail -c +${offset + 1} ${posixQuote(path)} | head -c ${maxBytes} | base64`)
}
export function tailLastBytesArgs(conn: SshConnection, controlPath: string, path: string, bytes: number): string[] {
  return childArgs(conn, controlPath, `tail -c ${bytes} ${posixQuote(path)}`)
}

/**
 * A failed strict context read, with a `reason` the poller can log. The reason states only what was
 * observed — the exit status, or that the reply did not parse — never the command, the path or the
 * remote output, and never a guessed cause: the runner reports a timeout as status 1 (measured: a
 * killed ssh has no status, which the runner maps to 1), the same as a remote command that exited 1,
 * so a status is all it can honestly say. (255 is ssh's own status: no master, host unreachable,
 * authentication.)
 */
export class ContextReadError extends Error {
  constructor(readonly reason: string) {
    super(`Remote transcript read failed (${reason})`)
  }
}

/** Reads over the project's ControlMaster. Legacy methods fail open; context reads throw. */
export class RemoteFile {
  constructor(private run: (args: string[]) => Promise<{ code: number; stdout: string }>) {}

  /** Strict snapshot read for the context poller: failure must trigger backoff, not look idle. */
  async readContextWindow(ref: RemoteFileRef, offset: number | null, cap: number): Promise<TranscriptWindow> {
    const command = transcriptWindowCommand(ref.path, offset, cap)
    let result: { code: number; stdout: string }
    try {
      result = await this.run(childArgs(ref.conn, ref.controlPath, command))
    } catch {
      throw new ContextReadError('runner error')
    }
    const code: unknown = result.code
    if (typeof code !== 'number') {
      // The runner passes execFile's error code through, which is a Node identifier rather than a
      // status when ssh never produced one (ENOENT, ERR_CHILD_PROCESS_STDIO_MAXBUFFER).
      throw new ContextReadError(typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'runner error')
    }
    if (code !== 0) throw new ContextReadError(`exit ${code}`)
    try {
      return parseTranscriptWindow(result.stdout, cap)
    } catch {
      throw new ContextReadError('malformed reply')
    }
  }

  /**
   * One PAGE of a transcript for the ⌘M panel — a ranged read (window end + size in the same round
   * trip) instead of `readTail`'s whole 5 MB. STRICT like `readContextWindow`: a failed or malformed
   * read throws, because the caller must be able to tell "the host could not be read" from "an
   * empty page" (the latter is a real answer for an empty transcript).
   */
  async readTranscriptPage(ref: RemoteFileRef, before: number | null, maxBytes: number): Promise<TranscriptPage> {
    const { code, stdout } = await this.run(childArgs(ref.conn, ref.controlPath,
      transcriptPageCommand(ref.path, before, maxBytes)))
    if (code !== 0) throw new Error('Remote transcript command failed')
    return parseTranscriptPage(stdout, before, maxBytes)
  }

  async readFrom(ref: RemoteFileRef, offset: number): Promise<{ text: string; newOffset: number }> {
    try {
      const { code, stdout } = await this.run(tailFromOffsetArgs(ref.conn, ref.controlPath, ref.path, offset))
      if (code !== 0) return { text: '', newOffset: offset }
      return { text: stdout, newOffset: offset + Buffer.byteLength(stdout) }
    } catch {
      return { text: '', newOffset: offset }
    }
  }

  /** Capped, byte-exact read: base64 round-trips the bytes so a mid-multibyte cut cannot
   *  corrupt the offset accounting (stdout is a decoded string — see tailFromOffsetCappedArgs).
   *  Fail-open: errors → empty buffer, offset unchanged. */
  async readFromCapped(
    ref: RemoteFileRef,
    offset: number,
    maxBytes: number
  ): Promise<{ data: Buffer; newOffset: number }> {
    try {
      const { code, stdout } = await this.run(
        tailFromOffsetCappedArgs(ref.conn, ref.controlPath, ref.path, offset, maxBytes)
      )
      if (code !== 0) return { data: Buffer.alloc(0), newOffset: offset }
      const data = Buffer.from(stdout.replace(/\s+/g, ''), 'base64')
      return { data, newOffset: offset + data.length }
    } catch {
      return { data: Buffer.alloc(0), newOffset: offset }
    }
  }

  async readTail(ref: RemoteFileRef, bytes: number): Promise<string> {
    try {
      const { code, stdout } = await this.run(tailLastBytesArgs(ref.conn, ref.controlPath, ref.path, bytes))
      return code === 0 ? stdout : ''
    } catch {
      return ''
    }
  }
}
