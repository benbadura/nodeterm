// Wire types of the headless launcher (#925): core/headless-launch.ts implements it, desktop main
// exposes it as `pty.launchHeadless`, the renderer's `--run-now` / `run` consume the result.
import type { PtyCreateOptions } from './types'

export type HeadlessLaunchFailure = 'not-persistent' | 'spawn-failed' | 'no-shell' | 'line-too-long' | 'cancelled'
export type HeadlessLaunchResult =
  | { outcome: 'delivered'; fresh: boolean }
  | { outcome: 'failed'; reason: HeadlessLaunchFailure; fresh?: boolean }
export interface HeadlessLaunchRequest {
  ptyOptions: PtyCreateOptions
  command: string
  /** Release the synthetic client afterwards (desktop: true; Server Edition: false). */
  release: boolean
  /** Refuse without a persistent backend (desktop: true — it releases; Server Edition: false). */
  requirePersistent: boolean
}
