import { describe, it, expect } from 'vitest'
import { canToggleCollapse, COLLAPSED_HEIGHT, isCollapsible, toggleCollapsed } from './workspace'
import type { CanvasNode } from './workspace'

const node = (type: string, height: number, extra: Partial<CanvasNode['data']> = {}): CanvasNode =>
  ({
    id: 'a',
    type,
    position: { x: 0, y: 0 },
    width: 320,
    height,
    measured: { width: 320, height },
    style: { width: 320, height },
    data: { title: 'a', color: '#fff', group: null, ...extra }
  }) as CanvasNode

describe('toggleCollapsed', () => {
  it('records the LIVE height on collapse, not the stale load-time expandedHeight', () => {
    // Hydration stamps expandedHeight at load; the user then resized 440 -> 800.
    const resized = node('terminal', 800, { expandedHeight: 440 })
    const collapsed = toggleCollapsed([resized], ['a'])[0]
    expect(collapsed.data.collapsed).toBe(true)
    expect(collapsed.height).toBe(COLLAPSED_HEIGHT)
    expect(collapsed.data.expandedHeight).toBe(800)
    // React Flow re-measures the collapsed bar; expand must still restore the recorded size.
    const measuredBar = { ...collapsed, measured: { width: 320, height: COLLAPSED_HEIGHT } }
    const expanded = toggleCollapsed([measuredBar], ['a'])[0]
    expect(expanded.data.collapsed).toBe(false)
    expect(expanded.height).toBe(800)
    expect(expanded.style).toMatchObject({ height: 800 })
  })

  it('only collapses kinds that render a collapsed state', () => {
    for (const kind of ['terminal', 'sticky', 'files'] as const) expect(isCollapsible({ type: kind })).toBe(true)
    for (const kind of ['group', 'editor', 'diff', 'browser', 'web', 'video', 'dino', 'trigger'] as const) {
      expect(isCollapsible({ type: kind })).toBe(false)
      const n = node(kind, 300)
      expect(toggleCollapsed([n], ['a'])[0]).toBe(n)
    }
  })

  it('still EXPANDS a non-collapsible kind an older build saved collapsed, and never re-collapses it', () => {
    const legacy = { ...node('editor', COLLAPSED_HEIGHT, { collapsed: true, expandedHeight: 460 }) }
    expect(canToggleCollapse(legacy)).toBe(true)
    const expanded = toggleCollapsed([legacy], ['a'])[0]
    expect(expanded.data.collapsed).toBe(false)
    expect(expanded.height).toBe(460)
    expect(canToggleCollapse(expanded)).toBe(false)
    expect(toggleCollapsed([expanded], ['a'])[0]).toBe(expanded)
  })

  it('falls back to the per-kind height when a node has no size at all', () => {
    for (const [kind, h] of [['terminal', 300], ['sticky', 200], ['files', 460]] as const) {
      const bare = { ...node(kind, 0), height: undefined, measured: undefined } as CanvasNode
      expect(toggleCollapsed([bare], ['a'])[0].data.expandedHeight).toBe(h)
    }
  })

  it('leaves nodes outside ids untouched', () => {
    const n = node('terminal', 300)
    expect(toggleCollapsed([n], ['other'])[0]).toBe(n)
  })
})
