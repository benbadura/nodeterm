// Wire shapes shared by the desktop's "Share with team" flow and the Server Edition's `team` admin
// verbs. Everything here crosses an ssh exec channel as JSON, so every reader is strict.
import { NODE_ID_MAX } from './safe-id'
import { SESSION_ID_MAX } from './session-id'
import { isAncestorPath } from './worktree'

/** `team bootstrap --json`'s answer: the team's address, the project it adopted and shared, the
 *  join code, and what this call changed (every `created` flag false on a re-run). */
export interface BootstrapResult {
  hostId: string
  projectId: string
  projectName: string
  joinCode: string
  /** `starting` is still a success: no relay verdict arrived within the wait, and a join retries. */
  hosting: 'up' | 'starting'
  created: { team: boolean; owner: boolean; project: boolean; share: boolean }
}

/** One agent session `team resume` restarts: the node it belongs to, the agent it runs, and the
 *  conversation to resume. `permissionMode` is a request only; the server re-validates it. */
export interface ResumeEntry {
  nodeId: string
  agentId: string
  sessionId: string
  permissionMode?: string
}
/** `already-running` is a success: the node's session exists, so nothing was started twice. */
export type ResumeStatus = 'resumed' | 'already-running' | 'refused'
export interface ResumeResultEntry {
  nodeId: string
  status: ResumeStatus
  reason?: string
}
/** `team resume --json`'s answer: one result per requested session, in request order. */
export interface ResumeResult {
  results: ResumeResultEntry[]
}
/** The most sessions one resume request takes (a share handles at most this many terminals). */
export const RESUME_MAX_SESSIONS = 200

const boundedString = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max

/** Shape check for a resume list arriving from the wire or stdin. Returns the list, or why not.
 *  Only the known fields survive; every value is checked again where it is used. */
export function parseResumeSessions(raw: unknown): ResumeEntry[] | string {
  if (!Array.isArray(raw)) return 'The resume input must be a JSON list of sessions.'
  if (raw.length > RESUME_MAX_SESSIONS) return `A resume request takes at most ${RESUME_MAX_SESSIONS} sessions.`
  const out: ResumeEntry[] = []
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i] as Record<string, unknown> | null
    if (
      !e ||
      typeof e !== 'object' ||
      !boundedString(e.nodeId, NODE_ID_MAX) ||
      !boundedString(e.agentId, 64) ||
      !boundedString(e.sessionId, SESSION_ID_MAX)
    ) {
      return `Resume entry ${i} needs nodeId, agentId and sessionId strings.`
    }
    if (e.permissionMode !== undefined && !boundedString(e.permissionMode, 32)) {
      return `Resume entry ${i} has a bad permissionMode.`
    }
    out.push({
      nodeId: e.nodeId,
      agentId: e.agentId,
      sessionId: e.sessionId,
      ...(typeof e.permissionMode === 'string' ? { permissionMode: e.permissionMode } : {})
    })
  }
  return out
}

/** What the desktop learns about the SSH host before it shares a project there, read by one
 *  generated probe script (`core/remote-ssh/share-team-remote.ts`). */
export interface ShareProbe {
  os: string
  uid: number | null
  user: string
  home: string
  have: { git: boolean; curl: boolean }
  /** Which systemd unit runs nodeterm-server: the user's own, a root system service, or none. */
  unit: 'user' | 'system' | 'none'
  /** The node binary and `main.cjs` the user unit runs ('' when there is no user unit). */
  node: string
  main: string
  dataDir: string
  meta: { version: string; commit: string } | null
  /** The installed server knows `team bootstrap` (an older one must be updated first). */
  hasBootstrap: boolean
  /** `team status --json` exit code; null = the CLI could not be run at all. */
  statusRc: number | null
  teamExists: boolean
  /** realpath of the SSH project's remoteCwd on the host; null = it does not exist. */
  adoptCwd: string | null
  /** realpath of the login's home directory; null = it could not be read. */
  homeReal: string | null
  /** Live panes on this desktop's own remote tmux socket (`nt-*` sessions only; a session with
   *  several panes appears once per pane). */
  panes: Array<{ session: string; command: string }>
}
export type SharePlan =
  | { kind: 'ready' }
  | { kind: 'install'; reason: 'missing' | 'outdated' | 'not-running' }
  | { kind: 'refuse'; reason: string }

/** The most terminal nodes one share hands over. */
export const SHARE_MAX_TERMINALS = 200

export const SHARE_REFUSAL = Object.freeze({
  root: 'This SSH login is root. Share with team runs nodeterm-server as your own user, so log in to the project as a regular user and try again.',
  system: 'This host runs nodeterm-server as a system service (root). Share with team needs a per-user install; see docs/hosted-team-relay.md.',
  nonLinux: 'Share with team needs a Linux host (nodeterm-server runs on Linux).',
  noFolder: 'The project folder does not exist on the host.',
  homeFolder:
    "This project's folder is your home directory. Everyone in the team, Viewers included, could read every file in it. Move the project into its own folder, then share it.",
  homeAncestor:
    "This project's folder contains your home directory. Everyone in the team, Viewers included, could read every file in it. Move the project into its own folder, then share it.",
  homeUnknown:
    "Could not read your home directory on the host, so Share with team cannot check that this project's folder is safe to share. Try again."
})

/** Decide from a probe whether the host can take the share now, needs the installer first, or
 *  cannot take it at all. Refusals come first: installing on a host we would refuse anyway is
 *  wasted minutes. git and curl matter only when the installer has to run.
 *
 *  The folder must not be the home directory, the root, or anything above the home: every
 *  teammate, Viewers included, may read any file under a shared folder, and a home holds the ssh
 *  keys, the agents' credentials and nodeterm's own hook tokens. Both paths are the host's real
 *  paths, compared segment by segment. A home the probe could not read refuses rather than guess. */
export function sharePlan(p: ShareProbe): SharePlan {
  if (p.os !== 'Linux') return { kind: 'refuse', reason: SHARE_REFUSAL.nonLinux }
  if (p.uid === 0) return { kind: 'refuse', reason: SHARE_REFUSAL.root }
  if (p.unit === 'system') return { kind: 'refuse', reason: SHARE_REFUSAL.system }
  if (p.adoptCwd === null) return { kind: 'refuse', reason: SHARE_REFUSAL.noFolder }
  if (p.homeReal === null) return { kind: 'refuse', reason: SHARE_REFUSAL.homeUnknown }
  if (isAncestorPath(p.adoptCwd, p.homeReal)) {
    return { kind: 'refuse', reason: isAncestorPath(p.homeReal, p.adoptCwd) ? SHARE_REFUSAL.homeFolder : SHARE_REFUSAL.homeAncestor }
  }
  const reason: 'missing' | 'outdated' | 'not-running' | null =
    p.unit === 'none' || !p.node || !p.main
      ? 'missing'
      : !p.hasBootstrap
        ? 'outdated'
        : p.statusRc !== 0
          ? 'not-running'
          : null
  if (reason === null) return { kind: 'ready' }
  const missing = [...(p.have.git ? [] : ['git']), ...(p.have.curl ? [] : ['curl'])]
  if (missing.length) {
    return { kind: 'refuse', reason: `Installing nodeterm-server needs git and curl on the host (missing: ${missing.join(', ')}).` }
  }
  return { kind: 'install', reason }
}

/** Every `shareTeam` answer: never a rejection across IPC. `code` is an `E_*` code when the
 *  failure has one the renderer branches on (`E_NOT_CONNECTED`, `E_NOT_PROBED`, `E_CANCELLED` for
 *  an install the user stopped, a server refusal). */
export type ShareReply<T> = ({ ok: true } & T) | { ok: false; error: string; code?: string }

/** The probe, the plan it implies, and the command each requested node's pane is running on the
 *  host's remote tmux socket (a node with no live pane is absent). */
export interface ShareProbeReply {
  probe: ShareProbe
  plan: SharePlan
  paneCommands: Record<string, string>
}

/** The desktop's "Share with team" verbs for an SSH project (`window.nodeTerminal.shareTeam`).
 *  Desktop only: the Server Edition and relay tabs answer `E_UNSUPPORTED`. */
export interface ShareTeamApi {
  probe(projectId: string, nodeIds: string[]): Promise<ShareReply<ShareProbeReply>>
  install(projectId: string): Promise<ShareReply<{ exitCode: number }>>
  cancelInstall(projectId: string): Promise<void>
  onInstallOutput(projectId: string, listener: (text: string) => void): () => void
  flushMirror(projectId: string): Promise<ShareReply<{ nodeIds: string[] }>>
  /** Adopts the folder the last probe resolved; the caller names no path. */
  bootstrap(projectId: string): Promise<ShareReply<{ result: BootstrapResult }>>
  killSessions(
    projectId: string,
    nodeIds: string[]
  ): Promise<ShareReply<{ results: Array<{ nodeId: string; state: 'gone' | 'alive' | 'unknown' }> }>>
  resume(projectId: string, serverProjectId: string, sessions: ResumeEntry[]): Promise<ShareReply<ResumeResult>>
  seedBookmark(joinCode: string): Promise<ShareReply<{ hostId: string; label: string }>>
}
