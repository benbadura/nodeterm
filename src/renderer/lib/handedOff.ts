import type { Project } from '@shared/types'

/**
 * The question asked before this desktop opens an SSH project it handed to a hosted team.
 *
 * After "Share with team" the server's own core writes that project's canvas. Opening it here as
 * well makes this desktop a second writer of the same canvas, and the two overwrite each other —
 * so every path that would open it asks first, with this text. `null` = never handed off, nothing
 * to ask.
 *
 * A mark with no `hostId` is a handover that never finished: the server may or may not hold the
 * project, so the copy says exactly that rather than naming a team that may not exist. Both copies
 * say what opening it here would do to its agents: the server resumed their conversations, so
 * resuming them here too would put two processes on one transcript, and "Open here anyway" skips
 * that automatic resume once.
 *
 * `teamLabel` is the team's name from this device's bookmark of it, when one is known; anything
 * else (no bookmark, a blank label) reads as "the hosted team". A finished mark always carries the
 * server's project id in practice; a hand-edited one without it still names the command, with the
 * same `<projectId>` placeholder the server's own usage text prints.
 */
/** "Open here anyway" skips each agent's automatic resume once (terminal/handed-off-resume.ts). */
const AGENTS_NOT_RESUMED = 'Its agents are not resumed here automatically.'

export function handedOffWarning(
  p: Pick<Project, 'name' | 'handedOffTo' | 'ssh'>,
  teamLabel: string | null
): string | null {
  const to = p.handedOffTo
  if (!to) return null
  if (!to.hostId) {
    return (
      `Sharing ${p.name} with a team did not finish. If the server already took it over, opening it ` +
      'here gives one canvas two editors that can overwrite each other, and its agents would start ' +
      'the same conversations the server is running.\n\nOpen it here anyway? ' +
      AGENTS_NOT_RESUMED
    )
  }
  const team = teamLabel?.trim() || 'the hosted team'
  const host = p.ssh?.server.host || 'its host'
  const projectId = to.projectId ?? '<projectId>'
  return (
    `${p.name} is now managed by team ${team} on ${host}. Open it from the team tab, or run ` +
    `"team unshare ${projectId}" on the server first.\n\n` +
    'Open it here anyway? Two copies editing one canvas can overwrite each other, and its agents ' +
    'would start the same conversations the server is running. ' +
    AGENTS_NOT_RESUMED
  )
}
