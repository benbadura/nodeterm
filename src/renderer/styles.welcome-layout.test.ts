import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The start screen's lists line up with its card row (#1062 follow-up).
 *
 * MEASURED in headless Chrome against the real component + these rules (2000px window): the cards
 * span x 679–1321 and so does `.welcome__lists`; Recent conversations is 679–993 and Recently closed
 * 1007–1321; the section title, folder headers, row icons and "Show all" all start their text at
 * 689. Before, both lists were separate 480px boxes (760–1240) and those four lines started at
 * 2/10/11/~16px in. At 420px the card row overflowed the window; it is now a 2×2 grid at 16–404.
 *
 * Each rule below is one half of that, and every one is invisible in review: a `max-width` that
 * drifts from the card math, or a dropped `:only-child`, restores a lopsided page with nothing
 * failing. `\r\n` is normalized as in every other file-reading test here.
 */
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')

/** The body of a top-level multi-line rule (`.sel {` on its own line). */
function rule(sel: string, from = 0): string {
  const i = CSS.indexOf(`\n${sel} {\n`, from)
  expect(i, `no rule for ${sel}`).toBeGreaterThan(-1)
  return CSS.slice(i, CSS.indexOf('\n}', i))
}

describe('welcome screen: the lists share the card row’s width', () => {
  it('derives the row width from the cards’ own width and gap', () => {
    const card = rule('.welcome__card').match(/\n {2}width: (\d+)px;/)
    const gap = rule('.welcome__cards').match(/gap: (\d+)px;/)
    expect(card && gap).toBeTruthy()
    expect(rule('.welcome')).toContain(`--welcome-row: calc(4 * ${card![1]}px + 3 * ${gap![1]}px);`)
  })

  it('makes .welcome__lists exactly that wide, as two equal columns', () => {
    const lists = rule('.welcome__lists')
    expect(lists).toContain('width: 100%')
    expect(lists).toContain('max-width: var(--welcome-row)')
    expect(lists).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)')
    expect(lists).toContain('column-gap: 14px')
  })

  it('lets a lone section span both columns instead of sitting half-width on one side', () => {
    expect(rule('.welcome__lists > :only-child')).toContain('grid-column: 1 / -1')
  })

  it('no section re-imposes its own narrower width', () => {
    expect(rule('.welcome__recent')).not.toMatch(/max-width/)
  })

  it('stacks the lists and wraps the cards to the same width below the breakpoint', () => {
    const at = CSS.indexOf('@media (max-width: 700px) {')
    expect(at).toBeGreaterThan(-1)
    const block = CSS.slice(at, CSS.indexOf('\n}', at))
    expect(block).toMatch(/\.welcome__cards \{[^}]*max-width: var\(--welcome-row\)/)
    expect(block).toMatch(/\.welcome__lists \{[^}]*grid-template-columns: minmax\(0, 1fr\);/)
  })
})

describe('welcome screen: one left edge, one right edge per column', () => {
  it('title, folder header and "Show all" inset their text 10px; bordered boxes 9px + 1px border', () => {
    expect(rule('.welcome__recent-title')).toContain('padding: 0 10px')
    expect(rule('.welcome__convs-folder')).toContain('padding: 2px 10px')
    expect(rule('.welcome__convs-more')).toContain('padding: 2px 10px')
    expect(rule('.welcome__recent-item')).toContain('padding: 8px 9px')
    expect(rule('.welcome__recent-filter')).toContain('padding: 5px 9px')
  })

  it('the hidden row action does not reserve width beside the age', () => {
    // An `opacity: 0` action kept its width, so every timestamp stopped short of the edge by a
    // different amount. It is now out of the layout until hover/focus, when it replaces the age.
    expect(rule('.welcome__conv-action')).toContain('display: none')
    expect(rule('.welcome__conv-age')).toContain('margin-left: auto')
  })

  it('long folder names ellipsize', () => {
    const name = rule('.welcome__convs-folder-name')
    expect(name).toContain('min-width: 0')
    expect(name).toContain('text-overflow: ellipsis')
    expect(name).toContain('white-space: nowrap')
  })
})
