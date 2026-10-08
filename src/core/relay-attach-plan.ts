import type { AgentId } from '../shared/agents/config'
import { buildSshArgs, sshConnectionIdForProject, sshHostKey, type SshConnection } from '../shared/ssh'
import type { PtyCreateOptions } from '../shared/types'

/**
 * WHERE a phone's relay `pty.attach` runs, and WITH WHAT, decided from this machine's own records.
 *
 * The phone sends a node id and nothing else we may trust. The relay host used to hand that id
 * straight to `attachDetached` → `tmux new-session -A` on the LOCAL socket, so a phone tapping a
 * node of an SSH project, before the desktop had mounted it, created a local `nt-<id>`: a shell in
 * this machine's `$HOME` wearing a remote node's identity. Work typed there ran on the wrong
 * machine; its hooks reported nothing the node could use (no context meter, ⌘M fell back to
 * Markdown); and the desktop's later mount ran `new-session -A` on the HOST, so one node id ended
 * up naming two different sessions on two machines. The invariant this restores is the one
 * `PtyCreateOptions.requireRemote` states for the desktop: a remote node is never spawned locally.
 *
 * Even for a LOCAL node the relay spawn was bare — no agent id, no canvas-control grant, no
 * permission wait, no account dir, no cwd — and tmux ignores the desktop's `-e` env on any later
 * attach, so a session the phone happened to create first stayed hookless for life. The profile
 * below is the one the desktop's own create passes (`TerminalNode.tsx`'s `transport.create`), read
 * off the PERSISTED node; the env itself is still built by the one builder (`spawnSession` →
 * `buildPtyEnv` / `remoteHookEnvArgs`), never a second copy here.
 *
 * Pure, so the routing matrix is provable without tmux, ssh or a workspace.
 */

/** One project that holds the node id, with the node as that project recorded it. */
export interface RelayNodePlacement {
  /** The machine-local project id (index entry id). */
  projectId: string
  /** The project's SSH server when the PROJECT is an SSH project; absent for local/inline. */
  projectServer?: SshConnection
  /** The persisted node. Local-ref cwds already resolved against the project root. */
  node: {
    kind?: string
    cwd?: string
    shell?: string
    agentId?: AgentId
    agentModel?: string
    accountId?: string
    ssh?: SshConnection
    sshRemoteTmux?: boolean
  }
}

/** A live ControlMaster plus the setup facts its connect produced (all read at CREATION only). */
export interface RelayRemoteRef {
  conn: SshConnection
  controlPath: string
  hookEndpointPath?: string
  tmuxConfPath?: string
  remoteHome?: string
  /** The connect's setup chain has finished (hook endpoint, tmux.conf, home are final). A session
   *  CREATED before that would carry none of them for life, so `prepareRelayAttach` only joins an
   *  existing session over a master that is not set up yet. Absent = set up (a live session's own
   *  handle). */
  setupDone?: boolean
}

/** Why a relay attach was refused. Never a local fallback — see the module comment. */
export type RelayAttachRefusal = 'not-connected' | 'no-ssh' | 'unregistered-remote' | 'still-connecting'

/** The create options a relay attach spawns with (size + persistKey are the caller's). */
export type RelayAttachOptions = Omit<PtyCreateOptions, 'persistKey' | 'cols' | 'rows'>

export type RelayAttachPlan =
  | { kind: 'local'; options: RelayAttachOptions; projectId?: string }
  | {
      kind: 'remote'
      options: RelayAttachOptions
      projectId: string
      hostKey: string
      /** The master's setup chain has finished — see `RelayRemoteRef.setupDone`. */
      setupDone: boolean
    }
  | { kind: 'refuse'; reason: RelayAttachRefusal; message: string; hostKey?: string }

/** Does this placement put the node's session on a REMOTE host? */
export function placementIsRemote(p: RelayNodePlacement): boolean {
  // A plain `ssh` terminal (createSshTerminalNode) runs `ssh` as a LOCAL pty program — exactly the
  // renderer's `localSsh` rule — wherever it sits.
  if (p.node.ssh && p.node.sshRemoteTmux !== true) return false
  if (p.node.sshRemoteTmux === true && p.node.ssh?.host) return true
  // A node of an SSH project with no flags (hand-edited, or older than the flag) still belongs to
  // that host. Routing it remote can only refuse; routing it local is the bug.
  return !!p.projectServer
}

/** The connection scope (ControlMaster key) a remote placement runs over — the same choice the
 *  renderer's `sshConnectionScope` makes: the project's own master for its own host, the
 *  project×host attachment for a node bound to another endpoint. */
export function placementScope(p: RelayNodePlacement): string {
  return p.node.ssh ? sshConnectionIdForProject(p.projectId, p.node.ssh, p.projectServer) : p.projectId
}

function placementHostKey(p: RelayNodePlacement): string {
  const conn = p.node.ssh ?? p.projectServer
  return conn ? sshHostKey(conn) : ''
}

/** Only terminal nodes carry a spawn profile; anything else is treated as not recorded here. */
function isTerminal(p: RelayNodePlacement): boolean {
  return p.node.kind === undefined || p.node.kind === 'terminal'
}

/** Optional fields are only set when present, so a bare node yields the bare (pre-fix) options. */
function profile(p: RelayNodePlacement): RelayAttachOptions {
  const n = p.node
  const out: RelayAttachOptions = {}
  if (n.cwd) out.cwd = n.cwd
  if (n.shell) out.shell = n.shell
  if (n.agentId) out.agentId = n.agentId
  if (n.agentModel) out.agentModel = n.agentModel
  if (n.accountId) out.accountId = n.accountId
  return out
}

export function planRelayAttach(args: {
  /** Every project holding this node id, in index order. Empty = this machine has no record. */
  placements: readonly RelayNodePlacement[]
  /** The project the phone says it is looking at. Used ONLY to choose among `placements` — it can
   *  never add a placement, so it cannot route a node anywhere this machine would not. */
  projectHint?: string
  /** The live master (+ setup facts) for a connection scope, or undefined when not connected. */
  refFor: (scopeId: string) => RelayRemoteRef | undefined
  /** This process already holds the node's session over a master: the exact handle it runs on. */
  liveRemote?: RelayRemoteRef
  /** Is there an `ssh` executable? Without it the remote branch cannot run, and the spawn would
   *  fall through to the local one. */
  sshAvailable: boolean
  /** Is the hinted project an SSH project (per this machine's index)? Only consulted when this
   *  machine has no record of the node, and only ever to REFUSE. */
  hintIsRemoteProject?: boolean
  /** Only consulted when the placements disagree (one id in a local AND an SSH project — the same
   *  committed canvas opened in two folders): does a LOCAL session for the id exist right now? */
  localSessionExists?: boolean
}): RelayAttachPlan {
  const terminals = args.placements.filter(isTerminal)
  // The hint picks among real placements; one it does not name is ignored, not trusted.
  const hinted = args.projectHint ? terminals.filter((p) => p.projectId === args.projectHint) : []
  const pool = hinted.length > 0 ? hinted : terminals
  // An SSH project the phone names, holding no record of this id (a session the phone is starting
  // there before registering it): we cannot know its profile, and a local spawn is the one wrong
  // answer. Refused rather than guessed.
  if (pool.length === 0) {
    // A node this machine records only as something other than a terminal still says where it
    // lives: a remote record refuses exactly like a hinted SSH project.
    if (args.hintIsRemoteProject || args.placements.some(placementIsRemote)) {
      return {
        kind: 'refuse',
        reason: 'unregistered-remote',
        message:
          'This session belongs to an SSH project, and this computer has no record of it yet, so it cannot be started from here. Nothing was started here.'
      }
    }
    // No record at all (a session the phone is starting in a local project before registering
    // it): the bare local spawn this path always made.
    return { kind: 'local', options: {} }
  }
  const remote = pool.filter(placementIsRemote)
  const local = pool.filter((p) => !placementIsRemote(p))
  // Disagreeing records: whichever session already exists. A live local session is a real local
  // node's (the same canvas checked out on this machine); otherwise the remote one.
  const chooseLocal = remote.length === 0 || (local.length > 0 && args.localSessionExists === true)
  if (chooseLocal) {
    const p = local[0]
    const options = profile(p)
    if (p.node.ssh && p.node.sshRemoteTmux !== true) {
      options.shell = 'ssh'
      options.shellArgs = buildSshArgs(p.node.ssh)
    }
    options.ownerProjectId = p.projectId
    return { kind: 'local', options, projectId: p.projectId }
  }
  const p = remote[0]
  const hostKey = placementHostKey(p)
  const scope = placementScope(p)
  const where = hostKey || 'its remote host'
  if (!args.sshAvailable) {
    return {
      kind: 'refuse',
      reason: 'no-ssh',
      hostKey,
      message: `This session lives on ${where}, and this computer has no ssh to reach it. Nothing was started here.`
    }
  }
  const ref = args.liveRemote ?? args.refFor(scope)
  if (!ref) {
    return {
      kind: 'refuse',
      reason: 'not-connected',
      hostKey,
      message: `This session lives on ${where}, which this computer is not connected to right now. Open the project on the desktop to reconnect. Nothing was started here.`
    }
  }
  const options = profile(p)
  options.ownerProjectId = scope
  options.sshRemote = {
    controlPath: ref.controlPath,
    conn: ref.conn,
    // The renderer's rule (`resolveSshRemote`): the node's own cwd, else the remote home.
    remoteCwd: p.node.cwd || '~',
    ...(ref.hookEndpointPath ? { hookEndpointPath: ref.hookEndpointPath } : {}),
    ...(ref.tmuxConfPath ? { tmuxConfPath: ref.tmuxConfPath } : {}),
    ...(ref.remoteHome ? { remoteHome: ref.remoteHome } : {})
  }
  options.requireRemote = true
  return { kind: 'remote', options, projectId: p.projectId, hostKey, setupDone: ref.setupDone !== false }
}
