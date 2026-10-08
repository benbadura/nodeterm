import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Node resize grab zones: an invisible ::before on every React Flow resize control widens the hit
 * region (edges 12 screen px, biased outward; corners 20x20) while the visible line stays 1px.
 * Parsed from the real stylesheet so a rule that loses its outward bias or its screen-px sizing
 * goes red. The live half (elementFromPoint around a selected node) is a dev-build probe.
 */
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
const rules = new Map<string, string>()
const rootBodies: string[] = []
{
  const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(noComments))) {
    const sel = m[1].replace(/\s+/g, ' ').trim()
    rules.set(sel, m[2])
    if (sel === ':root') rootBodies.push(m[2])
  }
}
/** The screen-px number a zone var is built from (`calc(Npx / k)`, possibly wrapped in a cap). */
const px = (body: string, name: string): number => {
  const m = body.match(new RegExp(`${name}:[^;]*?calc\\((\\d+)px\\s*[/*]`))
  return m ? Number(m[1]) : NaN
}

describe('resize grab zones', () => {
  const vars = rules.get('.react-flow__resize-control') ?? ''

  it('sizes the zones in screen px through --nt-zoom', () => {
    expect(vars).toMatch(/--rz-k:\s*max\(var\(--nt-zoom\),\s*0\.3\)/)
    // corner handles are counter-scaled by React Flow below zoom 1, so they divide only above it
    expect(vars).toMatch(/--rc-k:\s*max\(var\(--nt-zoom\),\s*1\)/)
    expect(vars).toMatch(/--rc-out:\s*calc\(14px \/ var\(--rc-k\)\)/)
    expect(rootBodies.some((b) => /--nt-zoom:\s*1;/.test(b))).toBe(true)
  })

  it('caps the INNER extents at 6 flow px, so zooming out never buries header buttons', () => {
    expect(vars).toMatch(/--rz-in:\s*min\(calc\(4px \/ var\(--rz-k\)\),\s*6px\)/)
    expect(vars).toMatch(/--rc-in:\s*calc\(6px \* min\(var\(--nt-zoom\),\s*1\) \/ var\(--rc-k\)\)/)
  })

  it('edges are a 12px band biased outward; corners at least 20x20 and cover the band', () => {
    const out = px(vars, '--rz-out')
    const inn = px(vars, '--rz-in')
    const cOut = px(vars, '--rc-out')
    const cIn = px(vars, '--rc-in')
    expect(out + inn).toBe(12)
    expect(out).toBeGreaterThan(inn)
    expect(cOut + cIn).toBeGreaterThanOrEqual(20)
    expect(cOut).toBeGreaterThanOrEqual(out)
    expect(cIn).toBeGreaterThanOrEqual(inn)
  })

  it('every side extends outward by --rz-out and inward by --rz-in', () => {
    const sides: Record<string, [string, string]> = { left: ['left', 'right'], right: ['right', 'left'], top: ['top', 'bottom'], bottom: ['bottom', 'top'] }
    for (const [side, [outer, inner]] of Object.entries(sides)) {
      const body = rules.get(`.react-flow__resize-control.line.${side}::before`) ?? ''
      expect(body).toMatch(new RegExp(`(^|\\s)${outer}:\\s*calc\\(-1 \\* var\\(--rz-out\\)\\)`))
      expect(body).toMatch(new RegExp(`(^|\\s)${inner}:\\s*calc\\(-1 \\* var\\(--rz-in\\)\\)`))
    }
    expect(rules.get('.react-flow__resize-control::before')).toMatch(/content:\s*''/)
  })

  it('is invisible: no grab-zone rule paints anything', () => {
    const zones = [...rules].filter(([sel]) => sel.includes('.react-flow__resize-control') && sel.includes('::before'))
    expect(zones.length).toBeGreaterThanOrEqual(9)
    for (const [, body] of zones) expect(body).not.toMatch(/background|border|box-shadow|outline|opacity/)
  })

  it('the paint-only resizer copies (.nt-resize-ghost) grow no grab zone', () => {
    expect(rules.get('.react-flow__resize-control.nt-resize-ghost::before')).toMatch(/content:\s*none/)
  })
})
