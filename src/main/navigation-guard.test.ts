import { describe, it, expect } from 'vitest'
import { decideMainFrameNavigation, isSafeExternalUrl, appEntryUrlFor } from './navigation-guard'

const PACKAGED = 'file:///Applications/nodeterm.app/Contents/Resources/app.asar/out/renderer/index.html'
const DEV = 'http://localhost:5173/'

describe('decideMainFrameNavigation', () => {
  it('allows the entry document itself, ignoring hash and query (reload, dev HMR)', () => {
    expect(decideMainFrameNavigation(PACKAGED, PACKAGED)).toBe('allow')
    expect(decideMainFrameNavigation(`${PACKAGED}#glyphgrid`, PACKAGED)).toBe('allow')
    expect(decideMainFrameNavigation(`${PACKAGED}?t=1`, PACKAGED)).toBe('allow')
    expect(decideMainFrameNavigation(DEV, DEV)).toBe('allow')
    expect(decideMainFrameNavigation('http://localhost:5173/?reload=1#x', DEV)).toBe('allow')
  })

  it('treats a percent-encoded spelling of the same entry path as the same document', () => {
    const entry = 'file:///Users/me/My%20Apps/out/renderer/index.html'
    expect(decideMainFrameNavigation('file:///Users/me/My Apps/out/renderer/index.html', entry)).toBe(
      'allow'
    )
  })

  it('BLOCKS a relative markdown link resolved against the packaged entry (the canvas wipe)', () => {
    // `[pty-manager.ts](src/core/pty-manager.ts:4100)` clicked in rendered markdown.
    const resolved = new URL('src/core/pty-manager.ts:4100', PACKAGED).href
    expect(decideMainFrameNavigation(resolved, PACKAGED)).toBe('block')
  })

  it('blocks every other file:// URL', () => {
    expect(decideMainFrameNavigation('file:///etc/passwd', PACKAGED)).toBe('block')
    expect(decideMainFrameNavigation('file:///etc/passwd', DEV)).toBe('block')
  })

  it('blocks another path on the dev server instead of opening it in the system browser', () => {
    const resolved = new URL('src/core/pty-manager.ts:4100', DEV).href
    expect(decideMainFrameNavigation(resolved, DEV)).toBe('block')
  })

  it('hands safe external schemes to the OS', () => {
    expect(decideMainFrameNavigation('https://github.com/x', PACKAGED)).toBe('external')
    expect(decideMainFrameNavigation('http://example.com/', DEV)).toBe('external')
    expect(decideMainFrameNavigation('mailto:a@b.c', PACKAGED)).toBe('external')
  })

  it('blocks other schemes and garbage', () => {
    expect(decideMainFrameNavigation('javascript:alert(1)', PACKAGED)).toBe('block')
    expect(decideMainFrameNavigation('smb://server/share', PACKAGED)).toBe('block')
    expect(decideMainFrameNavigation('data:text/html,x', PACKAGED)).toBe('block')
    expect(decideMainFrameNavigation('not a url', PACKAGED)).toBe('block')
    // An unparsable entry never turns into "allow everything".
    expect(decideMainFrameNavigation(PACKAGED, '')).toBe('block')
  })
})

describe('appEntryUrlFor', () => {
  it('prefers the dev-server URL', () => {
    expect(appEntryUrlFor(DEV, '/x/out/renderer/index.html')).toBe(DEV)
  })
  it('turns the packaged file path into a file URL', () => {
    expect(appEntryUrlFor(undefined, '/x/My Apps/out/renderer/index.html')).toBe(
      'file:///x/My%20Apps/out/renderer/index.html'
    )
  })
})

describe('isSafeExternalUrl', () => {
  it('accepts only http/https/mailto', () => {
    expect(isSafeExternalUrl('https://a.b')).toBe(true)
    expect(isSafeExternalUrl('mailto:a@b.c')).toBe(true)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('relative/path')).toBe(false)
    expect(isSafeExternalUrl(42)).toBe(false)
  })
})
