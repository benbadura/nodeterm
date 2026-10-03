// Issue #852: the link map is the read AUTHORIZATION (main serves a node only the entries of its
// own document). A one-way link must therefore put an entry on the reading side only.
import { describe, it, expect } from 'vitest'
import { buildBackgroundLinkMaps, buildLinkMap, type LinkNodeInfo } from './context-link-map'
import type { CanvasNodeState } from './types'

const info = (id: string): LinkNodeInfo => ({ id, title: id.toUpperCase(), cwd: `/w/${id}`, sticky: id.startsWith('s') })

describe('buildLinkMap direction', () => {
  it('a link without a reader maps both directions (backward compatible)', () => {
    const map = buildLinkMap([{ source: 'a', target: 'b' }], info)
    expect(Object.keys(map).sort()).toEqual(['a', 'b'])
    expect(map.a!.map((e) => e.id)).toEqual(['b'])
    expect(map.b!.map((e) => e.id)).toEqual(['a'])
  })

  it('reader = source: only the source gets an entry', () => {
    const map = buildLinkMap([{ source: 'a', target: 'b', reader: 'a' }], info)
    expect(map).toEqual({ a: [{ id: 'b', title: 'B', cwd: '/w/b' }] })
  })

  it('reader = target: only the target gets an entry', () => {
    const map = buildLinkMap([{ source: 'a', target: 'b', reader: 'b' }], info)
    expect(map).toEqual({ b: [{ id: 'a', title: 'A', cwd: '/w/a' }] })
  })

  it('a reader naming neither endpoint authorizes nobody', () => {
    expect(buildLinkMap([{ source: 'a', target: 'b', reader: 'x' }], info)).toEqual({})
  })

  it('a malformed (non-string) persisted reader authorizes nobody', () => {
    expect(buildLinkMap([{ source: 'a', target: 'b', reader: null as never }], info)).toEqual({})
    expect(buildLinkMap([{ source: 'a', target: 'b', reader: 42 as never }], info)).toEqual({})
  })

  it('note links keep their fixed direction (terminal reads the sticky)', () => {
    const map = buildLinkMap([{ source: 's1', target: 'a' }], info)
    expect(Object.keys(map)).toEqual(['a'])
  })
})

describe('buildBackgroundLinkMaps direction', () => {
  const node = (id: string): CanvasNodeState => ({
    id, kind: 'terminal', agentId: 'claude', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
    title: id, color: '#fff', group: null, cwd: `/w/${id}`
  })

  it('honours a persisted reader and still reads old, reader-less bridges as bidirectional', () => {
    const map = buildBackgroundLinkMaps(
      [
        { id: 'p1', nodes: [node('a'), node('b')], bridges: [{ id: 'l1', source: 'a', target: 'b', reader: 'a' }] },
        { id: 'p2', nodes: [node('c'), node('d')], bridges: [{ id: 'l2', source: 'c', target: 'd' }] }
      ],
      null,
      () => undefined
    )
    expect(Object.keys(map).sort()).toEqual(['a', 'c', 'd'])
  })
})
