/**
 * When may the connect() reuse branch spend a full `RemoteHooks.setup()` on repairing a reverse
 * hook tunnel that stopped answering? (issue #735)
 *
 * Pure, because the decision is the whole risk. A dead tunnel is silent — the project reports
 * `connected`, terminals work, the mirror pushes — so the repair has to be automatic; but
 * `setup()` re-installs the managed hook into every agent's config on the host, and the watchdog
 * calls connect() every 45 s per project. On a host that can never bind one (sshd with
 * `AllowStreamLocalForwarding no`, no `curl`, a `$HOME` the validator refuses) an unthrottled
 * retry would rewrite those config files forever, for a tunnel that is never coming.
 *
 * So: the FIRST failure repairs immediately — that is the case this exists for, and it is the
 * common one (a master died, a child rebuilt it, and the rebuilt one carries no `-R`) — and each
 * consecutive failure backs off, capped. Success resets. Nothing here decides whether the tunnel
 * is dead; it only decides whether we are allowed to try again yet.
 */

/** Backoff after consecutive FAILED repairs. The first entry is the delay after failure #1. */
export const TUNNEL_REPAIR_DELAYS_MS = [60_000, 300_000, 900_000] as const

export interface TunnelRepairState {
  /** Consecutive failed repairs. Reset to 0 by a success. */
  failures: number
  /** When the last repair was ATTEMPTED (not when it finished). */
  lastAttemptAt: number
}

/**
 * The delay owed after `failures` consecutive failures. Clamped to the last entry, so a host that
 * will never forward settles at one attempt per 15 minutes rather than one per watchdog tick.
 */
export function tunnelRepairDelayMs(failures: number): number {
  if (failures <= 0) return 0
  const i = Math.min(failures, TUNNEL_REPAIR_DELAYS_MS.length) - 1
  return TUNNEL_REPAIR_DELAYS_MS[i]
}

/**
 * May we attempt a repair now?
 *
 * `undefined` state = nothing has failed yet for this project ⇒ yes, immediately. That is the
 * deliberate asymmetry: the cost of a needless repair is one idempotent re-install, while the cost
 * of NOT repairing is a project whose agents report nothing at all for as long as it stays
 * connected — which on the host that prompted this was 107 of 128 live sessions.
 */
export function shouldAttemptTunnelRepair(
  state: TunnelRepairState | undefined,
  now: number
): boolean {
  if (!state || state.failures <= 0) return true
  return now - state.lastAttemptAt >= tunnelRepairDelayMs(state.failures)
}

/** Fold an attempt's outcome into the state a later `shouldAttemptTunnelRepair` will read. */
export function recordTunnelRepair(
  state: TunnelRepairState | undefined,
  ok: boolean,
  now: number
): TunnelRepairState {
  return { failures: ok ? 0 : (state?.failures ?? 0) + 1, lastAttemptAt: now }
}

/**
 * How many CONSECUTIVE failed liveness probes it takes before the user is told the tunnel is lost.
 *
 * One was the old rule, and it made the banner a flapping alarm: the probe is a single `curl -m 5`
 * over the shared master, so one slow round trip (a busy mux, a queued child gate, a curl timeout)
 * put "lost their verified connection" on screen for a tunnel that was fine — field report from a
 * Linux desktop driving a Mac on the same desk, no sleep involved. The REPAIR still runs on the
 * first failure (see `shouldAttemptTunnelRepair`); only the warning waits for a second opinion,
 * one watchdog tick later. A repair that succeeds resets the streak, so a real-but-healed loss
 * never shows a banner at all.
 */
export const TUNNEL_LOST_STRIKES = 2

export function shouldReportTunnelLost(consecutiveFailures: number): boolean {
  return consecutiveFailures >= TUNNEL_LOST_STRIKES
}

/**
 * One line naming WHY a tunnel probe failed, for the log. The probe used to fold every failure into
 * `false`, so a field report could not tell a dead listener from a slow master from a refused ssh.
 * `code` is the ssh child's exit status: ssh's own failures are 255, otherwise it is the remote
 * `curl`'s (7 = connection refused → nobody listening on the socket, 28 = the 5 s timeout).
 * `stdout` is the `%{http_code}` curl printed (`000` = no HTTP answer; 421 = a different owner).
 */
export function describeTunnelProbe(code: number, stdout: string): string {
  const http = stdout.trim() || 'none'
  const hint =
    code === 255
      ? 'ssh failed'
      : code === 7
        ? 'nothing listening on the socket'
        : code === 28
          ? 'curl timed out'
          : code === 0 && http === '421'
            ? 'another hook server answered (bearer mismatch)'
            : code === 0
              ? 'unexpected HTTP answer'
              : 'probe failed'
  return `${hint} (exit ${code}, http ${http})`
}
