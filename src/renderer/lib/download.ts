// Which download route (if any) the Explorer offers for the tree it is currently showing.
//
// "Download" only means something when the file is NOT already on the user's machine, and the two
// cases where it isn't are reached by completely different transports:
//
//  - **Desktop + SSH project** — the tree is another host's filesystem, so the file comes down over
//    the project's ControlMaster with `scp` and lands in the OS Downloads folder. This is the only
//    route that streams straight to disk, which is why big files must take it.
//  - **Browser (Server Edition)** — every file in the tree is on the server, including a "local"
//    project's. The transfer is a plain HTTP GET against a one-shot ticket, and the browser saves
//    it. NOT `fs.readBinary`: that base64s the whole file into one RPC message and is capped.
//
// Everything else answers `none`, and the affordance is hidden rather than shown-and-broken:
//  - **Desktop + local project** — the file is already on this machine; Reveal in Finder is the
//    honest action, and it is right there in the same menu.
//  - **Relay tab** — the files are on the peer's machine and the only path to them is the bridged
//    `fs.readBinary`, i.e. the capped base64 one. Offering a Download that silently truncates a
//    25 MB file would be worse than not offering it; a real relay transport is follow-up work.
import type { DownloadResult, DownloadTicket } from '@shared/types'
import type { SessionSource } from '../session/session'

export type DownloadRoute = 'scp' | 'http' | 'none'

export interface DownloadContext {
  /** Renderer shell: a browser tab (Server Edition) vs Electron. */
  browser: boolean
  /** The Explorer's project is an SSH project (its tree is the remote host's fs). */
  ssh: boolean
  /** Which session the active project's tab belongs to. */
  source: SessionSource
}

export function downloadRoute({ browser, ssh, source }: DownloadContext): DownloadRoute {
  if (source === 'relay') return 'none'
  if (ssh) {
    // An SSH project's tree is served by the desktop's ControlMaster; the Server Edition has no
    // SSH projects at all (its sshFs members are unsupported stubs), so a browser + ssh pairing
    // is not a thing we can serve — say so rather than minting a ticket for a path that is not on
    // the server's own disk.
    return browser ? 'none' : 'scp'
  }
  return browser ? 'http' : 'none'
}

/**
 * True when `path` can name a download at all. The same refusal set as core's
 * `safeDownloadBasename` (the scp leg), applied BEFORE the affordance is shown: a path whose
 * basename is empty, `.`, `..` or `~` has nothing to call the result. The one that matters is
 * `/` — a file manager node can stand on the filesystem root, and the HTTP route has no such
 * guard, so it would stream the whole server filesystem as one `.tar.gz`.
 */
export function isDownloadablePath(path: string): boolean {
  const base = path.replace(/\/+$/, '').split('/').pop() ?? ''
  return !!base && base !== '.' && base !== '..' && base !== '~'
}

/** What one download attempt came to. `localPath` is set only when the file landed on THIS
 *  machine (the scp route) — that is what makes it revealable; an HTTP download belongs to the
 *  browser from its first byte. */
export type DownloadOutcome = { ok: true; localPath?: string } | { ok: false; error: string }

/** The two transports, injected so the decision below is testable without a preload. */
export interface DownloadTransport {
  /** Desktop + SSH: `sshProject.downloadFile` — scp over the project's ControlMaster. */
  scp: (projectId: string, path: string, destDir?: string) => Promise<DownloadResult>
  /** Browser: `files.downloadTicket` — a one-shot ticket for `GET /download`. */
  ticket: (path: string) => Promise<DownloadTicket | null>
  /** Hand a ticket URL to the browser's own downloader (`triggerBrowserDownload`). */
  hand: (url: string, name: string) => void
}

const NOT_AVAILABLE = 'Downloading is not available here.'

/**
 * Run one download over `route`. ONE implementation for every surface that offers Download (the
 * Explorer drawer and the file-manager node), so the transport rules — which API, what a null
 * ticket means, how a rejected IPC reads — cannot drift between them. Never throws.
 */
export async function performDownload(
  route: DownloadRoute,
  req: { path: string; projectId?: string; destDir?: string },
  t: DownloadTransport
): Promise<DownloadOutcome> {
  try {
    if (route === 'scp') {
      // Main resolves the ControlMaster from the project id; an undefined one is a renderer bug,
      // not something to hand across the IPC boundary.
      if (!req.projectId) return { ok: false, error: 'Not connected.' }
      const res = await t.scp(req.projectId, req.path, req.destDir)
      return res.ok ? { ok: true, localPath: res.localPath } : { ok: false, error: res.error }
    }
    if (route === 'http') {
      const ticket = await t.ticket(req.path)
      if (!ticket) return { ok: false, error: NOT_AVAILABLE }
      t.hand(ticket.url, ticket.name)
      return { ok: true }
    }
    return { ok: false, error: NOT_AVAILABLE }
  } catch {
    return { ok: false, error: 'The download could not be started.' }
  }
}

/**
 * True when this machine's Electron `shell.*` can actually act on a path the UI is showing:
 * an Electron shell (both members are `noop` stubs in a browser tab — see `bridge/stubs.ts`),
 * and a path that is on THIS machine (an SSH host's or a relay peer's is not).
 *
 * ONE predicate for every `shell.*` path action, because they share one precondition for one
 * reason. `reveal` was gated first; `openPath` was not, and a `.zip` in the Server Edition's file
 * manager was therefore a silent dead click. Writing that rule a second time beside this one is
 * how the two would drift apart again.
 */
export function canUseLocalShell({ browser, ssh, source }: DownloadContext): boolean {
  return !browser && !ssh && source !== 'relay'
}

/**
 * True when "Reveal in Finder" can actually do something. It was previously offered
 * unconditionally — on an SSH project it handed a remote path to the local file manager, and in a
 * browser tab it is an inert stub. Both were silent no-ops, which reads as a broken app rather
 * than as an unavailable feature.
 */
export const canRevealLocally = canUseLocalShell

/**
 * Start a browser download for `url` without navigating the page. An anchor with `download` is
 * used rather than `location.assign` so a response that (for any reason) lacks
 * `Content-Disposition` still saves instead of replacing the app. The `name` is a hint only — the
 * server's header wins, and must, because it knows a folder became `<name>.tar.gz`.
 */
export function triggerBrowserDownload(url: string, name: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
