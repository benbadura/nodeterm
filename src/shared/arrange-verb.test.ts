import { describe, it, expect } from 'vitest'
import {
  ARRANGE_LAYOUTS,
  GROUP_ARRANGE_LAYOUTS,
  arrangeArgsRefusal,
  arrangeGroupGuidanceLines,
  isTopLevelGroupArg,
  TOP_ARRANGE_LAYOUTS
} from './arrange-verb'

describe('arrangeArgsRefusal', () => {
  it('needs one of the two forms', () => {
    expect(arrangeArgsRefusal({})).toBe('arrange requires --nodes <id,id>, --group <frameId> or --group top')
    expect(arrangeArgsRefusal({ layout: 'row' })).toBe('arrange requires --nodes <id,id>, --group <frameId> or --group top')
  })

  it('accepts either form on its own', () => {
    expect(arrangeArgsRefusal({ nodes: 'a,b' })).toBeNull()
    expect(arrangeArgsRefusal({ group: 'g1' })).toBeNull()
    for (const layout of GROUP_ARRANGE_LAYOUTS) expect(arrangeArgsRefusal({ group: 'g1', layout })).toBeNull()
    for (const layout of ARRANGE_LAYOUTS) expect(arrangeArgsRefusal({ nodes: 'a,b', layout })).toBeNull()
    expect(arrangeArgsRefusal({ group: 'g1', layout: 'grid', cols: '3' })).toBeNull()
  })

  it('refuses both forms together instead of picking one', () => {
    // `--group` means "its direct children": with `--nodes` beside it there are two answers to
    // "which nodes", and a silent choice is a half-honoured flag the caller cannot see.
    expect(arrangeArgsRefusal({ nodes: 'a,b', group: 'g1' })).toMatch(/not both/)
  })

  it('refuses an unknown --layout on the --group form by name', () => {
    expect(arrangeArgsRefusal({ group: 'g1', layout: 'spiral' })).toBe(
      'arrange --group: --layout must be grid|row|column|lineage'
    )
  })

  it('refuses --layout lineage on the --nodes form rather than delivering a grid', () => {
    expect(arrangeArgsRefusal({ nodes: 'a,b', layout: 'lineage' })).toMatch(/lineage needs --group <frameId>/)
  })

  it('leaves the --nodes form lenient about any OTHER unknown layout word', () => {
    // It has always fallen back to grid there, and callers in the field may lean on it.
    expect(arrangeArgsRefusal({ nodes: 'a,b', layout: 'spiral' })).toBeNull()
  })
})

describe('arrange --group top', () => {
  it('names the top level with the same words move reads', () => {
    for (const g of ['top', 'none', 'ungrouped', ' top ']) expect(isTopLevelGroupArg(g)).toBe(true)
    for (const g of [undefined, '', 'g1', 'topnot']) expect(isTopLevelGroupArg(g)).toBe(false)
  })

  it('takes tidy (the default) or lineage, and refuses anything else by name', () => {
    expect(arrangeArgsRefusal({ group: 'top' })).toBeNull()
    for (const layout of TOP_ARRANGE_LAYOUTS) expect(arrangeArgsRefusal({ group: 'top', layout })).toBeNull()
    // A top-level grid that ignores lineage is what Tidy no longer is; --nodes still says it.
    expect(arrangeArgsRefusal({ group: 'top', layout: 'grid' })).toBe('arrange --group top: --layout must be tidy|lineage')
    // `tidy` names the whole canvas; on a frame it is not a layout.
    expect(arrangeArgsRefusal({ group: 'g1', layout: 'tidy' })).toMatch(/--layout must be grid\|row\|column\|lineage/)
    expect(arrangeArgsRefusal({ group: 'top', nodes: 'a,b' })).toMatch(/not both/)
  })
})

describe('arrangeGroupGuidanceLines', () => {
  const text = arrangeGroupGuidanceLines().join('\n')

  it('advertises exactly the layouts the parser accepts', () => {
    expect(text).toContain(`arrange --group <frameId> [--layout ${GROUP_ARRANGE_LAYOUTS.join('|')}] [--cols N]`)
    for (const layout of GROUP_ARRANGE_LAYOUTS) expect(arrangeArgsRefusal({ group: 'g', layout })).toBeNull()
  })

  it('states the contract an orchestrator acts on', () => {
    expect(text).toContain('direct children')
    expect(text).toContain('every frame around it')
    expect(text).toContain('top-left stays where it is')
    expect(text).toContain('never both')
  })

  it('documents the whole-canvas form with the layouts the parser accepts', () => {
    expect(text).toContain(`arrange --group top [--layout ${TOP_ARRANGE_LAYOUTS.join('|')}]`)
    expect(text).toContain("exactly as the\n  user's Tidy canvas command does")
    expect(text).toContain('working first, then waiting/blocked, idle')
    expect(text).toContain('oldest opened units come first')
    expect(text).toContain('children keep their positions')
  })
})
