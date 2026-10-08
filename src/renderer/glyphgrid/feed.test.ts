import { describe, expect, it } from 'vitest'
import {
  CELL_STRIDE,
  FLAG_BOLD,
  FLAG_CURSOR,
  FLAG_ITALIC,
  FLAG_SELECTED,
  FLAG_STRIKETHROUGH,
  FLAG_UNDERLINE,
  FLAG_WIDE,
  packColor,
  readCell
} from './cells'
import type { GlyphAtlas, GlyphPart } from './atlas'
import type { DecorationReader } from './decorations'
import { packViewportRow, setBlankCellProbe, type BlankCellReport, type CellView, type RowFeedOpts, type ThemeLanes } from './feed'

const THEME: ThemeLanes = {
  fg: packColor(0xd0, 0xd1, 0xd2, 0xff),
  bg: packColor(0x10, 0x11, 0x12, 0xff),
  // One distinguishable color per index, so a wrong index is a wrong assertion and not a
  // coincidence: index i is recoverable from any channel.
  ansi: Array.from({ length: 256 }, (_, i) => packColor(i, 0x80, 0xff - i, 0xff)),
  cursorFg: packColor(0x01, 0x02, 0x03, 0xff),
  cursorBg: packColor(0xfa, 0xfb, 0xfc, 0xff),
  selectionBg: packColor(0x30, 0x50, 0x80, 0xff)
}

/** Records every glyphFor call so "the atlas was NOT called" is assertable, and hands back a
 *  distinct non-zero slot per call so a glyph lane can be traced to the call that produced it.
 *
 *  Two parallel records rather than one 5-tuple: `calls` is the shape/style key every existing
 *  assertion reads, and `colors` is the COLOUR key at the same index. The atlas is keyed by both
 *  from Phase 1c on, so what the feed asks for is as load-bearing as what it writes into the lanes
 *  — a cell that renders selected but requests a slot painted in its unselected colours is
 *  invisible in the lanes and wrong on screen. */
function fakeAtlas(): Pick<GlyphAtlas, 'glyphFor'> & {
  calls: Array<[number, boolean, boolean]>
  colors: Array<[number, number]>
  parts: GlyphPart[]
  underlines: boolean[]
  strikethroughs: boolean[]
} {
  const calls: Array<[number, boolean, boolean]> = []
  const colors: Array<[number, number]> = []
  // A THIRD parallel record, for the same reason as `colors`: which HALF of a double-width
  // character a cell asks for is part of the key, and it is the difference between an emoji
  // rendering whole and rendering as its left fragment. Kept out of `calls` so the many
  // assertions that pin `calls` verbatim stay about what they were written for.
  const parts: GlyphPart[] = []
  const underlines: boolean[] = []
  const strikethroughs: boolean[] = []
  return {
    calls,
    colors,
    parts,
    underlines,
    strikethroughs,
    glyphFor(
      code: number,
      bold: boolean,
      italic: boolean,
      fg: number,
      bg: number,
      part: GlyphPart = 'whole',
      underline = false,
      strikethrough = false
    ): number {
      calls.push([code, bold, italic])
      colors.push([fg, bg])
      parts.push(part)
      underlines.push(underline)
      strikethroughs.push(strikethrough)
      return 900 + calls.length
    }
  }
}

type Attr = 'default' | ['palette', number] | ['rgb', number]

function makeCell(
  o: {
    /** Defaults to '' so the existing tests keep exercising the getCode() fallback path. */
    chars?: string
    code?: number
    width?: number
    bold?: boolean
    italic?: boolean
    underline?: boolean
    strikethrough?: boolean
    inverse?: boolean
    dim?: boolean
    fg?: Attr
    bg?: Attr
  } = {}
): CellView {
  const fg: Attr = o.fg ?? 'default'
  const bg: Attr = o.bg ?? 'default'
  const is = (a: Attr, mode: string): boolean => (a === 'default' ? mode === 'default' : a[0] === mode)
  const val = (a: Attr): number => (a === 'default' ? 0 : a[1])
  return {
    getChars: () => o.chars ?? '',
    getCode: () => o.code ?? 0x41,
    getWidth: () => o.width ?? 1,
    isBold: () => (o.bold ? 1 : 0),
    isItalic: () => (o.italic ? 1 : 0),
    isUnderline: () => (o.underline ? 1 : 0),
    isStrikethrough: () => (o.strikethrough ? 1 : 0),
    isInverse: () => (o.inverse ? 1 : 0),
    isDim: () => (o.dim ? 1 : 0),
    isFgDefault: () => is(fg, 'default'),
    isFgPalette: () => is(fg, 'palette'),
    isFgRGB: () => is(fg, 'rgb'),
    isBgDefault: () => is(bg, 'default'),
    isBgPalette: () => is(bg, 'palette'),
    isBgRGB: () => is(bg, 'rgb'),
    getFgColor: () => val(fg),
    getBgColor: () => val(bg)
  }
}

/** A `DecorationReader` over a literal list, plus a walk counter so "the per-cell walk was
 *  SKIPPED" is assertable — that fast path is the whole reason a canvas with no search open pays
 *  nothing for this feature. */
function decoReader(
  entries: Array<{ col: number; row?: number; layer?: string; bg?: number; fg?: number }>
): DecorationReader & { walks: number } {
  const r = {
    walks: 0,
    empty: (): boolean => entries.length === 0,
    atCell: (
      col: number,
      row: number,
      cb: (d: { layer?: string; bg?: number; fg?: number }) => void
    ): void => {
      r.walks++
      entries.filter((e) => e.col === col && (e.row ?? 0) === row).forEach(cb)
    }
  }
  return r
}

function pack(
  cells: readonly (CellView | undefined)[],
  o: Partial<
    Pick<
      RowFeedOpts,
      | 'cols'
      | 'selection'
      | 'cursorCol'
      | 'cursorShape'
      | 'focused'
      | 'atlas'
      | 'linkUnderline'
      | 'decorations'
      | 'bufferRow'
    >
  > = {}
): { out: Uint32Array; atlas: ReturnType<typeof fakeAtlas> } {
  const atlas = (o.atlas as ReturnType<typeof fakeAtlas>) ?? fakeAtlas()
  const cols = o.cols ?? cells.length
  const out = new Uint32Array(cols * CELL_STRIDE)
  packViewportRow(out, (col) => cells[col], makeCell(), {
    cols,
    atlas,
    theme: THEME,
    selection: o.selection ?? null,
    linkUnderline: o.linkUnderline ?? null,
    cursorCol: o.cursorCol ?? -1,
    cursorShape: o.cursorShape,
    focused: o.focused,
    decorations: o.decorations,
    bufferRow: o.bufferRow
  })
  return { out, atlas }
}

const halve = (c: number): number =>
  packColor((c & 0xff) >>> 1, ((c >>> 8) & 0xff) >>> 1, ((c >>> 16) & 0xff) >>> 1, (c >>> 24) & 0xff)

describe('packViewportRow — colors', () => {
  it('default fg/bg resolve to the theme lanes and the glyph comes from the atlas', () => {
    const { out, atlas } = pack([makeCell({ code: 0x41 })])
    expect(readCell(out, 0)).toEqual({ glyph: 901, fg: THEME.fg, bg: THEME.bg, flags: 0 })
    expect(atlas.calls).toEqual([[0x41, false, false]])
  })

  it('palette fg/bg index into theme.ansi', () => {
    const { out } = pack([makeCell({ fg: ['palette', 2], bg: ['palette', 250] })])
    const c = readCell(out, 0)
    expect(c.fg).toBe(THEME.ansi[2])
    expect(c.bg).toBe(THEME.ansi[250])
  })

  it('an out-of-range palette index falls back to the theme default rather than undefined', () => {
    const { out } = pack([makeCell({ fg: ['palette', 999], bg: ['palette', -1] })])
    const c = readCell(out, 0)
    expect(c.fg).toBe(THEME.fg)
    expect(c.bg).toBe(THEME.bg)
  })

  it('RGB colors pack 0xRRGGBB into opaque lanes', () => {
    const { out } = pack([makeCell({ fg: ['rgb', 0xaabbcc], bg: ['rgb', 0x123456] })])
    const c = readCell(out, 0)
    expect(c.fg).toBe(packColor(0xaa, 0xbb, 0xcc, 0xff))
    expect(c.bg).toBe(packColor(0x12, 0x34, 0x56, 0xff))
  })

  it('inverse swaps the RESOLVED pair (palette fg on default bg)', () => {
    const { out } = pack([makeCell({ fg: ['palette', 2], inverse: true })])
    const c = readCell(out, 0)
    expect(c.fg).toBe(THEME.bg)
    expect(c.bg).toBe(THEME.ansi[2])
  })

  it('dim halves the fg RGB channels and keeps alpha', () => {
    const { out } = pack([makeCell({ fg: ['rgb', 0xff0f01], dim: true })])
    expect(readCell(out, 0).fg).toBe(packColor(0x7f, 0x07, 0x00, 0xff))
  })

  it('dim applies AFTER inverse — it halves the swapped foreground, not the original', () => {
    const { out } = pack([makeCell({ fg: ['palette', 2], dim: true, inverse: true })])
    const c = readCell(out, 0)
    expect(c.fg).toBe(halve(THEME.bg)) // the bg that inverse moved into the fg slot
    expect(c.bg).toBe(THEME.ansi[2]) // background is never dimmed
  })
})

describe('packViewportRow — attributes', () => {
  it('bold picks the bold glyph variant and sets FLAG_BOLD (no bright-color promotion in v1)', () => {
    const { out, atlas } = pack([makeCell({ code: 0x42, bold: true, fg: ['palette', 1] })])
    expect(atlas.calls).toEqual([[0x42, true, false]])
    const c = readCell(out, 0)
    expect(c.flags).toBe(FLAG_BOLD)
    expect(c.fg).toBe(THEME.ansi[1]) // NOT promoted to ansi[9]
  })

  it('italic and underline set their flags; italic reaches the atlas key', () => {
    const { out, atlas } = pack([makeCell({ code: 0x43, italic: true, underline: true })])
    expect(atlas.calls).toEqual([[0x43, false, true]])
    expect(readCell(out, 0).flags).toBe(FLAG_ITALIC | FLAG_UNDERLINE)
  })

  /**
   * Reported 2026-10-06: a diff viewer's removed lines (`\e[9m`) showed no strikethrough in shared
   * mode while GPU mode drew one. The feed never read the attribute at all.
   */
  it('strikethrough sets FLAG_STRIKETHROUGH and asks the atlas for the STRUCK variant', () => {
    const { out, atlas } = pack([makeCell({ code: 0x44, strikethrough: true })])

    expect(readCell(out, 0).flags).toBe(FLAG_STRIKETHROUGH)
    expect(atlas.strikethroughs).toEqual([true])
    expect(atlas.underlines).toEqual([false])
  })

  it('strikes a SPACE inside a struck run — the line must not dash at word gaps', () => {
    const { out, atlas } = pack([makeCell({ code: 0x20, strikethrough: true })])

    expect(readCell(out, 0).glyph).not.toBe(0)
    expect(atlas.strikethroughs).toEqual([true])
  })

  it('an undecorated space still takes the blank slot', () => {
    const { out, atlas } = pack([makeCell({ code: 0x20 })])

    expect(readCell(out, 0).glyph).toBe(0)
    expect(atlas.calls).toEqual([])
  })
})

describe('packViewportRow — wide and zero-width cells', () => {
  it('a wide char paints its two halves into its two cells, on one unbroken background', () => {
    const wide = makeCell({ code: 0x4e2d, width: 2, bg: ['rgb', 0x223344] })
    const cont = makeCell({ code: 0, width: 0, bg: ['rgb', 0x223344] })
    const { out, atlas } = pack([wide, cont])
    const lead = readCell(out, 0)
    const tail = readCell(out, 1)
    expect(lead.glyph).toBe(901)
    expect(lead.flags & FLAG_WIDE).toBe(FLAG_WIDE)
    // A slot's ink box is ONE cell and the overflow is cut, so a blank follower here threw the
    // character's right half away — the 2026-08-05 ⭐ report. It asks for that half instead, from
    // its OWN slot: same character and style, 'wide-right'.
    expect(tail.glyph).toBe(902)
    expect(tail.glyph).not.toBe(lead.glyph)
    expect(tail.bg).toBe(lead.bg) // unbroken background run under the glyph
    expect(tail.fg).toBe(lead.fg)
    expect(atlas.calls).toEqual([
      [0x4e2d, false, false],
      [0x4e2d, false, false]
    ])
    expect(atlas.parts).toEqual(['wide-left', 'wide-right'])
  })

  it('the follower inherits the LEAD’s style, not its own empty cell’s', () => {
    // The two halves come off the same face or they meet at a step. The follower cell carries no
    // attributes of its own, so reading them off it would draw a bold emoji's right half regular.
    const lead = makeCell({ code: 0x4e2d, width: 2, bold: true, italic: true })
    const cont = makeCell({ code: 0, width: 0 })
    const { atlas } = pack([lead, cont])
    expect(atlas.calls).toEqual([
      [0x4e2d, true, true],
      [0x4e2d, true, true]
    ])
  })

  it('the follower carries the lead’s strikethrough, so both halves are crossed out', () => {
    const lead = makeCell({ code: 0x4e2d, width: 2, strikethrough: true })
    const cont = makeCell({ code: 0, width: 0 })

    const { out, atlas } = pack([lead, cont])

    expect(atlas.strikethroughs).toEqual([true, true])
    expect(readCell(out, 1).flags & FLAG_STRIKETHROUGH).toBe(FLAG_STRIKETHROUGH)
  })

  it('a zero-width cell with no wide lead before it still writes a blank cell (never stale)', () => {
    // The row buffer is reused across frames, so "write nothing" would leave the PREVIOUS
    // frame's lanes at that column. Every column is always written.
    const out = new Uint32Array(1 * CELL_STRIDE)
    out.fill(0xdeadbeef)
    packViewportRow(out, () => makeCell({ code: 0x300, width: 0, bg: ['rgb', 0x010203] }), makeCell(), {
      cols: 1,
      atlas: fakeAtlas(),
      theme: THEME,
      selection: null,
      cursorCol: -1
    })
    const c = readCell(out, 0)
    expect(c.glyph).toBe(0)
    expect(c.bg).toBe(packColor(0x01, 0x02, 0x03, 0xff))
  })

  it('a wide lead in the last column does not write past the row', () => {
    const out = new Uint32Array(1 * CELL_STRIDE)
    packViewportRow(out, () => makeCell({ code: 0x4e2d, width: 2 }), makeCell(), {
      cols: 1,
      atlas: fakeAtlas(),
      theme: THEME,
      selection: null,
      cursorCol: -1
    })
    expect(out.length).toBe(CELL_STRIDE)
    expect(readCell(out, 0).glyph).toBe(901)
  })
})

describe('packViewportRow — code point validation', () => {
  // Guards the rasterizer's String.fromCodePoint: a lone surrogate or an out-of-range code point
  // THROWS there, taking the whole frame down. The atlas must never see one.
  const invalid: Array<[string, number]> = [
    ['NUL', 0],
    ['a control char', 0x1f],
    ['a low surrogate boundary', 0xd800],
    ['a high surrogate boundary', 0xdfff],
    ['past the Unicode range', 0x110000],
    ['a negative code', -1],
    ['a non-integer code', 1.5],
    ['NaN', Number.NaN]
  ]
  for (const [label, code] of invalid) {
    it(`maps ${label} to the blank slot without calling the atlas`, () => {
      const { out, atlas } = pack([makeCell({ code })])
      expect(readCell(out, 0).glyph).toBe(0)
      expect(atlas.calls).toEqual([])
    })
  }

  it('a space is blank without a lookup, and the first printable code is rasterized', () => {
    const { out, atlas } = pack([makeCell({ code: 0x20 }), makeCell({ code: 0x21 })])
    expect(readCell(out, 0).glyph).toBe(0)
    expect(readCell(out, 1).glyph).toBe(901)
    expect(atlas.calls).toEqual([[0x21, false, false]])
  })
})

describe('packViewportRow — glyph code derivation from getChars()', () => {
  it('a precomposed char renders its own code point', () => {
    const { out, atlas } = pack([makeCell({ chars: 'é', code: 0x00e9 })]) // 'é', precomposed
    expect(atlas.calls).toEqual([[0x00e9, false, false]])
    expect(readCell(out, 0).glyph).toBe(901)
  })

  it('a DECOMPOSED combining sequence renders its BASE character, not the bare mark', () => {
    // xterm keeps the whole sequence in the cell string and getCode() reports its LAST code
    // point — here U+0301, the naked accent. Rendering that would drop the 'e' off the screen.
    const { out, atlas } = pack([makeCell({ chars: 'é', code: 0x0301 })])
    expect(atlas.calls).toEqual([[0x65, false, false]]) // 'e', asked for exactly once
    expect(readCell(out, 0).glyph).toBe(901)
  })

  it('an astral char (surrogate pair) resolves to its full code point, not the lead surrogate', () => {
    const { out, atlas } = pack([makeCell({ chars: '\u{1f44d}' })]) // 👍
    expect(atlas.calls).toEqual([[0x1f44d, false, false]])
    expect(readCell(out, 0).glyph).toBe(901)
  })

  it('an empty chars string falls back to getCode()', () => {
    const { out, atlas } = pack([makeCell({ chars: '', code: 0x5a })])
    expect(atlas.calls).toEqual([[0x5a, false, false]])
    expect(readCell(out, 0).glyph).toBe(901)
  })

  it('a chars string starting with a LONE SURROGATE is blank and never reaches the atlas', () => {
    // A string can carry a broken surrogate just as easily as getCode() can return one; the
    // rasterizer's String.fromCodePoint must see neither.
    const { out, atlas } = pack([makeCell({ chars: '\ud800', code: 0x41 })])
    expect(readCell(out, 0).glyph).toBe(0)
    expect(atlas.calls).toEqual([])
  })

  it('a chars string of a control char is blank and never reaches the atlas', () => {
    const { out, atlas } = pack([makeCell({ chars: '\u0007', code: 0x41 })])
    expect(readCell(out, 0).glyph).toBe(0)
    expect(atlas.calls).toEqual([])
  })
})

describe('packViewportRow — cursor and selection', () => {
  it('the cursor cell paints cursorBg/cursorFg and sets FLAG_CURSOR', () => {
    const { out } = pack([makeCell(), makeCell({ fg: ['palette', 3] })], { cursorCol: 1 })
    expect(readCell(out, 0).flags).toBe(0)
    const c = readCell(out, 1)
    expect(c.fg).toBe(THEME.cursorFg)
    expect(c.bg).toBe(THEME.cursorBg)
    expect(c.flags).toBe(FLAG_CURSOR)
  })

  it('a selection span [start, endExcl) repaints only its bg, leaving fg resolved', () => {
    const cells = [0, 1, 2, 3].map(() => makeCell({ fg: ['palette', 4] }))
    const { out } = pack(cells, { selection: [1, 3] })
    expect(readCell(out, 0).bg).toBe(THEME.bg)
    for (const col of [1, 2]) {
      const c = readCell(out, col)
      expect(c.bg).toBe(THEME.selectionBg)
      expect(c.fg).toBe(THEME.ansi[4]) // fg is untouched by selection
      expect(c.flags).toBe(FLAG_SELECTED)
    }
    expect(readCell(out, 3).bg).toBe(THEME.bg) // end is EXCLUSIVE
    expect(readCell(out, 3).flags).toBe(0)
  })

  it('cursor wins over selection on overlap; both state flags stay set', () => {
    const { out } = pack([makeCell(), makeCell(), makeCell()], { selection: [0, 3], cursorCol: 1 })
    const c = readCell(out, 1)
    expect(c.bg).toBe(THEME.cursorBg)
    expect(c.fg).toBe(THEME.cursorFg)
    expect(c.flags).toBe(FLAG_SELECTED | FLAG_CURSOR)
    expect(readCell(out, 0).bg).toBe(THEME.selectionBg)
  })

  it('a null selection and cursorCol -1 paint nothing', () => {
    const { out } = pack([makeCell()], { selection: null, cursorCol: -1 })
    expect(readCell(out, 0).flags).toBe(0)
  })

  it('paints BOTH cells of a wide glyph under a block cursor', () => {
    // The lead is at col 0 and its follower (width 0) at col 1. L13 was: only col 0 got the cursor
    // colours, so the block covered the left half of 日 and the right half stayed un-inverted.
    const lead = makeCell({ chars: '日', code: 0x65e5, width: 2, bg: ['rgb', 0x223344] })
    const follower = makeCell({ code: 0, width: 0, bg: ['rgb', 0x223344] })
    const { out } = pack([lead, follower], { cursorCol: 0, cursorShape: 'block' })
    for (const col of [0, 1]) {
      const c = readCell(out, col)
      expect(c.bg).toBe(THEME.cursorBg)
      expect(c.fg).toBe(THEME.cursorFg)
      expect(c.flags & FLAG_CURSOR).toBe(FLAG_CURSOR)
    }
    // …and the inversion reaches the right half's INK, not just its background: the follower's
    // slot is keyed on the colours it ends up with, so it is rasterized in the cursor pair too.
    expect(readCell(out, 1).glyph).not.toBe(0)
  })

  it('carries the cursor no further than the follower of the covered lead', () => {
    const lead = makeCell({ chars: '日', code: 0x65e5, width: 2 })
    const follower = makeCell({ code: 0, width: 0 })
    const after = makeCell({ code: 0x41 })
    const { out } = pack([lead, follower, after], { cursorCol: 0, cursorShape: 'block' })
    expect(readCell(out, 2).flags & FLAG_CURSOR).toBe(0)
    expect(readCell(out, 2).bg).toBe(THEME.bg)
  })

  it('does not carry a cursor into a stray width-0 cell that follows a NARROW one', () => {
    // Only a WIDE lead has a follower. A stray zero-width cell after a one-column cell under the
    // cursor is not the other half of anything, and painting it would smear the block sideways.
    const narrow = makeCell({ code: 0x41, width: 1 })
    const stray = makeCell({ code: 0x300, width: 0 })
    const { out } = pack([narrow, stray], { cursorCol: 0, cursorShape: 'block' })
    expect(readCell(out, 1).flags & FLAG_CURSOR).toBe(0)
  })

  it('a NON-block shape leaves the cell alone — the overlay pass draws those', () => {
    // Only the cell path can invert the glyph, and only a block wants to; bar/underline/outline are
    // small quads drawn AFTER the cells, so rewriting the cell here would paint the block as well.
    for (const shape of ['bar', 'underline', 'outline', 'none'] as const) {
      const { out } = pack([makeCell({ code: 0x41, fg: ['palette', 3] })], {
        cursorCol: 0,
        cursorShape: shape
      })
      const c = readCell(out, 0)
      expect(c.fg).toBe(THEME.ansi[3])
      expect(c.bg).toBe(THEME.bg)
      expect(c.flags).toBe(0)
    }
  })

  it('a non-block shape leaves a wide glyph alone too', () => {
    const lead = makeCell({ chars: '日', code: 0x65e5, width: 2, bg: ['rgb', 0x223344] })
    const follower = makeCell({ code: 0, width: 0, bg: ['rgb', 0x223344] })
    const { out } = pack([lead, follower], { cursorCol: 0, cursorShape: 'outline' })
    for (const col of [0, 1]) {
      expect(readCell(out, col).bg).toBe(packColor(0x22, 0x33, 0x44, 0xff))
      expect(readCell(out, col).flags & FLAG_CURSOR).toBe(0)
    }
  })

  it('defaults to a block when the caller names no shape', () => {
    // Every caller that predates cursor styles passes only `cursorCol`, and a block is what it got.
    const { out } = pack([makeCell({ code: 0x41 })], { cursorCol: 0 })
    expect(readCell(out, 0).bg).toBe(THEME.cursorBg)
  })
})

/** BLUR — the one thing focus changes about a packed row (limitation L3).
 *
 *  The cursor's own blurred shape is an OVERLAY and never reaches this module; what does reach it is
 *  the selection, which xterm's own renderers paint in a separate `selectionInactiveBackground`.
 *  This engine's theme lanes carry no such colour, so the honest answer is to blend the active one
 *  toward the plate: same hue, visibly quieter, and it cannot disagree with a theme that never
 *  defined an inactive colour in the first place. */
describe('packViewportRow — an unfocused terminal', () => {
  it('dims the selection toward the plate when the terminal is not focused', () => {
    const { out } = pack([makeCell({ code: 0x41 })], { selection: [0, 1], focused: false })
    // selectionBg (0x30,0x50,0x80) blended half-way to the theme background (0x10,0x11,0x12).
    expect(readCell(out, 0).bg).toBe(packColor(0x20, 0x31, 0x49, 0xff))
    // Still a selection as far as the flags are concerned — only the paint is quieter.
    expect(readCell(out, 0).flags).toBe(FLAG_SELECTED)
  })

  it('asks the atlas for a slot painted on the DIMMED selection background', () => {
    // The atlas is colour-keyed, so a slot requested in the active colour renders in the active
    // colour however correct the lanes are — the same trap the selection/cursor ordering exists for.
    const { atlas } = pack([makeCell({ code: 0x41 })], { selection: [0, 1], focused: false })
    expect(atlas.colors).toEqual([[THEME.fg, packColor(0x20, 0x31, 0x49, 0xff)]])
  })

  it('leaves everything OUTSIDE the selection exactly as it was', () => {
    const cells = [makeCell({ code: 0x41, bg: ['palette', 7] }), makeCell({ code: 0x42 })]
    const { out } = pack(cells, { selection: [1, 2], focused: false })
    expect(readCell(out, 0).bg).toBe(THEME.ansi[7])
  })

  it('keeps the ACTIVE selection colour when the caller says nothing about focus', () => {
    // Every caller that predates this passes no flag, and a focused terminal is what it meant.
    const { out } = pack([makeCell({ code: 0x41 })], { selection: [0, 1] })
    expect(readCell(out, 0).bg).toBe(THEME.selectionBg)
  })

  it('still lets a block cursor win over the dimmed selection', () => {
    // A blurred terminal whose inactive style IS a block (a user setting) must not lose its cursor
    // to the selection band under it — the precedence is a property of the overrides, not of focus.
    const { out } = pack([makeCell({ code: 0x41 })], {
      selection: [0, 1],
      cursorCol: 0,
      cursorShape: 'block',
      focused: false
    })
    expect(readCell(out, 0).bg).toBe(THEME.cursorBg)
  })
})

/** DECORATIONS — a search hit's highlight, and the precedence that makes it readable.
 *
 *  The order the feed resolves in is base (default/palette/RGB) → inverse → dim → DECORATION →
 *  selection → cursor. Both ends of that are load-bearing: a decoration must beat the cell's own
 *  colours (otherwise a hit on coloured output is invisible), and selection/cursor must beat the
 *  decoration (a hit inside a drag-selection that punched a hole in the selection band, or a
 *  cursor that vanished when it landed on a match, both read as a broken terminal rather than as a
 *  highlight). */
describe('packViewportRow — decorations', () => {
  const DECO_BG = packColor(0xff, 0xc8, 0x00, 0xff)
  const DECO_FG = packColor(0x00, 0x00, 0x00, 0xff)

  it('paints the background a decoration asks for', () => {
    const { out } = pack([makeCell({ code: 0x41 })], {
      decorations: decoReader([{ col: 0, bg: DECO_BG }])
    })
    expect(readCell(out, 0).bg).toBe(DECO_BG)
  })

  it('paints the foreground a decoration asks for, leaving the bg resolved', () => {
    const { out } = pack([makeCell({ code: 0x41, bg: ['palette', 5] })], {
      decorations: decoReader([{ col: 0, fg: DECO_FG }])
    })
    const c = readCell(out, 0)
    expect(c.fg).toBe(DECO_FG)
    expect(c.bg).toBe(THEME.ansi[5])
  })

  it('decorates only the covered columns', () => {
    const { out } = pack([makeCell({ code: 0x41 }), makeCell({ code: 0x42 })], {
      decorations: decoReader([{ col: 1, bg: DECO_BG }])
    })
    expect(readCell(out, 0).bg).toBe(THEME.bg)
    expect(readCell(out, 1).bg).toBe(DECO_BG)
  })

  it('wins over the cell’s OWN colours, including inverse and dim', () => {
    const { out } = pack([makeCell({ code: 0x41, fg: ['palette', 2], inverse: true, dim: true })], {
      decorations: decoReader([{ col: 0, bg: DECO_BG, fg: DECO_FG }])
    })
    const c = readCell(out, 0)
    expect(c.bg).toBe(DECO_BG)
    expect(c.fg).toBe(DECO_FG)
  })

  it('loses to the SELECTION — a hit inside a drag must not punch a hole in the band', () => {
    const { out } = pack([makeCell({ code: 0x41 })], {
      decorations: decoReader([{ col: 0, bg: DECO_BG }]),
      selection: [0, 1]
    })
    expect(readCell(out, 0).bg).toBe(THEME.selectionBg)
  })

  it('loses to the CURSOR — both colours, so the cursor never disappears onto a match', () => {
    const { out } = pack([makeCell({ code: 0x41 })], {
      decorations: decoReader([{ col: 0, bg: DECO_BG, fg: DECO_FG }]),
      cursorCol: 0
    })
    const c = readCell(out, 0)
    expect(c.bg).toBe(THEME.cursorBg)
    expect(c.fg).toBe(THEME.cursorFg)
  })

  it('is keyed by the ABSOLUTE buffer row, not the viewport row', () => {
    // Decoration markers are keyed by absolute buffer line: pack viewport row 0 of a scrolled
    // buffer and the lookup must ask for row 100, or every highlight lands on the wrong line the
    // moment the user scrolls.
    const deco = decoReader([{ col: 0, row: 100, bg: DECO_BG }])
    const { out } = pack([makeCell({ code: 0x41 })], { decorations: deco, bufferRow: 100 })
    expect(readCell(out, 0).bg).toBe(DECO_BG)
    const miss = pack([makeCell({ code: 0x41 })], { decorations: deco, bufferRow: 7 })
    expect(readCell(miss.out, 0).bg).toBe(THEME.bg)
  })

  it('asks the atlas for a slot painted in the DECORATED colours', () => {
    // The Phase 1c contract: the atlas is colour-keyed and the request happens after every
    // override, so a highlighted cell's glyph is rasterized onto the highlight.
    const { atlas } = pack([makeCell({ code: 0x41 })], {
      decorations: decoReader([{ col: 0, bg: DECO_BG, fg: DECO_FG }])
    })
    expect(atlas.colors).toEqual([[DECO_FG, DECO_BG]])
  })

  it('skips the per-cell walk entirely when nothing is decorated', () => {
    // The common case: no ⌘F anywhere on the canvas. A call per cell per row per frame into
    // xterm's decoration service is a real cost, and `empty()` is what buys it back.
    const deco = decoReader([])
    pack([makeCell(), makeCell(), makeCell()], { decorations: deco })
    expect(deco.walks).toBe(0)
  })

  it('paints nothing when no reader is supplied at all', () => {
    const { out } = pack([makeCell({ code: 0x41 })])
    expect(readCell(out, 0).bg).toBe(THEME.bg)
  })
})

/** THE COLOURS THE ATLAS IS ASKED FOR — the whole point of a colour-keyed atlas.
 *
 *  The rasterizer bakes the requested fg/bg into the slot's pixels and the shader blits them
 *  unmodified, so the request must carry the cell's FINAL colours: everything the resolution
 *  pipeline produces (default/palette/RGB → inverse → dim) AND the selection/cursor overrides that
 *  are applied last. Asking with the pre-override pair paints a selected cell in its unselected
 *  colours — a defect the packed lanes cannot show, since those are correct either way. */
describe('packViewportRow — the colours the atlas is asked for', () => {
  it('a plain cell asks for the colours it resolved to', () => {
    const { atlas } = pack([makeCell({ code: 0x41 })])
    expect(atlas.colors).toEqual([[THEME.fg, THEME.bg]])
  })

  it('palette and RGB colours reach the atlas resolved, never as indices', () => {
    const { atlas } = pack([
      makeCell({ code: 0x41, fg: ['palette', 2], bg: ['palette', 250] }),
      makeCell({ code: 0x42, fg: ['rgb', 0xaabbcc], bg: ['rgb', 0x123456] })
    ])
    expect(atlas.colors).toEqual([
      [THEME.ansi[2], THEME.ansi[250]],
      [packColor(0xaa, 0xbb, 0xcc, 0xff), packColor(0x12, 0x34, 0x56, 0xff)]
    ])
  })

  it('inverse and dim are baked into the request, in that order', () => {
    const { atlas } = pack([makeCell({ code: 0x41, fg: ['palette', 2], inverse: true, dim: true })])
    // inverse swapped the resolved pair, dim halved the foreground that swap left in place.
    expect(atlas.colors).toEqual([[halve(THEME.bg), THEME.ansi[2]]])
  })

  it('a SELECTED cell asks for a slot painted on the selection background', () => {
    const { out, atlas } = pack([makeCell({ code: 0x41, fg: ['palette', 4] })], { selection: [0, 1] })
    expect(atlas.colors).toEqual([[THEME.ansi[4], THEME.selectionBg]])
    // …and the lanes still say the same thing, so the slot and the cell can never disagree.
    const c = readCell(out, 0)
    expect([c.fg, c.bg]).toEqual([THEME.ansi[4], THEME.selectionBg])
  })

  it('a CURSOR cell asks for a slot painted in the cursor pair', () => {
    const { atlas } = pack([makeCell({ code: 0x41, fg: ['palette', 4] })], { cursorCol: 0 })
    expect(atlas.colors).toEqual([[THEME.cursorFg, THEME.cursorBg]])
  })

  it('cursor over selection asks for the CURSOR pair — the same winner the lanes record', () => {
    const { out, atlas } = pack([makeCell({ code: 0x41 })], { selection: [0, 1], cursorCol: 0 })
    expect(atlas.colors).toEqual([[THEME.cursorFg, THEME.cursorBg]])
    const c = readCell(out, 0)
    expect([c.fg, c.bg]).toEqual([THEME.cursorFg, THEME.cursorBg])
  })

  it('only the covered columns of a selection ask for selection-coloured slots', () => {
    const cells = [0, 1, 2].map((i) => makeCell({ code: 0x41 + i }))
    const { atlas } = pack(cells, { selection: [1, 2] })
    expect(atlas.colors).toEqual([
      [THEME.fg, THEME.bg],
      [THEME.fg, THEME.selectionBg],
      [THEME.fg, THEME.bg]
    ])
  })

  it('BOTH halves of a wide glyph under the cursor ask for the cursor pair', () => {
    const wide = makeCell({ code: 0x4e2d, width: 2, bg: ['rgb', 0x223344] })
    const cont = makeCell({ code: 0, width: 0, bg: ['rgb', 0x223344] })
    const { out, atlas } = pack([wide, cont], { cursorCol: 0 })
    // The block covers the whole character (L13), and now that the follower owns a real slot the
    // override has to reach the request as well as the lane — a right half rasterized in the
    // cell's ORIGINAL colours would sit un-inverted inside an inverted block.
    expect(atlas.colors).toEqual([
      [THEME.cursorFg, THEME.cursorBg],
      [THEME.cursorFg, THEME.cursorBg]
    ])
    expect(atlas.parts).toEqual(['wide-left', 'wide-right'])
    expect(readCell(out, 1).bg).toBe(THEME.cursorBg)
  })
})

describe('packViewportRow — missing cells and buffer reuse', () => {
  it('a column past the end of the line becomes a blank cell on the theme background', () => {
    const { out } = pack([makeCell(), undefined], { cols: 2 })
    expect(readCell(out, 1)).toEqual({ glyph: 0, fg: THEME.fg, bg: THEME.bg, flags: 0 })
  })

  it('the cursor still paints on a column past the end of the line', () => {
    // The most common cursor position of all: one past the last typed character.
    const { out } = pack([makeCell(), undefined], { cols: 2, cursorCol: 1 })
    const c = readCell(out, 1)
    expect(c.bg).toBe(THEME.cursorBg)
    expect(c.flags).toBe(FLAG_CURSOR)
  })

  it('every column of a reused row buffer is overwritten — no stale lanes survive', () => {
    const out = new Uint32Array(3 * CELL_STRIDE)
    out.fill(0xdeadbeef)
    packViewportRow(out, (col) => (col === 1 ? undefined : makeCell({ code: 0x20 })), makeCell(), {
      cols: 3,
      atlas: fakeAtlas(),
      theme: THEME,
      selection: null,
      cursorCol: -1
    })
    for (let col = 0; col < 3; col++) {
      expect(readCell(out, col)).toEqual({ glyph: 0, fg: THEME.fg, bg: THEME.bg, flags: 0 })
    }
  })

  it('hands the caller-owned work cell to readCell so the shell can fill it in place', () => {
    const work = makeCell({ code: 0x5a })
    const seen: Array<CellView | undefined> = []
    const out = new Uint32Array(2 * CELL_STRIDE)
    packViewportRow(
      out,
      (_col, into) => {
        seen.push(into)
        return into
      },
      work,
      { cols: 2, atlas: fakeAtlas(), theme: THEME, selection: null, cursorCol: -1 }
    )
    expect(seen).toEqual([work, work])
    expect(readCell(out, 0).glyph).toBe(901)
  })
})

describe('the blank-cell probe', () => {
  it('names the cell, what it holds and the width that produced the blank', () => {
    const reports: BlankCellReport[] = []
    setBlankCellProbe((r) => reports.push(r))
    try {
      // A cell that HOLDS a letter and still reports width 0 — the shape of the 2026-08-05 report,
      // where a letter went missing mid-word. The probe must name the width, because that is the
      // one fact that says whether the loss is ours or the buffer's.
      const orphan = makeCell({ chars: 'L', code: 0x4c, width: 0 })
      pack([orphan], { bufferRow: 7 })
      expect(reports).toEqual([{ col: 0, row: 7, width: 0, code: 0, chars: 'L' }])
    } finally {
      setBlankCellProbe(null)
    }
  })

  it('stays silent for a space and for a cell that did get a glyph', () => {
    const reports: BlankCellReport[] = []
    setBlankCellProbe((r) => reports.push(r))
    try {
      // A space packs to no glyph and that is CORRECT, not a loss — reporting it would bury the
      // real finding under one line per blank column on the canvas.
      pack([makeCell({ chars: ' ', code: 0x20 }), makeCell({ chars: 'A', code: 0x41 })])
      expect(reports).toEqual([])
    } finally {
      setBlankCellProbe(null)
    }
  })
})

/**
 * The 2026-08-05 report was a hovered link with no underline. Its range reaches the feed the same
 * way a selection does — a column span on this row — and sets the SAME flag a cell's own SGR 4
 * attribute sets, so the two sources can never disagree about how an underline looks.
 */
describe('packViewportRow — the hovered link underline', () => {
  it('underlines exactly the columns in the span', () => {
    const cells = [makeCell({ code: 0x61 }), makeCell({ code: 0x62 }), makeCell({ code: 0x63 })]
    const { out } = pack(cells, { linkUnderline: [1, 3] })
    expect(readCell(out, 0).flags & FLAG_UNDERLINE).toBe(0)
    expect(readCell(out, 1).flags & FLAG_UNDERLINE).toBe(FLAG_UNDERLINE)
    expect(readCell(out, 2).flags & FLAG_UNDERLINE).toBe(FLAG_UNDERLINE)
  })

  it('asks the atlas for the UNDERLINED variant, not just the flag', () => {
    // The flag alone changes nothing on screen: the underline is baked into the slot, so a lane
    // that carries the flag while the slot was rasterized without one renders bare.
    const { atlas } = pack([makeCell({ code: 0x61 })], { linkUnderline: [0, 1] })
    expect(atlas.underlines).toEqual([true])
  })

  it('underlines a SPACE inside the span — a rule must not dash at word gaps', () => {
    // A blank normally short-circuits to the blank slot; an underline is the one thing that makes
    // it carry ink. A URL with a space, or any `\e[4m` run, breaks visibly without this.
    const { out, atlas } = pack([makeCell({ code: 0x20 })], { linkUnderline: [0, 1] })
    expect(readCell(out, 0).glyph).not.toBe(0)
    expect(atlas.underlines).toEqual([true])
  })

  it('never turns an existing underline OFF', () => {
    // Hovering a link over text that is already underlined must add, not replace.
    const { out } = pack([makeCell({ code: 0x61, underline: true })], { linkUnderline: null })
    expect(readCell(out, 0).flags & FLAG_UNDERLINE).toBe(FLAG_UNDERLINE)
  })
})
