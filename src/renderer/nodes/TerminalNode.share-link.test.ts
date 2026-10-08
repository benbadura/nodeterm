// Source-level: TerminalNode cannot be mounted in a unit test (xterm, the pty transport and React
// Flow's store all live behind it), so the header's "Share live link" button is pinned here. What it
// does after the click — availability, the Pro gate, the dialog — is Canvas's `nodeterm:live-link`
// listener, behaviour-tested through `openLiveLink` in lib/liveLinkEntry.test.tsx.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, 'TerminalNode.tsx'), 'utf8').replace(/\r\n/g, '\n')

/** The header button's JSX block, from its hideable guard to the guard that follows it. */
function shareBlock(): string {
  const start = src.indexOf("{!isHidden('share-link', hiddenHeaderButtons) && (")
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf("{!isHidden('hide-fanout', hiddenHeaderButtons) && (", start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('TerminalNode header: Share live link', () => {
  it('is a hideable header button that opens the live-link flow for THIS node', () => {
    const b = shareBlock()
    expect(b).toContain("new CustomEvent('nodeterm:live-link'")
    expect(b).toContain('nodeId: id')
    // A canvas node only ever lives in the active project's canvas.
    expect(b).toContain('projectId: owningProjectId()')
    expect(b).toContain('<IconBroadcast />')
  })

  it('is disabled, with the reason as its tooltip, wherever sharing is unavailable', () => {
    const b = shareBlock()
    expect(b).toContain('disabled={!!shareLinkWhy}')
    expect(b).toContain("label={shareLinkWhy ?? 'Share live link'}")
    // The ONE availability rule, judged by this node's session (a relay tab is refused), with a
    // primitive store selector so the header does not re-render on every watch-link push.
    expect(src).toMatch(/const shareLinkWhy = liveLinkUnavailable\(\{\s*serverEdition: isBrowserRuntime\(\),\s*source: session\.source,/)
    expect(src).toContain('const activeLiveLinks = useWatchLinks((s) => s.links.length)')
  })

  it('sits between Comments and the cards & connections eye', () => {
    const comments = src.indexOf("{!isHidden('comments', hiddenHeaderButtons) && (")
    const share = src.indexOf("{!isHidden('share-link', hiddenHeaderButtons) && (")
    const eye = src.indexOf("{!isHidden('hide-fanout', hiddenHeaderButtons) && (")
    expect(comments).toBeGreaterThan(-1)
    expect(comments).toBeLessThan(share)
    expect(share).toBeLessThan(eye)
  })
})
