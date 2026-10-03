// Reading a REMOTE (SSH-project) grok node's conversation ON ITS HOST.
//
// A remote grok session's `chat_history.jsonl` lives on the host, under the host's `$GROK_HOME`.
// Nothing on this machine can stand in for it: the desktop's hook listener derives a session
// directory from the LOCAL sessions root and the host's cwd (a path on the wrong machine), so every
// local locator is wrong by construction for these nodes. This module is therefore the only way a
// remote grok node's ⌘M panel — and the phone's Chat screen, which reads through the same deps — can
// show anything, and its failures are TERMINAL in `readChatTranscript`: never a fall-through to this
// machine's disk.
//
// One round trip, one generated `sh` line, built from the session id alone:
//
//   - The ROOT is decided BEFORE that line, in TypeScript: the factory asks the host
//     `REMOTE_GROK_HOME_PROBE` and resolves the answer with `resolveReportedGrokHome` — the very
//     function `RemoteHooks.installGrokRemote` uses before it writes the hook grok fires — falling
//     back to `$HOME/.grok`. One probe, one validator, so the hook and the reader cannot disagree
//     on where grok lives (a `$` in `$GROK_HOME`, say, sends BOTH to `~/.grok`). That costs a
//     second exec over the same ControlMaster.
//   - The FILE is found by the session id, which is the one key no other session shares:
//     `<root>/sessions/*/<id>/chat_history.jsonl`. No cwd is needed, which also covers grok's
//     slug+hash group for a cwd longer than 255 encoded bytes (`grokEncodedCwdDirName` cannot name
//     it). Two matches are REFUSED (exit 3), never resolved by picking one.
//   - The READ is the paged transcript command (`transcriptPageCommand`: size + a byte window, dd
//     status framed inside the base64): the newest `maxBytes` of the file — the caller's page size
//     when it is smaller (the ⌘M panel asks for a small tail, the phone for 256 KB), never more than
//     `CHAT_PAGE_MAX_BYTES`, the cap the local leg's `readCappedTail` applies. grok does not page
//     (its file is rewritten in place, see `grok-chat.ts`), so this TAIL window is its whole read:
//     the newest messages show, the partial first line is dropped, and `olderCursor` stays null.
//
// The path the file is read from never crosses the machine boundary as an input: the glob and the
// read run in the same script, and the only interpolated values are app-built constants and the
// session id, validated by `isSafeGrokSessionId` (no `/`, `.`, quote or space can pass).
import { posixQuote } from '../shared/ssh'
import { CHAT_PAGE_MAX_BYTES } from '../shared/chat-page'
import {
  GROK_CHAT_HISTORY_FILE,
  REMOTE_GROK_HOME_PROBE,
  isSafeGrokSessionId,
  resolveReportedGrokHome
} from './agents/grok-paths'
import { parseTranscriptPage, transcriptPageCommand } from './remote-ssh/transcript-window'

/** What the host answered for a clean miss (status 0) — the same word the page commands use. */
const ABSENT = 'NODETERM_ABSENT'

/** Exit status for "the id names more than one session": a refusal to guess, its own answer
 *  (`ambiguous`) — neither a miss nor a failure a retry could heal. */
const AMBIGUOUS_EXIT = 3

/**
 * The host-side read for `sessionId` under `grokHome` (already resolved by
 * `resolveReportedGrokHome`; null = `$HOME/.grok`), or null when no transcript file can carry that
 * id. The script never reads `$GROK_HOME` itself — the root is the validated one or the fallback.
 *
 * Wrapped in `sh -c` because the ssh exec channel runs the USER's login shell: under zsh a glob
 * that matches nothing is an error ("no matches found") rather than a literal, which would turn
 * every clean miss into a failed read. The inner script is POSIX sh either way.
 */
export function remoteGrokChatCommand(
  sessionId: string,
  maxBytes: number = CHAT_PAGE_MAX_BYTES,
  grokHome: string | null = null
): string | null {
  if (!isSafeGrokSessionId(sessionId)) return null
  const id = posixQuote(sessionId)
  const file = posixQuote(GROK_CHAT_HISTORY_FILE)
  const script = [
    grokHome ? `r=${posixQuote(grokHome.replace(/\/$/, ''))}` : 'r=$HOME/.grok',
    'n=0; d=',
    // `*` outside the quotes (it must glob); the root is quoted, so a `[` or `*` in it is a path.
    `for p in "$r"/sessions/*/${id}; do if [ -f "$p"/${file} ]; then n=$((n + 1)); d=$p; fi; done`,
    `if [ "$n" -eq 0 ]; then printf '%s\\n' ${ABSENT}; exit 0; fi`,
    `if [ "$n" -gt 1 ]; then exit ${AMBIGUOUS_EXIT}; fi`,
    'cd "$d" || exit 1',
    transcriptPageCommand(GROK_CHAT_HISTORY_FILE, null, maxBytes)
  ].join('\n')
  return `sh -c ${posixQuote(script)}`
}

/**
 * The reply of `remoteGrokChatCommand` (status 0): `{absent}` for a clean miss, else the text of
 * the tail window with its partial leading line dropped. STRICT: anything malformed throws, because
 * the caller must tell "the host could not be read" from "an empty conversation".
 */
export function parseRemoteGrokChat(
  stdout: string,
  maxBytes: number = CHAT_PAGE_MAX_BYTES
): { absent: true } | { text: string } {
  if (stdout === `${ABSENT}\n`) return { absent: true }
  const page = parseTranscriptPage(stdout, null, maxBytes)
  let data = page.data
  if (page.start > 0) {
    // The window opened mid-file: everything through the first newline is the partial line (the
    // lookbehind byte makes a line that begins exactly on the edge survive — its `\n` is byte 0).
    const nl = data.indexOf(0x0a)
    data = nl < 0 ? Buffer.alloc(0) : data.subarray(nl + 1)
  }
  return { text: data.toString('utf8') }
}

/** A remote grok read: the host's text, a clean miss (`absent`), an id naming two sessions
 *  (`ambiguous` — no retry fixes it), or could-not-read. */
export type RemoteGrokChat = { ok: true; text: string } | { ok: false; absent?: true; ambiguous?: true }

/**
 * The desktop's remote grok leg, injected into `readChatTranscript` as `readRemoteGrok`. `null` =
 * not a remote session (take the local path); everything else is final.
 *
 * Remoteness is the shell's own records OR a live master for the node — the same two sources the
 * claude leg uses (`locateRemoteTranscriptRef`) — and a remote node with no reachable master is
 * `{ok:false}` (could not ask), never `null`, which would send it to this machine's disk.
 */
export function createReadRemoteGrokChat<T>(deps: {
  isRemote(nodeId: string): boolean
  /** The master to ask over (live pty, else the node's SSH project), or undefined when none. */
  target(nodeId: string): T | undefined
  run(target: T, cmd: string): Promise<{ code: number; stdout: string }>
  /** The ceiling; defaults to the local leg's cap. A caller's smaller `maxBytes` narrows it. */
  maxBytes?: number
}): (
  q: { sessionId?: string; nodeId?: string },
  opts?: { maxBytes?: number }
) => Promise<RemoteGrokChat | null> {
  const cap = Math.min(deps.maxBytes ?? CHAT_PAGE_MAX_BYTES, CHAT_PAGE_MAX_BYTES)
  return async (q, opts) => {
    const asked = opts?.maxBytes
    const maxBytes =
      typeof asked === 'number' && Number.isFinite(asked) && asked > 0 ? Math.min(cap, Math.floor(asked)) : cap
    if (!q.nodeId) return null
    const t = deps.target(q.nodeId)
    if (!t && !deps.isRemote(q.nodeId)) return null
    // No id, or one no transcript file can carry: nothing to find — an answer, not a failure.
    if (!q.sessionId || !remoteGrokChatCommand(q.sessionId, maxBytes)) return { ok: false, absent: true }
    if (!t) return { ok: false }
    try {
      // The root first, by the installer's own probe + validator (see the header).
      const probe = await deps.run(t, REMOTE_GROK_HOME_PROBE)
      if (probe.code !== 0) return { ok: false }
      const cmd = remoteGrokChatCommand(q.sessionId, maxBytes, resolveReportedGrokHome(probe.stdout))
      if (!cmd) return { ok: false, absent: true }
      const r = await deps.run(t, cmd)
      if (r.code === AMBIGUOUS_EXIT) return { ok: false, ambiguous: true }
      if (r.code !== 0) return { ok: false }
      const got = parseRemoteGrokChat(r.stdout, maxBytes)
      return 'absent' in got ? { ok: false, absent: true } : { ok: true, text: got.text }
    } catch {
      return { ok: false }
    }
  }
}
