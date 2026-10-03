/**
 * Cadence of the periodic cold-restore scrollback snapshot (pty-manager `snapshotTick`, 15 s).
 * `dirtyTicks` = consecutive ticks on which the session had output. A session that just produced
 * output is captured at once; one that has been continuously busy (an agent's spinner redraws
 * forever) is captured every BUSY_EVERY_TICKS-th tick instead. The snapshot only serves a restore
 * after a machine reboot, and detach/quit capture anyway, so a busy session loses at most ~60 s of
 * restore scrollback in exchange for a quarter of the capture spawns and 256 KB rewrites.
 */
export const BUSY_AFTER_TICKS = 4
export const BUSY_EVERY_TICKS = 4

export function snapshotDue(dirtyTicks: number): boolean {
  return dirtyTicks <= BUSY_AFTER_TICKS || dirtyTicks % BUSY_EVERY_TICKS === 0
}
