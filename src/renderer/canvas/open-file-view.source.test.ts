import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// `view: true` on `nodeterm:open-file` is what turns a local .html into a rendered WebNode
// (Canvas.openFile → fileViewerKind's `renderHtml`). Only a request to SEE a file may carry it — a
// terminal link and the card preview's "Open on canvas". Explorer, ⌘K and the files node open .html
// to EDIT its source, so they must not.
const read = (rel: string): string =>
  readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

const dispatches = (src: string): string[] =>
  [...src.matchAll(/new CustomEvent\('nodeterm:open-file',\s*\{[\s\S]*?\}\s*\)/g)].map((m) => m[0])

describe('nodeterm:open-file view flag', () => {
  it('terminal links and the card preview ask to view', () => {
    for (const rel of ['nodes/TerminalNode.tsx', 'components/kanban/LocalFilePreviewModal.tsx']) {
      const ds = dispatches(read(rel))
      expect(ds.length, rel).toBeGreaterThan(0)
      for (const d of ds) expect(d, rel).toMatch(/view:\s*true/)
    }
  })

  it('the files node opens to edit', () => {
    for (const d of dispatches(read('nodes/FilesNode.tsx'))) expect(d).not.toMatch(/view:/)
  })

  it('Canvas renders HTML only for a view request, never in a browser tab', () => {
    expect(read('canvas/Canvas.tsx')).toContain('renderHtml: !!d.view && !isBrowserRuntime()')
  })
})
