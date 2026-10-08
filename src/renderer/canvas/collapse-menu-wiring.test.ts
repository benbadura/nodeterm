// Canvas has no render harness, so the Collapse / Expand menu gate is pinned at its call site: the
// row must be offered only for nodes the toggle may act on (canToggleCollapse — collapsible kinds,
// plus any node already collapsed so a legacy one can still expand), and the toggle must go
// through the shared toggleCollapsed. Without the gate, a group frame or editor in a
// multi-selection is squashed to the 40px collapsed bar with its content crushed.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = fs.readFileSync(path.join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe('Collapse / Expand menu wiring', () => {
  it('gates the row on canToggleCollapse over the targets', () => {
    const row = SRC.indexOf("label: 'Collapse / Expand'")
    expect(row).toBeGreaterThan(-1)
    const gate = SRC.slice(SRC.lastIndexOf("isHidden('collapse', hidden)", row), row)
    expect(gate).toMatch(/!ids\.some\(\(nid\) => \{[\s\S]*canToggleCollapse\(n\)/)
  })

  it('toggles through the shared helper', () => {
    expect(SRC).toMatch(/const toggleCollapseNodes = useCallback\(\s*\(ids: string\[\]\) => \{\s*setNodes\(\(ns\) => toggleCollapsed\(ns, ids\)\)/)
  })
})
