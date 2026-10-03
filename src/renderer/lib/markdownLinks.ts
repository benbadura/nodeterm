// Clicks on links inside RENDERED MARKDOWN must never navigate the app's own window.
//
// `renderMarkdown` (marked + DOMPurify) keeps an anchor's href as written, and agents write
// relative links constantly — Claude's `[pty-manager.ts](src/core/pty-manager.ts:4100)`. A plain
// click on one resolves against the app document: on the desktop that is another `file://` path
// (the main window navigated to a file that does not exist and the whole canvas was gone until a
// reload); in the Server Edition ANY `<a href>` click — relative or http(s) — navigated the app's
// own browser tab away. The main process's `will-navigate` guard (src/main/navigation-guard.ts)
// is the desktop backstop; this handler is the first line on every surface, and the ONLY line in
// a browser, where nothing sits above the page.
//
// One delegated, document-level, bubble-phase listener installed once at boot (boot.tsx), scoped
// by a selector list of the containers markdown is rendered into. Delegation rather than a handler
// per component on purpose: the markdown surfaces are owned by different components (terminal ⌘M
// view, ChatPanel, sticky notes on the canvas and in the kanban card modal, the editor preview),
// and a per-component handler is one more thing every new surface has to remember.
//
// Local (non-web) links show a toast rather than opening a file: resolving a path the way the
// terminal's Cmd+click file links do needs the owning node's cwd AND its filesystem dialect
// (session source, core platform, SSH/relay — see TerminalNode's `pathConvention`), which is
// per-node state a document-level handler cannot see. A wrong guess would open the wrong file on
// the wrong machine, so this degrades to "say so" instead.

/**
 * CONTRACT: the container classes rendered markdown HTML is injected into. Every component that
 * pipes `renderMarkdown` output into `dangerouslySetInnerHTML` must render it inside one of these —
 * `markdownLinks.test.ts` fails when a listed class stops being rendered or when a new markdown
 * surface renders outside the list.
 *   - `.term-md__content` — terminal ⌘M markdown view (TerminalNode) and the editor's Preview
 *   - `.term-chat__text`  — ⌘M transcript bubbles (ChatPanel)
 *   - `.sticky-node__md`  — sticky notes, canvas node AND kanban card modal (NoteMarkdown)
 */
export const RENDERED_MARKDOWN_CONTAINERS: readonly string[] = [
  '.term-md__content',
  '.term-chat__text',
  '.sticky-node__md'
]

export type MarkdownLinkDecision =
  | { action: 'external'; url: string }
  | { action: 'ignore' }
  | { action: 'local' }

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** What to do with a click on an anchor whose RAW `href` attribute is `rawHref`. Decided on the
 *  raw attribute, never on the resolved `a.href`, because resolution against the app document is
 *  exactly what turns a harmless relative path into a navigation. */
export function decideMarkdownLinkClick(rawHref: string): MarkdownLinkDecision {
  const href = rawHref.trim()
  // `#x` is a same-document fragment; `""` resolves to the document itself (a reload). Neither
  // does anything useful here, and a hash change could trip hash-keyed dev routes.
  if (href === '' || href.startsWith('#')) return { action: 'ignore' }
  let parsed: URL
  try {
    // No base: only an ABSOLUTE URL parses. Relative and protocol-relative hrefs throw → local.
    parsed = new URL(href)
  } catch {
    return { action: 'local' }
  }
  if (EXTERNAL_PROTOCOLS.has(parsed.protocol)) return { action: 'external', url: parsed.href }
  return { action: 'local' }
}

export interface MarkdownLinkDeps {
  openExternal(url: string): void
  /** A link that cannot be opened from this view was clicked. */
  notifyLocal(): void
}

/** Install the delegated handler; returns its uninstaller. */
export function installMarkdownLinkGuard(doc: Document, deps: MarkdownLinkDeps): () => void {
  const scope = RENDERED_MARKDOWN_CONTAINERS.join(',')
  const handle = (e: MouseEvent): void => {
    const target = e.target
    if (!(target instanceof Element)) return
    const anchor = target.closest('a[href]')
    if (!anchor || !anchor.closest(scope)) return
    // Modifier clicks are handled the same way: nothing else in the app owns Cmd/Ctrl/Shift+click
    // on rendered markdown, and letting the default run would open a new window/tab on the same
    // unresolvable relative URL.
    e.preventDefault()
    const decision = decideMarkdownLinkClick(anchor.getAttribute('href') ?? '')
    if (decision.action === 'external') deps.openExternal(decision.url)
    else if (decision.action === 'local') deps.notifyLocal()
  }
  // Someone closer to the anchor already owned this click; and only the primary button here — a
  // secondary one is the context menu's.
  const onClick = (e: MouseEvent): void => {
    if (e.defaultPrevented || e.button !== 0) return
    handle(e)
  }
  // A middle click never fires `click`; it fires `auxclick`, whose default in a browser opens the
  // link in a new tab. In the Server Edition that tab would be a stray 404 for a relative link, so
  // the middle button gets the same decision (a web link still opens, via openExternal).
  const onAuxClick = (e: MouseEvent): void => {
    if (e.defaultPrevented || e.button !== 1) return
    handle(e)
  }
  doc.addEventListener('click', onClick)
  doc.addEventListener('auxclick', onAuxClick)
  return () => {
    doc.removeEventListener('click', onClick)
    doc.removeEventListener('auxclick', onAuxClick)
  }
}

/** The message shown for a local link. */
export const LOCAL_LINK_MESSAGE = "Local file links can't be opened from rendered markdown."

/**
 * Hand a web link to the bridge's `openExternal` without letting a failure escape as an unhandled
 * rejection. The contract types it `void`, and both bridges today return nothing (the desktop
 * preload is an IPC send, the Server Edition's is `window.open`) — but nothing stops an
 * implementation from returning a promise (a `void` return type accepts one), and `void`-ing a
 * rejected one at the call site is an unhandled rejection per failed click. `Promise.resolve` adopts a promise and wraps
 * anything else, so `.catch` is never called on a non-promise; a synchronous throw is swallowed
 * too. Nothing to report: the link simply does not open, as it would have after the rejection.
 */
export function openExternalQuietly(open: (url: string) => unknown, url: string): void {
  try {
    Promise.resolve(open(url)).catch(() => {})
  } catch {
    // A bridge that throws synchronously (torn down mid-click) — same outcome, no open.
  }
}
