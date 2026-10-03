// `team bootstrap`: everything a desktop's "Share with team" needs from this server, in one
// idempotent admin verb. The order is the safety property: hosting must be proven to start BEFORE a
// project is adopted or shared (or an owner written), so a host that cannot host changes nothing but
// its (harmless) team file. A re-run on a set-up host changes nothing and reports every `created`
// flag false.
//
// `codedError` comes from the admin-error leaf, never from team-admin.ts: team-admin.ts imports this
// module, and the leaf keeps that a one-way edge.
import type { HostedService } from './hosted-service'
import type { AdoptFolderResult } from '../workspace-store'
import type { BootstrapResult } from '../../shared/share-team'
import { codedError } from './admin-error'

/** How long bootstrap waits for the relay's first verdict before answering 'starting'. */
export const BOOTSTRAP_HOSTING_WAIT_MS = 15_000

export interface BootstrapDeps {
  svc: HostedService
  adoptFolder(cwd: string): Promise<AdoptFolderResult>
  /** The admin channel is closing: the server is going away, so hosting must not be started. */
  closing(): boolean
  hostingWaitMs?: number
}

export async function runBootstrap(
  deps: BootstrapDeps,
  req: { ownerKey: string; ownerLabel: string; adoptCwd: string }
): Promise<BootstrapResult> {
  const { svc } = deps
  const { created: team } = await svc.init()
  // The admin closes BEFORE the server stops hosting: a `start()` issued after that stop would bring
  // a scheduler up on a server that is going away (the same rule `team init` follows).
  if (deps.closing()) throw codedError('E_HOSTING_OFF', 'The nodeterm server is shutting down. Hosting was not started.')
  const start = await svc.start()
  if (start !== 'started') throw codedError('E_HOSTING_OFF', `Hosting did not start (${start}). See \`team status\`.`)
  const wait = await svc.waitForHosting(deps.hostingWaitMs ?? BOOTSTRAP_HOSTING_WAIT_MS)
  if (typeof wait === 'object') throw codedError('E_HOSTING_OFF', `Hosting could not start: ${wait.refused}`)
  // An editor (or a stranger) is promoted; an existing owner is left exactly as it is.
  const owner = svc.roleOf(req.ownerKey) !== 'owner'
  if (owner) await svc.addOwner(req.ownerKey, req.ownerLabel)
  const adopted = await deps.adoptFolder(req.adoptCwd)
  const share = !svc.sharedProjectIds().has(adopted.projectId)
  if (share) await svc.share(adopted.projectId, true)
  const info = svc.info()
  const joinCode = svc.joinCode()
  if (!info || !joinCode) throw codedError('E_HOSTING_OFF', 'Hosting stopped before a join code could be issued.')
  return {
    hostId: info.hostId,
    projectId: adopted.projectId,
    projectName: adopted.projectName,
    joinCode,
    hosting: wait,
    created: { team, owner, project: adopted.created, share }
  }
}
