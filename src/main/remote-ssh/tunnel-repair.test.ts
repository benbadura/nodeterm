import { describe, expect, it } from 'vitest'
import {
  TUNNEL_REPAIR_DELAYS_MS,
  describeTunnelProbe,
  shouldReportTunnelLost,
  recordTunnelRepair,
  shouldAttemptTunnelRepair,
  tunnelRepairDelayMs
} from './tunnel-repair'

describe('tunnelRepairDelayMs', () => {
  it('owes nothing before the first failure', () => {
    expect(tunnelRepairDelayMs(0)).toBe(0)
    expect(tunnelRepairDelayMs(-1)).toBe(0)
  })

  it('grows with consecutive failures and then CLAMPS', () => {
    expect(tunnelRepairDelayMs(1)).toBe(TUNNEL_REPAIR_DELAYS_MS[0])
    expect(tunnelRepairDelayMs(2)).toBe(TUNNEL_REPAIR_DELAYS_MS[1])
    expect(tunnelRepairDelayMs(3)).toBe(TUNNEL_REPAIR_DELAYS_MS[2])
    // A host that will never forward settles at the last delay rather than growing without bound —
    // it must keep trying (sshd config changes, curl gets installed), just not every 45 s.
    expect(tunnelRepairDelayMs(99)).toBe(TUNNEL_REPAIR_DELAYS_MS[TUNNEL_REPAIR_DELAYS_MS.length - 1])
  })

  it('is monotonic — a later failure never waits LESS than an earlier one', () => {
    for (let n = 1; n < 10; n++) {
      expect(tunnelRepairDelayMs(n + 1)).toBeGreaterThanOrEqual(tunnelRepairDelayMs(n))
    }
  })
})

describe('shouldAttemptTunnelRepair', () => {
  it('the FIRST repair is free', () => {
    // The asymmetry is the point. A needless repair costs one idempotent re-install; NOT repairing
    // costs a project whose agents report nothing for as long as it stays connected — on the host
    // that prompted this, 107 of 128 live sessions.
    expect(shouldAttemptTunnelRepair(undefined, 1_000)).toBe(true)
    expect(shouldAttemptTunnelRepair({ failures: 0, lastAttemptAt: 1_000 }, 1_000)).toBe(true)
  })

  it('refuses inside the backoff window and allows once it has elapsed', () => {
    const state = { failures: 1, lastAttemptAt: 1_000 }
    expect(shouldAttemptTunnelRepair(state, 1_000)).toBe(false)
    expect(shouldAttemptTunnelRepair(state, 1_000 + TUNNEL_REPAIR_DELAYS_MS[0] - 1)).toBe(false)
    expect(shouldAttemptTunnelRepair(state, 1_000 + TUNNEL_REPAIR_DELAYS_MS[0])).toBe(true)
  })

  it('a longer streak waits longer', () => {
    const justPastFirst = 1_000 + TUNNEL_REPAIR_DELAYS_MS[0]
    expect(shouldAttemptTunnelRepair({ failures: 1, lastAttemptAt: 1_000 }, justPastFirst)).toBe(true)
    expect(shouldAttemptTunnelRepair({ failures: 2, lastAttemptAt: 1_000 }, justPastFirst)).toBe(false)
  })

  it('a clock that went BACKWARDS refuses rather than repairing in a loop', () => {
    // NTP steps and sleep/wake both do this. Refusing is the safe direction: the window simply
    // takes longer to expire, where the other direction is an unthrottled re-install.
    expect(shouldAttemptTunnelRepair({ failures: 1, lastAttemptAt: 10_000 }, 1_000)).toBe(false)
  })
})

describe('recordTunnelRepair', () => {
  it('counts consecutive failures', () => {
    let s = recordTunnelRepair(undefined, false, 100)
    expect(s).toEqual({ failures: 1, lastAttemptAt: 100 })
    s = recordTunnelRepair(s, false, 200)
    expect(s).toEqual({ failures: 2, lastAttemptAt: 200 })
  })

  it('a SUCCESS resets the streak, so the next outage repairs immediately', () => {
    const failed = recordTunnelRepair(recordTunnelRepair(undefined, false, 100), false, 200)
    const ok = recordTunnelRepair(failed, true, 300)
    expect(ok.failures).toBe(0)
    expect(shouldAttemptTunnelRepair(ok, 300)).toBe(true)
  })

  it('stamps the ATTEMPT time, not the outcome time — the window starts when we spent the work', () => {
    expect(recordTunnelRepair(undefined, false, 4_242).lastAttemptAt).toBe(4_242)
  })
})

describe('shouldReportTunnelLost', () => {
  it('waits for a SECOND consecutive failure — one slow probe is not a lost tunnel', () => {
    expect(shouldReportTunnelLost(0)).toBe(false)
    expect(shouldReportTunnelLost(1)).toBe(false)
    expect(shouldReportTunnelLost(2)).toBe(true)
    expect(shouldReportTunnelLost(5)).toBe(true)
  })
})

describe('describeTunnelProbe', () => {
  it('names the cause the exit code carries (ssh 255, curl 7 / 28) and keeps the raw values', () => {
    expect(describeTunnelProbe(255, '')).toBe('ssh failed (exit 255, http none)')
    expect(describeTunnelProbe(7, '000')).toBe('nothing listening on the socket (exit 7, http 000)')
    expect(describeTunnelProbe(28, '000\n')).toBe('curl timed out (exit 28, http 000)')
    expect(describeTunnelProbe(0, '421')).toBe('another hook server answered (bearer mismatch) (exit 0, http 421)')
    expect(describeTunnelProbe(0, '500')).toBe('unexpected HTTP answer (exit 0, http 500)')
    expect(describeTunnelProbe(1, '')).toBe('probe failed (exit 1, http none)')
  })
})
