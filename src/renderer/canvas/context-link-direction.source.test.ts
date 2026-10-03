import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for one-way context links (issue #852). The direction lives on the persisted
 * bridge (`reader`) and rides React Flow's `edge.data`; every place Canvas converts between the
 * two must go through `bridgeToEdge` / `edgeToBridge`, or a load, save or server merge silently
 * turns a one-way link back into a two-way one. The behavioural halves are proven in
 * `noteLink.test.ts` (conversion), `serverChange.test.ts` (merge), `context-link-map.test.ts`
 * (map) and `context-link.handler.test.ts` (read refusal).
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8')

describe('one-way context links — Canvas wiring (source pins)', () => {
  it('never rebuilds a bridge edge field-by-field (that drops the reader)', () => {
    expect(src).not.toMatch(/\(\{ id: b\.id, source: b\.source, target: b\.target \}\)/)
    expect(src).not.toMatch(/linkEdgesRef\.current\.map\(\(e\) => \(\{ id: e\.id, source: e\.source, target: e\.target \}\)\)/)
    expect(src).toContain('const loadedBridges: Edge[] = (project.bridges ?? []).map(bridgeToEdge)')
    expect(src).toContain('linkEdgesRef.current.map(edgeToBridge)')
    expect(src).toContain('liveBridges: linkEdgesRef.current.map(edgeToBridge)')
    expect(src).toContain('const bridges: Edge[] = plan.bridges.map(bridgeToEdge)')
  })

  it('publishes the link map from reader-carrying bridges', () => {
    expect(src).toMatch(/useContextLinkSync\(\{ projectId: renderedProjectId, nodes, edges: linkBridges \}\)/)
  })

  it('draws the arrowhead on the reading side only for a one-way link', () => {
    const start = src.indexOf('const displayEdges = useMemo(')
    const body = src.slice(start, src.indexOf('const ropeCoversLink', start))
    expect(body).toContain('linkReadPairs(')
  })

  it('offers the direction on the context-link edge menu and routes it through withLinkReader', () => {
    expect(src).toMatch(/onEdgeContextMenu=\{onEdgeContextMenu\}/)
    const start = src.indexOf('const onEdgeContextMenu = useCallback(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, start + 4000)
    expect(body).toContain('withLinkReader(')
    expect(body).toContain('gainedReaders(')
  })

  it('the link verb passes --one-way to the shared planner', () => {
    const start = src.indexOf("case 'link': {")
    const body = src.slice(start, start + 2000)
    expect(body).toContain("'one-way' in args")
  })

  it('CLI-created bridges become live edges only through appendBridgeEdges (review P1)', () => {
    // Appending planBridges output raw puts `reader` top-level, where edgeToBridge never looks.
    expect(src).not.toMatch(/setLinkEdges\(\(es\) => \[\.\.\.es,/)
    expect(src).toContain('setLinkEdges((es) => appendBridgeEdges(es, plan.edges))')
  })

  it('right-clicking a rope resolves the context link it covers (review P2b)', () => {
    const start = src.indexOf('const onEdgeContextMenu = useCallback(')
    const body = src.slice(start, start + 1500)
    expect(body).toContain('contextLinkForEdge(')
    expect(body).toContain('controlEdgesRef.current')
  })

  it('team sync casts and applies bridges WITH their reader (a flip must not widen on a peer)', () => {
    // No bridge list may be flattened to three ids on its way to or from the wire.
    expect(src).not.toMatch(/bridges\.map\(toBridgeLink\)/)
    expect(src).not.toMatch(/prevBridges\.map\(toBridgeLink\)/)
    const pub = src.slice(src.indexOf('const publishableLater = useCallback('))
    expect(pub.slice(0, 2500)).toContain('bridges: bridges.map(edgeToBridge)')
    const apply = src.slice(src.indexOf('if (isEdgeMutation(mutation)) {'))
    const body = apply.slice(0, 4000)
    expect(body).toContain('bridges: prevBridges.map(edgeToBridge)')
    // A held bridge is reused only while its reader is unchanged.
    expect(body).toContain('edgeToBridge(held).reader === b.reader')
  })
})
