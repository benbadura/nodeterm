// `opencode export <sessionID>` — the one way nodeterm reads an opencode conversation.
//
// opencode >= 1.18 keeps sessions in SQLite (`~/.local/share/opencode/opencode.db`, which also
// holds its account tokens), so its disk is never parsed: the export is the contract. Two readers
// share this module — Context Link (flat lines, `context-link.ts`) and the ⌘M chat view
// (`opencode-chat.ts`) — so the id check and the bounds below exist once.
//
// MEASURED on opencode 1.18.25 (2026-09-28): stdout is the JSON document alone
// (`JSON.stringify(doc, null, 2)` + EOL); stderr carries `Exporting session: <id>`; an unknown id
// exits 1 with an EMPTY stdout and `Session not found: <id>` (ANSI-coloured) on stderr; an unknown
// option exits 1 (yargs strict), so no flag is passed that an older CLI might not know. One export
// costs 1.0–1.7 s wall and ~320 MB peak RSS on this host, which is why the chat view gates it
// (`createOpencodeExportGate`).
import os from 'os'
import { directExecutableInvocation } from './exec-path'

/** An export names ONE provider session. The id reaches us from a hook payload, so it is re-checked
 *  here, where it becomes an argv entry: `directExecutableInvocation` stops it being read as shell
 *  syntax, and nothing but this stops a leading `-` being read by opencode as an option. */
const SAFE_OPENCODE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/

export function isSafeOpencodeSessionId(sessionId: string): boolean {
  return SAFE_OPENCODE_SESSION_ID.test(sessionId)
}

// A whole conversation comes back on stdout. execFile's default 1 MiB buffer turns a long session
// into an error, which reads as "no transcript".
export const OPENCODE_EXPORT_MAX_BYTES = 32 * 1024 * 1024

/**
 * `ok` — the export's stdout. `absent` — opencode LOOKED and has no such session (a clean miss,
 * positive evidence). Anything else — no binary, a crash, a timeout, an oversized export — is `{ok:false}`: we could not read, which is never evidence of absence.
 */
export type OpencodeExportOutcome = { ok: true; stdout: string } | { ok: false; absent?: true }

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g

/** Callers check `isSafeOpencodeSessionId` first — this runs whatever id it is handed, exactly as
 *  `opencodeExportAt` always has (the Windows shim test hands it an id with `&` and a space to
 *  prove the shim does not reinterpret it). */
export async function runOpencodeExportAt(
  bin: string,
  sessionId: string,
  timeoutMs: number
): Promise<OpencodeExportOutcome> {
  const invocation = directExecutableInvocation(bin, ['export', sessionId])
  if (!invocation) return { ok: false }
  try {
    const { execFile } = await import('node:child_process')
    return await new Promise<OpencodeExportOutcome>((resolve) => {
      execFile(
        invocation.executable,
        invocation.args,
        {
          ...invocation.options,
          // Never the app's cwd: opencode bootstraps a project for its cwd and, inside a git repo,
          // writes `<repo>/.git/opencode`. An export resolves the session by its GLOBAL id, so a
          // neutral directory changes nothing about what is read.
          cwd: os.tmpdir(),
          encoding: 'utf-8',
          maxBuffer: OPENCODE_EXPORT_MAX_BYTES,
          timeout: timeoutMs
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ ok: true, stdout })
          // Only the measured answer about THIS id is absence: exit 1, nothing on stdout, and the
          // not-found line naming exactly the id we asked for. A killed/timed-out process has a
          // non-numeric code (or `killed`), so it can never match.
          const code = (err as { code?: unknown }).code
          const notFound =
            code === 1 &&
            !(err as { killed?: boolean }).killed &&
            stdout === '' &&
            String(stderr ?? '').replace(ANSI, '').includes(`Session not found: ${sessionId}`)
          resolve(notFound ? { ok: false, absent: true } : { ok: false })
        }
      )
    })
  } catch {
    return { ok: false }
  }
}
