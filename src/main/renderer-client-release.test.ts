import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { releaseOnRendererDeparture } from './renderer-client-release'

function wired() {
  const win = new EventEmitter()
  const contents = new EventEmitter()
  const release = vi.fn()
  releaseOnRendererDeparture(win, contents, release)
  return { win, contents, release }
}

describe('releaseOnRendererDeparture', () => {
  it('releases when the window closes', () => {
    const { win, release } = wired()
    win.emit('closed')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases when the renderer process dies', () => {
    const { contents, release } = wired()
    contents.emit('render-process-gone', {}, { reason: 'oom' })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases when a reload commits a new document (the same webContents id comes back empty)', () => {
    const { contents, release } = wired()
    contents.emit('did-navigate', {}, 'file:///app/index.html', 200, 'OK')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('does not release for an in-page navigation, where the page and its subscriptions live on', () => {
    const { contents, release } = wired()
    contents.emit('did-navigate-in-page', {}, 'file:///app/index.html#x', true)
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(release).not.toHaveBeenCalled()
  })
})

describe('main/index.ts wiring', () => {
  it('releases the window GitHub subscriber through the shared helper', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(source).toMatch(/releaseOnRendererDeparture\(win, win\.webContents, \(\) => dropGitHubClient\?\.\(presenceId\)\)/)
  })
})
