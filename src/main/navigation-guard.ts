// Main-window navigation policy (pure, unit-tested in navigation-guard.test.ts).
//
// The main window hosts the whole canvas as ONE document. Any top-level navigation away from it
// wipes the canvas until a reload — every terminal, every node, all live renderer state. The old
// `will-navigate` guard allowed every `file://` URL and every URL under the dev server, on the
// theory that "same origin" meant "our app". It does not: a relative link in rendered markdown —
// Claude's habitual `[pty-manager.ts](src/core/pty-manager.ts:4100)` survives DOMPurify with its
// relative href — resolves against the packaged `…/out/renderer/index.html` to another `file://`
// path, the guard let it through, and the window navigated to a file that does not exist.
//
// So the rule is the narrowest one that keeps the app working: the ONLY allowed main-frame
// navigation is to the entry document itself (the exact URL the window loaded, compared on
// scheme + host + decoded pathname; hash and query are ignored so a reload and dev HMR still
// work). Safe external schemes go to the OS. Everything else — any other file:// path, any other
// path on the dev server, any other scheme — is blocked. The renderer's delegated markdown link
// handler (renderer/lib/markdownLinks.ts) is the first line; this is the backstop.

import { pathToFileURL } from 'url'

// Only hand the OS a URL with a vetted scheme. Blocks file://, smb://, and custom
// protocol-handler schemes that could be smuggled in via remote announcement feeds or
// rendered markdown links. Used by the window-open handler, `will-navigate`, and the
// shellOpenExternal IPC handler.
export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

/** The URL the main window loads: the electron-vite dev server when present, else the packaged
 *  `index.html` as a file URL (the same file `win.loadFile` is handed). */
export function appEntryUrlFor(devServerUrl: string | undefined, packagedIndexPath: string): string {
  return devServerUrl || pathToFileURL(packagedIndexPath).href
}

function decodedPath(u: URL): string {
  try {
    return decodeURI(u.pathname)
  } catch {
    return u.pathname
  }
}

export type MainFrameNavigation = 'allow' | 'external' | 'block'

export function decideMainFrameNavigation(url: string, appEntryUrl: string): MainFrameNavigation {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return 'block'
  }
  let entry: URL | null = null
  try {
    entry = new URL(appEntryUrl)
  } catch {
    entry = null
  }
  if (entry && target.protocol === entry.protocol && target.host === entry.host) {
    // `file:` paths compare case-insensitively: loadFile and Chromium may spell a drive letter or
    // a case-insensitive volume differently, and a false "block" here would break reload.
    // The trade on a case-sensitive Linux fs: a link to the entry path in different case is let
    // through and 404s the window — only reachable by a deliberately mis-cased link to index.html.
    const a = decodedPath(target)
    const b = decodedPath(entry)
    const same = target.protocol === 'file:' ? a.toLowerCase() === b.toLowerCase() : a === b
    // Same origin, different document: that is the relative-link canvas wipe. Never open it
    // externally either — on the dev server it would hand a garbage localhost URL to the browser.
    return same ? 'allow' : 'block'
  }
  if (isSafeExternalUrl(url)) return 'external'
  return 'block'
}
