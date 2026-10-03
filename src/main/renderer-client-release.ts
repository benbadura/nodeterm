// A renderer that goes away without saying so still holds whatever it subscribed to in core. The
// GitHub issue service keys subscribers by the webContents id and polls every 60 s for each
// repository that has one; a crashed, reloaded or closed window sends no unsubscribe, so its
// subscription (and that poll) lived for the rest of the app run. Relay peers and Server Edition
// sockets already release theirs on departure; this is the desktop window's equivalent.
//
// Electron-free on purpose (structural emitters), so the three signals are pressed by a test:
//   - `closed`: the window is gone (`close` only hides it on macOS).
//   - `render-process-gone`: the page died; the crash policy may reload it under the SAME id.
//   - `did-navigate`: a new document COMMITTED in the main frame (a reload, ⌘R). Deliberately not
//     `did-start-navigation`, which also fires for a navigation the navigation guard then blocks —
//     releasing there would silently drop a live board's subscription. An in-page navigation
//     (`did-navigate-in-page`) keeps the document, so it keeps the subscription.
// Releasing is idempotent; firing twice (a crash followed by its reload) is harmless.

interface EmitterLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

export function releaseOnRendererDeparture(
  win: EmitterLike,
  contents: EmitterLike,
  release: () => void
): void {
  win.on('closed', () => release())
  contents.on('render-process-gone', () => release())
  contents.on('did-navigate', () => release())
}
