import { sshConnectionIdForProject, type SshConnection } from '@shared/ssh'
import type { SessionSource } from '../session/session'

/** Where a card-modal terminal's file links resolve: the filesystem to existence-check against
 *  (`ssh` = the CARD's SSH project over its ControlMaster, else the local core's fs) plus the facts
 *  `fileLinkDialect` needs. */
export interface CardFileLinkRoute {
  ssh: boolean
  sshProject: boolean
  standaloneSsh: boolean
}

/**
 * Route the file links of the card modal's live viewer — or refuse to (`null` = no file links).
 *
 * The canvas node asks the ACTIVE project, because a node only ever lives in the active canvas.
 * A card does not: the Omni board opens cards from every project, so the modal must ask the CARD's
 * project (`projectId`), never the active one — or a click on an SSH card while a local project is
 * active would existence-check (and open) a same-looking path on THIS machine. Every doubt fails
 * closed, because an absent link is recoverable and the wrong machine's file is not:
 *  - the project is unknown;
 *  - its core is not this app's local one (`source` — a relay/server tab's files live on another
 *    core, which this modal's `api` does not reach);
 *  - the session runs on a host the project's fs API does not cover: a plain `ssh` node in a local
 *    project, or a host attachment (a node on a different host than its SSH project's).
 */
export function cardFileLinkRoute(facts: {
  project: { id: string; ssh?: { server?: SshConnection } } | undefined
  source: SessionSource | null
  spawn: { ssh?: SshConnection; sshRemoteTmux?: boolean }
}): CardFileLinkRoute | null {
  const { project, source, spawn } = facts
  if (!project || source !== 'local') return null
  const remoteSession = !!spawn.ssh || !!spawn.sshRemoteTmux
  if (!project.ssh) {
    // A local project: a remote session's output names paths on a host we have no fs API for.
    return remoteSession ? null : { ssh: false, sshProject: false, standaloneSsh: false }
  }
  // An SSH project: its fs API is the project's host. A session there is either on that host
  // (the project's own scope) or attached to another one, whose paths it cannot check.
  if (remoteSession) {
    if (!spawn.ssh) return null
    if (sshConnectionIdForProject(project.id, spawn.ssh, project.ssh.server) !== project.id) return null
  }
  return { ssh: true, sshProject: true, standaloneSsh: false }
}
