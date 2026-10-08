import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The Live chat drawer's stacking and its colours (components/LiveChatDrawer.tsx). jsdom has no
 * layout, so where the drawer SITS is pinned here: a z-index typo puts it under the board or under
 * the card modal it was opened from, and nothing rendered in CI would notice.
 */
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
const NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** Every rule body whose selector list contains `selector` exactly, in source order. */
function bodies(selector: string): { at: number; body: string }[] {
  const out: { at: number; body: string }[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(NO_COMMENTS))) {
    const sels = m[1].split(',').map((s) => s.replace(/\s+/g, ' ').trim())
    if (sels.includes(selector)) out.push({ at: m.index, body: m[2] })
  }
  return out
}
const zOf = (body: string): number | null => {
  const m = /z-index:\s*(\d+)/.exec(body)
  return m ? Number(m[1]) : null
}

describe('Live chat drawer CSS', () => {
  it('raised (a card modal is open, z 55) sits at 57, and wins over the pinned 26 wherever it is written', () => {
    const raised = bodies('.drawer-overlay.drawer-overlay--raised')
    expect(raised).toHaveLength(1)
    expect(zOf(raised[0].body)).toBe(57)
    // Higher specificity than `.drawer-overlay--pinned`, so source order cannot undo it.
    const pinned = bodies('.drawer-overlay--pinned').find((r) => zOf(r.body) !== null)!
    expect(zOf(pinned.body)).toBe(26)
  })

  it('beside the pinned Explorer: one Explorer width plus a gap further from the right edge', () => {
    const beside = bodies('.drawer-overlay--beside .drawer--pinned')
    expect(beside).toHaveLength(1)
    expect(beside[0].body).toContain('right: calc(var(--float-gap) + 320px + 8px)')
  })

  it('no colour literal in the drawer\'s own rules — tokens only (the name hues come from the copied web table)', () => {
    const own = [...NO_COMMENTS.matchAll(/([^{}]*\.live-chat[^{}]*)\{([^{}]*)\}/g)]
    expect(own.length).toBeGreaterThan(5)
    for (const [, head, body] of own) {
      expect(body, head.trim()).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/)
    }
  })

  it('viewer names keep their hue but are darkened toward the ink on the light theme', () => {
    const light = bodies(":root[data-theme='light'] .live-chat__name")
    expect(light).toHaveLength(1)
    expect(light[0].body).toContain('color-mix(in srgb, var(--live-name, var(--text)) 55%, var(--text-strong))')
  })
})
