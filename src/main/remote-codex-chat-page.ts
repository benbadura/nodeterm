// The desktop's remote leg of a CODEX ⌘M page (`TranscriptIpcDeps.readRemoteCodexPage`), pulled out
// of `src/main/index.ts` so its rules are testable without booting the shell.
//
// It is claude's remote leg (`createReadRemotePage`) with codex's locator in place of claude's: the
// rollout is found ON the host by `remoteCodexTranscriptCommand` — the account-scoped, symlink-
// refusing locate the context meter already runs (`core/remote-ssh/codex-context.ts`) — and read
// with the same ranged page read. Its answers follow `RemoteTranscriptPage`:
//   null                    → not a remote node (take the local path)
//   {ok:false}              → remote, and we could not ask — TERMINAL, never this machine's disk
//   {ok:false, absent:true} → the host looked and has no such rollout (or no id to look for)
import type { RemoteTranscriptPage, TranscriptQuery } from '../core/transcript-ipc'
import type { ChatTranscriptPage } from '../shared/chat-page'
import type { TranscriptPage } from '../core/remote-ssh/transcript-window'
import type { RemoteFileRef } from './remote-ssh/remote-file'
import {
  parseRemoteCodexTranscript,
  remoteCodexTranscriptCommand,
  type RemoteCodexContextTarget
} from '../core/remote-ssh/codex-context'
import { CODEX_THREAD_ID_RE } from '../core/codex-chat'

/** Located paths kept at most (per node × host × account × thread); oldest dropped first. */
const LOCATED_MAX = 500

export interface RemoteCodexChatPageDeps {
  /** `undefined` = a local node; `null` = an SSH node whose master / record is unavailable. The same
   *  resolver the remote codex context meter uses, so the two can never disagree on where a node is. */
  targetFor(nodeId: string): RemoteCodexContextTarget | null | undefined
  /** A managed account is read only when it is a saved, non-pending account for this host. */
  knownAccount(accountId: string, target: RemoteCodexContextTarget): boolean
  run(target: RemoteCodexContextTarget, command: string): Promise<{ code: number; stdout: string }>
  /** Strict ranged read (`RemoteFile.readTranscriptPage`): throws on any failure. */
  readPage(ref: RemoteFileRef, before: number | null, maxBytes: number): Promise<TranscriptPage>
}

export function createReadRemoteCodexPage(
  deps: RemoteCodexChatPageDeps
): (q: TranscriptQuery, page: ChatTranscriptPage) => Promise<RemoteTranscriptPage | null> {
  // A LOCATED path, keyed by everything that could make it wrong: another node, another host or
  // master, another home, another account, another thread. Forgotten on a failed read, so a Retry
  // locates afresh instead of replaying a dead path.
  const located = new Map<string, string>()
  return async (q, page) => {
    if (!q.nodeId) return null
    const target = deps.targetFor(q.nodeId)
    if (target === undefined) return null
    if (target === null) return { ok: false }
    // The locate command already refuses an id outside claude's looser alphabet; the WHOLE-uuid
    // check is codex's own (a uuid's last group would otherwise match another thread's file name).
    if (!q.sessionId || !CODEX_THREAD_ID_RE.test(q.sessionId)) return { ok: false, absent: true }
    if (target.accountId && !deps.knownAccount(target.accountId, target)) return { ok: false }
    const key = JSON.stringify([q.nodeId, target.controlPath, target.remoteHome ?? null, target.accountId ?? null, q.sessionId])
    let file = located.get(key)
    if (!file) {
      let command: string | undefined
      try {
        command = remoteCodexTranscriptCommand(target, q.sessionId)
      } catch {
        // A managed account's home needs the host's resolved $HOME; without a safe one there is
        // nothing we may ask for.
        return { ok: false }
      }
      if (!command) return { ok: false, absent: true }
      let stdout: string
      try {
        const r = await deps.run(target, command)
        if (r.code !== 0) return { ok: false }
        stdout = r.stdout
      } catch {
        return { ok: false }
      }
      // The locate exits 0 with NO output on a clean miss — an answer, not a failed ssh.
      if (!stdout.trim()) return { ok: false, absent: true }
      // Anything else must be the two jailed lines; a malformed or escaping answer is a failure.
      file = parseRemoteCodexTranscript(stdout, q.sessionId)
      if (!file) return { ok: false }
      located.set(key, file)
      if (located.size > LOCATED_MAX) located.delete(located.keys().next().value!)
    }
    try {
      const w = await deps.readPage({ conn: target.conn, controlPath: target.controlPath, path: file }, page.before, page.maxBytes)
      return { ok: true, data: w.data, start: w.start }
    } catch {
      located.delete(key)
      return { ok: false }
    }
  }
}
