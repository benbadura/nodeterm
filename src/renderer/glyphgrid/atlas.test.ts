import { describe, expect, it } from 'vitest'
import {
  GUTTER_PX,
  GlyphAtlas,
  type GlyphPart,
  type GlyphRasterizer,
  type GlyphSlotAllocation
} from './atlas'

/** Colors reach the atlas as opaque packed lanes — it never decodes them, so small distinct
 *  numbers keep the recorded call strings readable. */
const FG = 11
const BG = 22

function fakeRasterizer(
  cellW = 10,
  cellH = 20
): GlyphRasterizer & { calls: string[]; parts: GlyphPart[] } {
  const calls: string[] = []
  // Which PART of its character each draw was for, at the same index as `calls` (the CLEAR entries
  // aside). Its own array so the recorded call STRING — read verbatim by a dozen layout assertions
  // below — keeps its shape.
  const parts: GlyphPart[] = []
  return {
    cellW,
    cellH,
    calls,
    parts,
    source: null,
    draw(code, bold, italic, x, y, fg, bg, part = 'whole') {
      calls.push(`${code}|${bold ? 'b' : ''}${italic ? 'i' : ''}|${fg}|${bg}@${x},${y}`)
      parts.push(part)
    },
    // Logged into the SAME array as the draws, so "the page was blanked BEFORE the triggering
    // glyph was drawn into it" is one ordering assertion rather than two independent counters.
    clearPage() {
      calls.push('CLEAR')
    }
  }
}

/** The layout the tests below are written against, restated independently of the atlas so a change
 *  to `strideX`/`cellXY` has to be re-argued here rather than silently re-derived from itself. */
const pitch = (cell: number): number => Math.max(1, Math.ceil(cell)) + 2 * GUTTER_PX

describe('GlyphAtlas', () => {
  it('slot 0 is blank and never rasterized; first real glyph gets slot 1', () => {
    const r = fakeRasterizer()
    const atlas = new GlyphAtlas(r, 100)
    expect(atlas.glyphFor(0x20, false, false, FG, BG)).toBe(0) // space = blank slot, no draw
    expect(r.calls).toEqual([])
    expect(atlas.glyphFor(0x41, false, false, FG, BG)).toBe(1) // 'A'
    expect(r.calls).toHaveLength(1)
  })

  it('a struck glyph is its own slot, and a struck space is drawn rather than left blank', () => {
    const r = fakeRasterizer()
    const atlas = new GlyphAtlas(r, 100)

    const plain = atlas.glyphFor(0x41, false, false, FG, BG)
    const struck = atlas.glyphFor(0x41, false, false, FG, BG, 'whole', false, true)
    const underlined = atlas.glyphFor(0x41, false, false, FG, BG, 'whole', true, false)
    const struckSpace = atlas.glyphFor(0x20, false, false, FG, BG, 'whole', false, true)

    expect(new Set([plain, struck, underlined]).size).toBe(3)
    expect(struckSpace).not.toBe(0)
    expect(r.calls).toHaveLength(4)
  })

  it('same key is cached (one rasterization, stable slot); styles are distinct keys', () => {
    const r = fakeRasterizer()
    const atlas = new GlyphAtlas(r, 100)
    const a = atlas.glyphFor(0x41, false, false, FG, BG)
    expect(atlas.glyphFor(0x41, false, false, FG, BG)).toBe(a)
    expect(atlas.glyphFor(0x41, true, false, FG, BG)).not.toBe(a)
    expect(r.calls).toHaveLength(2)
  })

  // The whole point of Phase 1c: the atlas holds CoreText's COLORED output, so the colors are part
  // of the key. A monochrome atlas keyed `code|style` would hand the second cell below the first
  // cell's pixels — red text painted in the theme's grey.
  describe('color keys (the atlas stores real pixels, not coverage)', () => {
    it('the same glyph in a different foreground is a different slot', () => {
      const r = fakeRasterizer()
      const atlas = new GlyphAtlas(r, 100)
      const a = atlas.glyphFor(0x41, false, false, FG, BG)
      const b = atlas.glyphFor(0x41, false, false, FG + 1, BG)
      expect(b).not.toBe(a)
      expect(r.calls).toEqual([`65||${FG}|${BG}@16,2`, `65||${FG + 1}|${BG}@30,2`])
    })

    it('the same glyph on a different background is a different slot', () => {
      const atlas = new GlyphAtlas(fakeRasterizer(), 100)
      const a = atlas.glyphFor(0x41, false, false, FG, BG)
      expect(atlas.glyphFor(0x41, false, false, FG, BG + 1)).not.toBe(a)
    })

    it('every lane of the key participates — no two of the six collide', () => {
      const atlas = new GlyphAtlas(fakeRasterizer(), 100)
      const slots = [
        atlas.glyphFor(0x41, false, false, FG, BG),
        atlas.glyphFor(0x42, false, false, FG, BG), // code
        atlas.glyphFor(0x41, true, false, FG, BG), // bold
        atlas.glyphFor(0x41, false, true, FG, BG), // italic
        atlas.glyphFor(0x41, false, false, FG + 1, BG), // fg
        atlas.glyphFor(0x41, false, false, FG, BG + 1), // bg
        atlas.glyphFor(0x41, false, false, FG, BG, 'wide-right') // half
      ]
      expect(new Set(slots).size).toBe(slots.length)
    })

    describe('the two halves of a double-width character', () => {
      // A slot's ink box is exactly one cell and raster.ts cuts the overflow, so an emoji or a CJK
      // ideograph — which the terminal has already given TWO cells — lost its right half entirely.
      // It gets a second slot instead: same character, same style, same colours, other half.
      it('are separate slots, and the second is drawn shifted one cell left', () => {
        const r = fakeRasterizer()
        const atlas = new GlyphAtlas(r, 100)
        const left = atlas.glyphFor(0x4e2d, false, false, FG, BG, 'wide-left')
        const right = atlas.glyphFor(0x4e2d, false, false, FG, BG, 'wide-right')
        expect(right).not.toBe(left)
        // The atlas does NOT shift anything itself — it hands the rasterizer this slot's own ink
        // origin and the part, and the shift is raster.ts's (see its `inkX`). Pinned here because
        // a part that never reached the rasterizer would key two slots and paint them identically.
        expect(r.parts).toEqual(['wide-left', 'wide-right'])
      })

      it('cache independently — asking for one never returns the other', () => {
        const atlas = new GlyphAtlas(fakeRasterizer(), 100)
        const left = atlas.glyphFor(0x4e2d, false, false, FG, BG, 'wide-left')
        const right = atlas.glyphFor(0x4e2d, false, false, FG, BG, 'wide-right')
        expect(atlas.glyphFor(0x4e2d, false, false, FG, BG, 'wide-left')).toBe(left)
        expect(atlas.glyphFor(0x4e2d, false, false, FG, BG, 'wide-right')).toBe(right)
      })

      it("default to 'whole', so every existing caller is unchanged", () => {
        const atlas = new GlyphAtlas(fakeRasterizer(), 100)
        const implicit = atlas.glyphFor(0x41, false, false, FG, BG)
        expect(atlas.glyphFor(0x41, false, false, FG, BG, 'whole')).toBe(implicit)
      })

      it("'wide-left' is NOT 'whole', even though both draw from the character's left edge", () => {
        // They differ in ENTITLEMENT, which is what raster.ts's shrink measures against: a 'whole'
        // glyph may spread over one cell, a 'wide-left' one over two. Sharing a slot would shrink
        // an emoji's left half to fit a single cell — the fragment this all exists to prevent.
        const atlas = new GlyphAtlas(fakeRasterizer(), 100)
        const whole = atlas.glyphFor(0x4e2d, false, false, FG, BG, 'whole')
        expect(atlas.glyphFor(0x4e2d, false, false, FG, BG, 'wide-left')).not.toBe(whole)
      })
    })

    // packColor's own `>>> 0` note applies one layer up: `0xff << 24` is NEGATIVE in JS, so the
    // same colour reaches this file as -16777216 from an arithmetic path and as 4278190080 from a
    // `readCell` lane. Two spellings of one colour would mean two slots holding identical pixels —
    // wasted page, and resets arriving twice as fast.
    it('keys a colour by its VALUE, so a signed lane is not a second slot', () => {
      const r = fakeRasterizer()
      const atlas = new GlyphAtlas(r, 100)
      const signed = 0xff << 24 // -16777216
      const unsigned = 0xff000000 // 4278190080 — the same colour
      const a = atlas.glyphFor(0x41, false, false, signed, signed)
      expect(atlas.glyphFor(0x41, false, false, unsigned, unsigned)).toBe(a)
      expect(r.calls).toHaveLength(1)
    })

    it('the colors ride into the rasterizer untouched (it, not the shader, paints them)', () => {
      const r = fakeRasterizer()
      const atlas = new GlyphAtlas(r, 100)
      atlas.glyphFor(0x41, false, false, 0xff112233, 0xff445566)
      expect(r.calls).toEqual([`65||${0xff112233}|${0xff445566}@16,2`])
    })
  })

  it('lays slots out row-major within the page and reports correct uv rects', () => {
    const r = fakeRasterizer(10, 20) // pitch 14 × 24 → 7 cols × 4 rows in a 100px page
    const atlas = new GlyphAtlas(r, 100)
    for (let i = 0; i < 9; i++) atlas.glyphFor(0x30 + i, false, false, FG, BG) // '0'..'8'
    // The i-th glyph lands in slot i+1 (slot 0 is blank), so calls[5] is slot 6 — the last cell of
    // row 0 — and calls[6] is slot 7, the first of row 1. Every origin is the INK origin: the pitch
    // cell's corner plus the gutter on both axes.
    expect(r.calls[5]).toBe(`${0x35}||${FG}|${BG}@86,2`) // slot 6: (6*14)+2, 0+2
    expect(r.calls[6]).toBe(`${0x36}||${FG}|${BG}@2,26`) // slot 7: row 1 → 0+2, 24+2
    expect(r.calls[7]).toBe(`${0x37}||${FG}|${BG}@16,26`)
    expect(atlas.slotRect(1)).toEqual({ u0: 16 / 100, v0: 2 / 100, u1: 26 / 100, v1: 22 / 100 })
  })

  it('slotRect is correct past row 0', () => {
    const atlas = new GlyphAtlas(fakeRasterizer(10, 20), 100) // 7 cols × 4 rows
    expect(atlas.slotRect(7)).toEqual({ u0: 2 / 100, v0: 26 / 100, u1: 12 / 100, v1: 46 / 100 })
  })

  // What this pins, exactly: `slotRect` against a HAND-TRANSCRIBED copy of the uv derivation
  // gl-webgl2's vertex shader must perform — cols = floor(sizePx/strideX), cellUv =
  // [cellW/sizePx, cellH/sizePx], strideUv = [strideX/sizePx, strideY/sizePx], gutterUv =
  // GUTTER_PX/sizePx, slotOrigin = (slot % cols, floor(slot / cols)) * strideUv + gutterUv. So it
  // catches a change to the CPU side (atlas gutter, page metrics, slot ordering) — and nothing else.
  //
  // Every number on the shader side is computed HERE, from the cell the rasterizer was built with
  // — never read back off the atlas. Deriving `cols` from `atlas.strideX` would make the test
  // agree with whatever the atlas decided, including conflating the pitch with the extent.
  //
  // It is NOT a tie to the live GLSL: the shader side below is this test's own copy, so editing
  // the real shader leaves this green. The live VERT performs the same derivation (`uAtlasStride`
  // for the pitch, `uAtlasGutter` for the origin offset, `uAtlasCell` for the extent) — nothing
  // headless can prove that, which is why this test transcribes the arithmetic independently and
  // the device round checks the pixels.
  //
  // Run over an integer cell AND a fractional one: an integer cell has stride === extent + 2*gutter
  // on both axes, so it alone cannot tell a pitch/extent conflation from a correct derivation.
  it.each([
    { label: 'integer cell (extent is a whole texel)', cellW: 10, cellH: 20, sizePx: 100 },
    { label: 'fractional device cell (13px font at dpr 2)', cellW: 15.66, cellH: 31.2, sizePx: 512 }
  ])('slotRect agrees with the shader uv derivation for every interesting slot — $label', ({
    cellW,
    cellH,
    sizePx
  }) => {
    const atlas = new GlyphAtlas(fakeRasterizer(cellW, cellH), sizePx)
    const strideX = Math.ceil(cellW) + 2 * GUTTER_PX
    const strideY = Math.ceil(cellH) + 2 * GUTTER_PX
    const cols = Math.floor(sizePx / strideX)
    const rows = Math.floor(sizePx / strideY)
    const cellUv = [cellW / sizePx, cellH / sizePx]
    const strideUv = [strideX / sizePx, strideY / sizePx]
    const gutterUv = GUTTER_PX / sizePx
    for (const slot of [0, 1, cols - 1, cols, cols + 1, cols * rows - 1]) {
      const u0 = (slot % cols) * strideUv[0] + gutterUv
      const v0 = Math.floor(slot / cols) * strideUv[1] + gutterUv
      const got = atlas.slotRect(slot)
      // Compared to 12 decimals rather than exactly: the two sides are algebraically identical but
      // ASSOCIATE differently — the atlas divides `(inkX + cellW)` by the page once, the shader
      // adds `cellW/sizePx` to an already-divided origin — so they can disagree in the last double
      // ulp (~1e-17 here). 1e-12 of a unit uv is ~1e-9 of a texel; nothing samples differently for
      // it, and the GPU truncates all of it to fp32 anyway. A conflated pitch/extent, the defect
      // this test exists for, is off by a whole texel or more.
      expect(got.u0).toBeCloseTo(u0, 12)
      expect(got.v0).toBeCloseTo(v0, 12)
      expect(got.u1).toBeCloseTo(u0 + cellUv[0], 12)
      expect(got.v1).toBeCloseTo(v0 + cellUv[1], 12)
    }
  })

  // The defect this split exists for: the atlas used to be built from its OWN `measureText`
  // metrics, rounded up to whole texels, while the grid draws each cell at xterm's exact device
  // cell — so every glyph was stretched over a quad a couple of percent smaller than its bitmap
  // and resampled ("rougher than the DOM renderer"). Now the sampled EXTENT is the exact
  // (fractional) cell and only the slot PITCH rounds — and the pitch additionally carries the
  // gutter the mip chain needs.
  describe('fractional device cells (xterm reports charWidth * dpr, which is not an integer)', () => {
    it('keeps the sampled extent exact and rounds only the slot pitch', () => {
      const atlas = new GlyphAtlas(fakeRasterizer(15.66, 31), 2048)
      expect(atlas.cellW).toBe(15.66) // extent: unrounded, so texel:pixel is 1:1 at zoom 1
      expect(atlas.strideX).toBe(16 + 2 * GUTTER_PX) // pitch: whole texels + both gutters
      expect(atlas.cellH).toBe(31)
      expect(atlas.strideY).toBe(31 + 2 * GUTTER_PX)
      const rect = atlas.slotRect(1)
      expect(rect.u1 - rect.u0).toBeCloseTo(15.66 / 2048, 12)
      expect(rect.u0).toBeCloseTo((20 + GUTTER_PX) / 2048, 12) // …starting on a texel boundary
    })

    it('lays slots out on the pitch, so no two glyphs share a boundary texel', () => {
      const r = fakeRasterizer(15.66, 31)
      const atlas = new GlyphAtlas(r, 2048)
      atlas.glyphFor(0x41, false, false, FG, BG) // slot 1
      atlas.glyphFor(0x42, false, false, FG, BG) // slot 2
      expect(r.calls[0]).toBe(`${0x41}||${FG}|${BG}@22,2`) // 1*20 + gutter
      expect(r.calls[1]).toBe(`${0x42}||${FG}|${BG}@42,2`) // 2*20 + gutter
    })

    it('counts capacity in whole pitches — the gutters are not usable area', () => {
      // pitch 20 × 35 → floor(100/20) = 5 cols, floor(100/35) = 2 rows.
      expect(new GlyphAtlas(fakeRasterizer(15.66, 31), 100).capacity).toBe(10)
    })

    it('a sub-texel cell still yields a finite pitch rather than an infinite capacity', () => {
      const atlas = new GlyphAtlas(fakeRasterizer(0.4, 0.4), 100)
      expect(atlas.strideX).toBe(1 + 2 * GUTTER_PX)
      expect(atlas.capacity).toBe(400) // floor(100/5)^2
    })
  })

  // The gutter is what makes the mip chain usable: a level-n texel averages a 2^n-wide block of
  // level-0 texels, so ink that sits flush against a slot boundary is averaged into the NEIGHBOUR's
  // minified texels. These tests pin the arithmetic that keeps every slot's ink 2*GUTTER_PX away
  // from every other slot's ink.
  describe('mip gutters', () => {
    it('exports the gutter the rasterizer and the shader both have to agree with', () => {
      expect(GUTTER_PX).toBe(2)
    })

    it('the pitch is the rounded-up cell plus a gutter on BOTH sides of each axis', () => {
      for (const [cellW, cellH] of [
        [10, 20],
        [15.66, 31.2],
        [0.4, 0.4]
      ]) {
        const atlas = new GlyphAtlas(fakeRasterizer(cellW, cellH), 2048)
        expect(atlas.strideX).toBe(pitch(cellW))
        expect(atlas.strideY).toBe(pitch(cellH))
      }
    })

    it('the ink origin sits one gutter inside its pitch cell, on both axes', () => {
      const r = fakeRasterizer(10, 20)
      const atlas = new GlyphAtlas(r, 100) // 7 cols
      for (let i = 0; i < 8; i++) atlas.glyphFor(0x41 + i, false, false, FG, BG)
      for (let slot = 1; slot <= 8; slot++) {
        const col = slot % 7
        const row = Math.floor(slot / 7)
        expect(r.calls[slot - 1]).toContain(
          `@${col * pitch(10) + GUTTER_PX},${row * pitch(20) + GUTTER_PX}`
        )
      }
    })

    it('the uv rect follows the ink, not the pitch cell', () => {
      const atlas = new GlyphAtlas(fakeRasterizer(10, 20), 100)
      const rect = atlas.slotRect(1)
      expect(rect.u0 * 100).toBeCloseTo(pitch(10) + GUTTER_PX, 9)
      expect(rect.v0 * 100).toBeCloseTo(GUTTER_PX, 9)
      // The extent is still exactly the cell — the gutter moved the origin, it did not grow the
      // sampled area (which would sample the neighbour's backdrop into every glyph at zoom 1).
      expect((rect.u1 - rect.u0) * 100).toBeCloseTo(10, 9)
      expect((rect.v1 - rect.v0) * 100).toBeCloseTo(20, 9)
    })

    // Slot 0 is isolated by the SAME rule as every other slot — it is not a special case in the
    // layout, it is simply the slot nobody ever draws into. If its mip neighbourhood could reach
    // slot 1's ink, every space on a zoomed-out canvas would grow a ghost.
    it('separates every slot pair — slot 0 included — by two full gutters of ink-free page', () => {
      for (const [cellW, cellH, sizePx] of [
        [10, 20, 100],
        [15.66, 31.2, 512]
      ]) {
        const atlas = new GlyphAtlas(fakeRasterizer(cellW, cellH), sizePx)
        const inkRect = (slot: number): { x0: number; y0: number; x1: number; y1: number } => {
          const r = atlas.slotRect(slot)
          return {
            x0: r.u0 * sizePx,
            y0: r.v0 * sizePx,
            x1: r.u1 * sizePx,
            y1: r.v1 * sizePx
          }
        }
        const cols = Math.floor(sizePx / atlas.strideX)
        for (const slot of [0, 1, 2, cols, cols + 1]) {
          for (const other of [0, 1, 2, cols, cols + 1]) {
            if (slot === other) continue
            const a = inkRect(slot)
            const b = inkRect(other)
            // Separated on at least one axis by 2*GUTTER_PX — two slots in the same row share rows
            // of texels, so the guarantee is per-axis, not a euclidean distance.
            const gapX = Math.max(b.x0 - a.x1, a.x0 - b.x1)
            const gapY = Math.max(b.y0 - a.y1, a.y0 - b.y1)
            expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(2 * GUTTER_PX - 1e-9)
          }
        }
      }
    })

    it('keeps the gutter of the LAST slot inside the page', () => {
      const sizePx = 512
      const atlas = new GlyphAtlas(fakeRasterizer(15.66, 31.2), sizePx)
      const last = atlas.capacity - 1
      const rect = atlas.slotRect(last)
      expect(rect.u1 * sizePx + GUTTER_PX).toBeLessThanOrEqual(sizePx)
      expect(rect.v1 * sizePx + GUTTER_PX).toBeLessThanOrEqual(sizePx)
    })
  })

  it('a degenerate page (sizePx < cellW) yields blank slots and a zero rect, never NaN', () => {
    const atlas = new GlyphAtlas(fakeRasterizer(10, 20), 5)
    expect(atlas.capacity).toBe(0)
    expect(atlas.glyphFor(0x41, false, false, FG, BG)).toBe(0)
    expect(atlas.slotRect(0)).toEqual({ u0: 0, v0: 0, u1: 0, v1: 0 })
  })

  it('sets dirty on new glyphs and clears on demand', () => {
    const atlas = new GlyphAtlas(fakeRasterizer(), 100)
    expect(atlas.dirty).toBe(false)
    atlas.glyphFor(0x41, false, false, FG, BG)
    expect(atlas.dirty).toBe(true)
    atlas.clearDirty()
    expect(atlas.dirty).toBe(false)
  })

  // Reset-on-full is xterm's `clearTextureAtlas` model: colored keys grow with the palette, so a
  // page WILL fill; clearing it wholesale (and having consumers repack every row) is what avoids
  // eviction's dangling-slot problem — no live lane can ever point at a slot someone else reused,
  // because after a reset no lane points anywhere until it is rewritten.
  describe('reset on a full page', () => {
    /** A page with room for exactly slot 0 + one real slot: pitch 14 × 24 → 2 cols × 1 row. */
    const fullAfterOne = (): { r: ReturnType<typeof fakeRasterizer>; atlas: GlyphAtlas } => {
      const r = fakeRasterizer(10, 20)
      return { r, atlas: new GlyphAtlas(r, 28) }
    }

    it('does not fire before the page is actually full', () => {
      const { atlas } = fullAfterOne()
      expect(atlas.capacity).toBe(2)
      expect(atlas.glyphFor(0x41, false, false, FG, BG)).toBe(1)
      expect(atlas.resetCount).toBe(0)
    })

    it('a cache hit on a full page never resets', () => {
      const { atlas } = fullAfterOne()
      atlas.glyphFor(0x41, false, false, FG, BG)
      expect(atlas.glyphFor(0x41, false, false, FG, BG)).toBe(1)
      expect(atlas.resetCount).toBe(0)
    })

    it('fires at capacity, blanks the page, and lands the triggering key in the fresh page', () => {
      const { r, atlas } = fullAfterOne()
      atlas.glyphFor(0x41, false, false, FG, BG)
      r.calls.length = 0
      expect(atlas.glyphFor(0x42, false, false, FG, BG)).toBe(1) // fresh page → slot 1 again
      expect(atlas.resetCount).toBe(1)
      // Ordering is the contract: the pixels are blanked BEFORE the triggering glyph is drawn, or
      // the clear would erase the glyph that caused it.
      expect(r.calls).toEqual(['CLEAR', `${0x42}||${FG}|${BG}@16,2`])
      expect(atlas.dirty).toBe(true)
    })

    it('forgets every key it held, so the old ones re-rasterize into the fresh page', () => {
      const { r, atlas } = fullAfterOne()
      atlas.glyphFor(0x41, false, false, FG, BG)
      atlas.glyphFor(0x42, false, false, FG, BG) // reset; 'B' now owns slot 1
      r.calls.length = 0
      expect(atlas.glyphFor(0x41, false, false, FG, BG)).toBe(1) // another reset for 'A'
      expect(atlas.resetCount).toBe(2)
      expect(r.calls).toEqual(['CLEAR', `${0x41}||${FG}|${BG}@16,2`])
    })

    it('notifies subscribers AFTER the clear and BEFORE the triggering allocation', () => {
      const { r, atlas } = fullAfterOne()
      atlas.onReset(() => r.calls.push('ONRESET'))
      atlas.glyphFor(0x41, false, false, FG, BG)
      r.calls.length = 0
      atlas.glyphFor(0x42, false, false, FG, BG)
      expect(r.calls).toEqual(['CLEAR', 'ONRESET', `${0x42}||${FG}|${BG}@16,2`])
    })

    it('subscribers see EMPTY bookkeeping — a repack started there packs the fresh page', () => {
      const { atlas } = fullAfterOne()
      let seen = -1
      atlas.onReset(() => {
        // The key that filled the old page is gone: asking for it again allocates slot 1 of the
        // fresh page rather than returning the stale slot it used to hold.
        seen = atlas.glyphFor(0x41, false, false, FG, BG)
      })
      atlas.glyphFor(0x41, false, false, FG, BG) // slot 1
      const triggering = atlas.glyphFor(0x42, false, false, FG, BG)
      expect(seen).toBe(1) // subscriber repacked 'A' into the fresh page…
      expect(triggering).toBe(0) // …which filled it again, so 'B' degrades to blank this frame
      expect(atlas.resetCount).toBe(1) // and does NOT recurse into a second reset
    })

    // REPRODUCED BY REVIEW, and it was a stack overflow, not a slow path: a subscriber's repack
    // that needs MORE keys than the fresh page holds used to re-enter reset() from inside reset()'s
    // own notification loop — clearing the page the repack was half-way through writing, and
    // recursing until the stack died (the throw then vanished into the per-subscriber try/catch,
    // leaving a half-packed page and no error anywhere).
    it('a subscriber that overflows the fresh page degrades — it never re-enters the reset', () => {
      const { r, atlas } = fullAfterOne() // capacity 2 → exactly ONE real slot
      const got: number[] = []
      atlas.onReset(() => {
        // Three allocations into a page that holds one. The first fits; the rest must degrade.
        got.push(atlas.glyphFor(0x61, false, false, FG, BG))
        got.push(atlas.glyphFor(0x62, false, false, FG, BG))
        got.push(atlas.glyphFor(0x63, false, false, FG, BG))
      })
      atlas.glyphFor(0x41, false, false, FG, BG) // fills the page
      r.calls.length = 0
      expect(() => atlas.glyphFor(0x42, false, false, FG, BG)).not.toThrow()
      expect(got).toEqual([1, 0, 0])
      expect(atlas.resetCount).toBe(1) // ONE reset, not one per over-capacity request
      // And the page holds exactly what the repack managed to write: one clear, one draw.
      expect(r.calls).toEqual(['CLEAR', `${0x61}||${FG}|${BG}@16,2`])
    })

    it('recovers on the NEXT request — the guard is scoped to the reset, not sticky', () => {
      const { atlas } = fullAfterOne()
      let overflow = true
      atlas.onReset(() => {
        if (!overflow) return
        overflow = false
        atlas.glyphFor(0x61, false, false, FG, BG) // fills the fresh page
        atlas.glyphFor(0x62, false, false, FG, BG) // degrades to blank
      })
      atlas.glyphFor(0x41, false, false, FG, BG)
      expect(atlas.glyphFor(0x42, false, false, FG, BG)).toBe(0) // repack took the only slot
      // A later request, outside any reset, still gets the normal reset-then-allocate treatment.
      expect(atlas.glyphFor(0x63, false, false, FG, BG)).toBe(1)
      expect(atlas.resetCount).toBe(2)
    })

    it('every subscriber is called, and each one can be disposed independently', () => {
      const { atlas } = fullAfterOne()
      const hits: string[] = []
      const a = atlas.onReset(() => hits.push('a'))
      atlas.onReset(() => hits.push('b'))
      atlas.glyphFor(0x41, false, false, FG, BG)
      atlas.glyphFor(0x42, false, false, FG, BG)
      expect(hits).toEqual(['a', 'b'])
      a.dispose()
      atlas.glyphFor(0x43, false, false, FG, BG)
      expect(hits).toEqual(['a', 'b', 'b'])
    })

    it('a disposed subscription is idempotent and never resurrects', () => {
      const { atlas } = fullAfterOne()
      let hits = 0
      const sub = atlas.onReset(() => hits++)
      sub.dispose()
      sub.dispose()
      atlas.glyphFor(0x41, false, false, FG, BG)
      atlas.glyphFor(0x42, false, false, FG, BG)
      expect(hits).toBe(0)
    })

    it('a throwing subscriber costs its own notification, not the frame', () => {
      const { r, atlas } = fullAfterOne()
      const hits: string[] = []
      atlas.onReset(() => {
        throw new Error('repack blew up')
      })
      atlas.onReset(() => hits.push('b'))
      atlas.glyphFor(0x41, false, false, FG, BG)
      r.calls.length = 0
      expect(() => atlas.glyphFor(0x42, false, false, FG, BG)).not.toThrow()
      expect(hits).toEqual(['b']) // the surviving subscriber still ran
      expect(r.calls).toEqual(['CLEAR', `${0x42}||${FG}|${BG}@16,2`])
    })

    // A page that cannot hold a single real glyph must DEGRADE, not thrash: resetting an empty
    // page on every request would clear + notify forever and never render anything.
    it('never resets a page too small to hold one glyph', () => {
      const r = fakeRasterizer(10, 20)
      const atlas = new GlyphAtlas(r, 24) // 1 col × 1 row = capacity 1 (slot 0 only)
      let hits = 0
      atlas.onReset(() => hits++)
      expect(atlas.capacity).toBe(1)
      expect(atlas.glyphFor(0x41, false, false, FG, BG)).toBe(0)
      expect(atlas.glyphFor(0x42, false, false, FG, BG)).toBe(0)
      expect(atlas.resetCount).toBe(0)
      expect(hits).toBe(0)
      expect(r.calls).toEqual([])
    })
  })

  describe('debug allocation tap (device instrumentation for the blank-glyph bug)', () => {
    it('reports each NEW slot with the origin the ink was drawn at, and never on a cache hit', () => {
      const seen: GlyphSlotAllocation[] = []
      const atlas = new GlyphAtlas(fakeRasterizer(10, 20), 100, (i) => seen.push(i))
      atlas.glyphFor(0x78, false, false, FG, BG)
      atlas.glyphFor(0x78, false, false, FG, BG) // cache hit — must NOT re-report
      atlas.glyphFor(0x78, true, false, FG, BG) // a different style IS a different slot
      atlas.glyphFor(0x78, false, false, FG + 1, BG) // …and so is a different colour
      atlas.glyphFor(0x20, false, false, FG, BG) // the blank slot is never an allocation
      atlas.glyphFor(0x78, false, false, FG, BG, 'wide-right') // …and so is the other half
      expect(seen).toEqual([
        { slot: 1, code: 0x78, bold: false, italic: false, x: 16, y: 2, fg: FG, bg: BG, part: 'whole' as const, underline: false, strikethrough: false },
        { slot: 2, code: 0x78, bold: true, italic: false, x: 30, y: 2, fg: FG, bg: BG, part: 'whole' as const, underline: false, strikethrough: false },
        { slot: 3, code: 0x78, bold: false, italic: false, x: 44, y: 2, fg: FG + 1, bg: BG, part: 'whole' as const, underline: false, strikethrough: false },
        { slot: 4, code: 0x78, bold: false, italic: false, x: 58, y: 2, fg: FG, bg: BG, part: 'wide-right' as const, underline: false, strikethrough: false }
      ])
    })

    it('reports a struck slot as struck', () => {
      const seen: GlyphSlotAllocation[] = []
      const atlas = new GlyphAtlas(fakeRasterizer(10, 20), 100, (i) => seen.push(i))

      atlas.glyphFor(0x78, false, false, FG, BG, 'whole', false, true)

      expect(seen.map((a) => a.strikethrough)).toEqual([true])
    })

    it('a throwing tap costs the log line, not the glyph', () => {
      const r = fakeRasterizer(10, 20)
      const atlas = new GlyphAtlas(r, 100, () => {
        throw new Error('debug tap blew up')
      })
      expect(() => atlas.glyphFor(0x78, false, false, FG, BG)).not.toThrow()
      expect(atlas.glyphFor(0x78, false, false, FG, BG)).toBe(1) // still cached and usable
      expect(r.calls).toEqual([`120||${FG}|${BG}@16,2`]) // ...and rasterized exactly once
      expect(atlas.dirty).toBe(true)
    })
  })
})
