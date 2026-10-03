// Resolves the standalone session-host bundle and spawns it DETACHED so it outlives this app —
// the exact same "system-first, bundled-as-floor" resolution shape `tmux-hint.ts`'s
// `bundledTmuxPath` already uses, one level over: there is no "system session-host" to prefer, so
// this only has the dev/packaged split.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

/**
 * Where `out/session-host/host.cjs` lives, in dev vs a packaged build.
 *
 * - Packaged Windows: `<resourcesPath>/session-host/host.cjs` has a sibling
 *   `node_modules/node-pty` copied by `win.extraResources`. This is the first candidate.
 *   An asar copy exists too, but a directly executed script there cannot resolve its
 *   external `node-pty` import on Windows.
 * - Packaged macOS/Linux: `<appPath>/out/session-host/host.cjs` inside the asar.
 *
 * - Dev (`electron-vite dev`): `app.getAppPath()` IS the repo root, so the same candidate answers
 *   both. `repoRoot` (`process.cwd()`) stays as a fallback for shells that supply no app path.
 */
export function resolveSessionHostScript(opts: {
  resourcesPath?: string | null
  appPath?: string | null
  repoRoot?: string | null
  exists?: (p: string) => boolean
}): string | null {
  const exists = opts.exists ?? fs.existsSync
  const candidates: string[] = []
  if (opts.resourcesPath) candidates.push(path.join(opts.resourcesPath, 'session-host', 'host.cjs'))
  if (opts.appPath) candidates.push(path.join(opts.appPath, 'out', 'session-host', 'host.cjs'))
  if (opts.repoRoot) candidates.push(path.join(opts.repoRoot, 'out', 'session-host', 'host.cjs'))
  for (const c of candidates) {
    try {
      if (exists(c)) return c
    } catch {
      /* unreadable — keep looking */
    }
  }
  return null
}

/**
 * Spawn the session host, detached, unref'd, with no attached stdio — so it survives this
 * process exiting (`app.quit()` never touches it; `PtyManager.killAll()` explicitly does not
 * either, matching how it never kills tmux sessions).
 *
 * `ELECTRON_RUN_AS_NODE=1` is what makes this work when `process.execPath` is the Electron
 * binary itself (a packaged app has no separate `node` executable to shell out to) — Electron
 * treats that env var as "run this as a plain Node process, skip the Chromium/BrowserWindow
 * machinery entirely". It is harmless to set when `process.execPath` already IS a real Node
 * binary (dev, or a CI box running the bundle directly): unrecognized by real Node, ignored.
 *
 * Never throws — a spawn failure here is reported by the CALLER failing to connect afterward,
 * exactly like `pty.spawn` failures elsewhere in this codebase degrade to an error the renderer
 * can show rather than crashing the main process.
 */
/** The name the host runs under on Windows. See `hostLauncherPath`. */
export const WINDOWS_HOST_EXE = 'nodeterm-session-host.exe'

/** The filesystem surface `hostLauncherPath` needs, injected so its fallbacks are testable without
 *  a 224 MB Electron binary and a writable install directory. */
export interface HostLinkFs {
  statSync(p: string, opts: { bigint: true }): { ino: bigint; dev: bigint }
  unlinkSync(p: string): void
  linkSync(existing: string, link: string): void
}

/**
 * The binary to spawn the host with — `execPath` everywhere, except on Windows, where it is a hard
 * link beside it named `nodeterm-session-host.exe`.
 *
 * Since issue #829 step 3 this is the FALLBACK: a packaged Windows build launches the host from a
 * staged copy outside the install directory (`session-host-runtime.ts`), and only lands here when
 * staging failed or the staged copy could not start.
 *
 * The separate image name makes the background host identifiable, but does NOT isolate it from
 * updates: it still maps the installed Electron image and DLLs. NSIS can find processes by path
 * as well as name. The installer preflight must refuse while this host (or the app) is running;
 * it must never kill the host implicitly, because doing so ends every preserved session (#829).
 * The link must sit beside Electron's sibling DLLs, locales/ and resources/ to run.
 *
 * Identity is compared with BIGINT stats. An NTFS file id is 64-bit and routinely exceeds
 * `Number.MAX_SAFE_INTEGER`, so the default numeric `ino` can report two different files as the
 * same one — which here would mean happily launching a stale or unrelated binary. A zero id is
 * treated as "cannot prove identity" and re-links rather than trusting it.
 *
 * Every failure — a read-only install dir, a filesystem without hard links, a directory squatting
 * the name, a link that cannot be removed — returns `execPath`, which is exactly today's behaviour.
 * The installer preflight checks both names, including this fallback.
 */
export function hostLauncherPath(
  execPath: string,
  platform: NodeJS.Platform | string,
  fsLike: HostLinkFs = fs as unknown as HostLinkFs
): string {
  if (platform !== 'win32') return execPath
  // `path.win32`, not `path`: the platform is a parameter, so the separator rules must follow it
  // rather than the OS this runs on. With the running OS's `path`, a Linux runner sees no separator
  // in `C:\Program Files\…\nodeterm.exe` and returns a bare, cwd-relative link name.
  const link = path.win32.join(path.win32.dirname(execPath), WINDOWS_HOST_EXE)
  try {
    const target = fsLike.statSync(execPath, { bigint: true })
    try {
      const existing = fsLike.statSync(link, { bigint: true })
      const known = target.ino !== 0n && existing.ino !== 0n
      if (known && existing.ino === target.ino && existing.dev === target.dev) return link
      fsLike.unlinkSync(link)
    } catch {
      // absent, unreadable, or not removable — fall through and let linkSync decide
    }
    fsLike.linkSync(execPath, link)
    return link
  } catch {
    return execPath
  }
}

/** A host's own controlled failures exit 0 (lost the startup race) or 1 (refused a state it could
 *  not judge). Any other code from a staged host — 0xC0000135 STATUS_DLL_NOT_FOUND, an access
 *  violation, a policy block — means the staged COPY could not run, and is worth one launch from the
 *  installed binary instead. Exported for tests. */
export function stagedExitWantsFallback(code: number | null, signal: NodeJS.Signals | null): boolean {
  if (signal) return true
  return code !== null && code !== 0 && code !== 1
}

/** How long after spawn an exit still counts as "the staged copy could not start". */
export const STAGED_EARLY_EXIT_MS = 10_000

/** A launch target: the binary and the host script it runs. */
export interface HostLaunchTarget {
  bin: string
  script: string
  /** A staged runtime, which gets the early-exit fallback. */
  staged?: boolean
}

/**
 * The ordered launch attempts. A staged runtime (outside the install directory — see
 * `session-host-runtime.ts`) goes first; the legacy pair (`hostLauncherPath`, then the plain
 * `execPath`) is what every staged failure falls back to. Exported for tests.
 */
export function hostLaunchPlan(
  scriptPath: string,
  execPath: string,
  platformName: NodeJS.Platform | string,
  staged?: { exe: string; script: string } | null,
  fsLike?: HostLinkFs
): HostLaunchTarget[] {
  const plan: HostLaunchTarget[] = []
  if (staged && platformName === 'win32') plan.push({ bin: staged.exe, script: staged.script, staged: true })
  const legacy = hostLauncherPath(execPath, platformName, fsLike)
  plan.push({ bin: legacy, script: scriptPath })
  if (legacy !== execPath) plan.push({ bin: execPath, script: scriptPath })
  return plan
}

export function spawnSessionHost(
  scriptPath: string,
  userDataDir: string,
  staged?: { exe: string; script: string } | null,
  onStagedFailure?: () => void
): void {
  let plan: HostLaunchTarget[] | null = null
  const legacyPlan = (): HostLaunchTarget[] => {
    // The legacy alias is created lazily: a staged host that starts never needs the hard link in
    // the install directory at all.
    if (!plan) plan = hostLaunchPlan(scriptPath, process.execPath, os.platform(), null)
    return plan
  }
  const launch = (target: HostLaunchTarget, next: () => void): void => {
    let failedOver = false
    const failOver = (): void => {
      if (failedOver) return
      failedOver = true
      next()
    }
    try {
      const child = spawn(target.bin, [target.script, userDataDir], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      // A spawn failure arrives ASYNCHRONOUSLY on 'error', which the try/catch cannot see — and an
      // unhandled 'error' on a ChildProcess takes the main process with it. That is reachable here:
      // two app processes can race on the alias, and the loser can unlink the link between the
      // winner creating it and spawning through it (ENOENT). The listener is what makes the
      // fallback below real rather than theoretical.
      child.on('error', () => {
        if (target.staged) onStagedFailure?.()
        failOver()
      })
      if (target.staged) {
        const startedAt = Date.now()
        child.once('exit', (code, signal) => {
          if (Date.now() - startedAt > STAGED_EARLY_EXIT_MS) return
          if (!stagedExitWantsFallback(code, signal)) return
          onStagedFailure?.()
          failOver()
        })
      }
      child.unref()
    } catch {
      if (target.staged) onStagedFailure?.()
      failOver()
    }
  }
  const runLegacy = (index: number): void => {
    const targets = legacyPlan()
    if (index >= targets.length) return
    launch(targets[index], () => runLegacy(index + 1))
  }
  if (staged && os.platform() === 'win32') {
    launch({ bin: staged.exe, script: staged.script, staged: true }, () => runLegacy(0))
  } else {
    runLegacy(0)
  }
}
