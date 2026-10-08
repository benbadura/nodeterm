// A user drag or resize of a maximized node must end maximize mode (endMaximizeOnUserGeometry,
// unit-tested in state/workspace.maximize.test.ts). Canvas has no render harness, so the call
// site is pinned here: handleNodesChange feeds the MANAGED changes (never ghost/ephemeral ones)
// through movedGestureEnds with a gesture memory that outlives the batch (a resize's live changes
// and its end arrive separately), and calls setNodes only when a gesture really ended — a bare
// re-measure or a click on a grab band must not end maximize mode or cost a setNodes.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = fs.readFileSync(path.join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe('maximize mode ends on a user gesture', () => {
  it('handleNodesChange ends it only for gestures that moved the node', () => {
    const start = SRC.indexOf('const handleNodesChange: typeof onNodesChange = useCallback(')
    const body = SRC.slice(start, SRC.indexOf('\n  )\n', start))
    expect(body).toMatch(
      /onNodesChange\(snapped\)[\s\S]*const ended = movedGestureEnds\(managed, resizingIdsRef\.current\)\s*if \(ended\.size\) setNodes\(\(ns\) => endMaximizeOnUserGeometry\(ns, ended\)\)/
    )
    expect(SRC).toMatch(/const resizingIdsRef = useRef\(new Set<string>\(\)\)/)
    expect(body).toMatch(/\[onNodesChange, setNodes, markDirty, ephParentPosition\]/)
  })
})
