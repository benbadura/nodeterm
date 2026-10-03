import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { Terminal } from '@xterm/xterm'
import type { WebglAddon } from '@xterm/addon-webgl'
import {
  classifyRun,
  glassPanelFill,
  installGlassCellBackgrounds,
  GLASS_CELL_REBUILD_MS,
  oklab,
  PANEL_VERDICTS_MAX,
  scheduleGlassCellAlpha,
  setGlassCellAlpha
} from './glass-cell-backgrounds'
import {
  composite,
  contrastRatio,
  GLASS_READABLE_TICK,
  glassSliderAlpha,
  glassTintAlpha,
  parseHex
} from '../lib/glassContrast'
import { resolveTerminalTheme } from './themes'

type Rgb = readonly [number, number, number]

const INVERSE = 0x4000000
const CM_P256 = 0x2000000
const CM_RGB = 0x3000000
const DIM = 0x8000000
const ITALIC = 0x4000000
const HAS_EXTENDED = 0x10000000

const grey = (v: number): Rgb => [v, v, v]
const DARK = { bg: grey(30), fg: grey(230) } // nodeterm-dark
const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]

describe('classifyRun', () => {
  const grok = CM_RGB | 0x141414
  it.each([
    ['inverse video / fake cursor', INVERSE, CM_RGB | 0x3a3a3a, CM_RGB | 0x3a3a3a, 'stock'],
    ['inverse on the default bg', INVERSE, 0, 0, 'stock'],
    ['DIM on the default bg', 0, DIM, DIM, 0],
    ['ITALIC on the default bg', 0, ITALIC, ITALIC, 0],
    ['hyperlink / underline style on the default bg', 0, HAS_EXTENDED, HAS_EXTENDED, 0],
    ['app panel (truecolor)', 0, grok, grok, 'panel'],
    ['app panel (256-colour, Claude bubble)', 0, CM_P256 | 237, CM_P256 | 237, 'panel'],
    ['dim text on an app panel', 0, grok | DIM, grok | DIM, 'panel'],
    ['selection / block cursor / search highlight (renderer override)', 0, CM_RGB | 0x264f78, grok, 'stock'],
    ['override where the buffer cell was unreadable', 0, grok, NaN, 'stock']
  ])('%s', (_name, fg, bg, cellBg, want) => {
    expect(classifyRun(fg, bg, cellBg, 0)).toBe(want)
  })

  it('an attribute-only run takes the theme background alpha, whatever it is', () => {
    expect(classifyRun(0, DIM, DIM, 1)).toBe(1)
  })
})

describe('glassPanelFill: a lift or sink of the glass, never a second slab of tint', () => {
  it("Claude's #3a3a3a bubble on #1e1e1e is a subtle white-ish lift, the same at every slider position", () => {
    for (const t of [0.2, 0.539, 0.675, 0.95]) {
      const f = glassPanelFill(grey(58), DARK, t, [WHITE])!
      expect(f.alpha).toBeGreaterThanOrEqual(0.08)
      expect(f.alpha).toBeLessThanOrEqual(0.12)
      expect(f.rgb[0]).toBeGreaterThan(30) // lighter than the tint: a lift
    }
  })

  it("Grok's full-screen #141414 is a faint black sink (≈ the theme bg)", () => {
    const f = glassPanelFill(grey(20), DARK, 0.675, [grey(200)])!
    expect(f.rgb).toEqual(BLACK)
    expect(f.alpha).toBeGreaterThanOrEqual(0.04)
    expect(f.alpha).toBeLessThanOrEqual(0.06)
  })

  it('a panel that IS the theme background draws nothing', () => {
    expect(glassPanelFill(grey(31), DARK, 0.675, [])).toEqual({ rgb: grey(31), alpha: 0 })
  })

  it('Reduce Transparency (node alpha 1) keeps the app panel opaque', () => {
    expect(glassPanelFill(grey(58), DARK, 1, [])).toBeNull()
  })

  it('a coloured status bar keeps its own hue', () => {
    const f = glassPanelFill([0, 90, 200], DARK, 0.675, [WHITE])!
    expect(f.rgb).toEqual([0, 90, 200])
    expect(f.alpha).toBe(0.22)
  })

  it('a light bar carrying dark text on a dark theme stays opaque (the panel is what makes it readable)', () => {
    for (const t of [0.2, 0.675, 0.95]) expect(glassPanelFill(grey(224), DARK, t, [BLACK])).toBeNull()
  })

  // Polarity is judged against the PANEL: #303030 is lighter than nodeterm-dark's #1e1e1e, yet it is
  // dark text on this bar. Judged by the theme, the bar went translucent at worst contrast 1.00.
  it('dark-grey text on a light bar (dark theme) keeps the bar opaque', () => {
    for (const t of [0.2, 0.675, 0.725, 0.95]) {
      for (const bar of [grey(0xd0), grey(0xe4)]) {
        for (const text of [grey(0x30), grey(0x3a)]) expect(glassPanelFill(bar, DARK, t, [text]), `t=${t}`).toBeNull()
      }
    }
  })

  it.each(['nodeterm-light', 'catppuccin-latte'])('light-grey text on a dark bar (%s) keeps the bar opaque', (id) => {
    const theme = resolveTerminalTheme(id).theme
    const light = { bg: parseHex(theme.background!)!, fg: parseHex(theme.foreground!)! }
    const readable = glassTintAlpha(theme.foreground!, theme.background!)
    for (const t of [0.2, readable, 0.95]) expect(glassPanelFill(grey(0x30), light, t, [grey(0xe4)]), `t=${t}`).toBeNull()
  })

  it('decoration under 3:1 on the opaque panel (a dim prompt chevron) does not force it opaque', () => {
    expect(glassPanelFill(grey(58), DARK, 0.675, [grey(78)])).not.toBeNull()
  })

  it('is continuous at the Readable tick', () => {
    const r = glassTintAlpha('#e6e6e6', '#1e1e1e')
    const at = glassPanelFill(grey(58), DARK, r, [])!.rgb[0]
    const below = glassPanelFill(grey(58), DARK, r - 1e-4, [])!.rgb[0]
    expect(Math.abs(at - below)).toBeLessThan(0.5) // no jump: the step shrinks with the slider step
  })
})

/**
 * The guarantee: at or right of the Readable tick, the theme foreground on a lifted/sunk panel
 * keeps 4.5:1 over ANY backdrop — the same promise as the plain glass. Swept over grey panels on
 * both default themes, backdrops 0..255 plus saturated corners.
 */
describe('theme text on a panel keeps the Readable guarantee', () => {
  const backdrops: Rgb[] = [
    ...Array.from({ length: 52 }, (_, i) => grey(i * 5)),
    [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]
  ]
  it.each(['nodeterm-dark', 'nodeterm-light'])('%s', (id) => {
    const theme = resolveTerminalTheme(id).theme
    const bg = parseHex(theme.background!)!
    const fg = parseHex(theme.foreground!)!
    const readable = glassTintAlpha(theme.foreground!, theme.background!)
    for (const t of [readable, glassSliderAlpha((GLASS_READABLE_TICK + 1) / 2, readable), glassSliderAlpha(1, readable)]) {
      for (let v = 0; v <= 255; v += 5) {
        const f = glassPanelFill(grey(v), { bg, fg }, t, [fg])
        if (!f) continue // opaque: the app's own panel
        for (const x of backdrops) {
          const shown = composite(f.rgb, composite(bg, x, t), f.alpha)
          expect(contrastRatio(fg, shown), `${id} t=${t} panel=${v} backdrop=${x}`).toBeGreaterThanOrEqual(4.5 - 1e-6)
        }
      }
    }
  })
})

it('OKLab is the reference transform (white L=1, black L=0, grey is achromatic)', () => {
  expect(oklab(WHITE)[0]).toBeCloseTo(1, 4)
  expect(oklab(BLACK)[0]).toBeCloseTo(0, 6)
  const [, a, b] = oklab(grey(128))
  expect(Math.hypot(a, b)).toBeLessThan(1e-4)
})

it('(c·√k, √k) blended SRC_ALPHA over a cleared premultiplied canvas stores exactly (c·k, k)', () => {
  for (const k of [0.04, 0.11, 0.22]) {
    const c = 188 / 255
    const s = Math.sqrt(k)
    expect(c * s * s).toBeCloseTo(c * k, 12)
    expect(s * s).toBeCloseTo(k, 12)
  }
})

it('setGlassCellAlpha reports only real changes', () => {
  const t = {} as Terminal
  expect(setGlassCellAlpha(t, 0.2)).toBe(true)
  expect(setGlassCellAlpha(t, 0.2)).toBe(false)
  expect(setGlassCellAlpha(t, 0.95)).toBe(true)
  expect(setGlassCellAlpha(t, null)).toBe(true)
  expect(setGlassCellAlpha(t, null)).toBe(false)
})

it('a slider drag rebuilds once it settles; glass on/off rebuilds at once', () => {
  vi.useFakeTimers()
  try {
    const t = {} as Terminal
    const rebuild = vi.fn()
    scheduleGlassCellAlpha(t, 0.675, rebuild) // glass on: immediate
    expect(rebuild).toHaveBeenCalledTimes(1)
    // A drag: every step's effect cleanup cancels the previous step's pending rebuild.
    let cancel = () => {}
    for (const a of [0.68, 0.69, 0.7, 0.71]) {
      cancel()
      cancel = scheduleGlassCellAlpha(t, a, rebuild)
      vi.advanceTimersByTime(GLASS_CELL_REBUILD_MS / 3)
    }
    expect(rebuild).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(GLASS_CELL_REBUILD_MS)
    expect(rebuild).toHaveBeenCalledTimes(2)
    expect(setGlassCellAlpha(t, 0.71)).toBe(false) // the last step landed
    scheduleGlassCellAlpha(t, null, rebuild) // glass off: immediate
    expect(rebuild).toHaveBeenCalledTimes(3)
  } finally {
    vi.useRealTimers()
  }
})

type FakeCell = { bg: number; fg?: number; ch?: string }

/** A structural fake of the addon's RectangleRenderer, doing what the real `_updateRectangle`
 *  does with the attribute array (colour, then `$a = 1`). One class per test: the wrap patches the
 *  prototype, like it does the real shared one. */
function fakeAddon(cells: Record<number, FakeCell>, rows: Record<number, Record<number, FakeCell>> = {}) {
  class RectangleRenderer {
    _themeService = { colors: { background: { rgba: 0x1e1e1e00 }, foreground: { rgba: 0xe6e6e6ff }, ansi: [] } }
    _terminal = {
      buffer: {
        active: {
          viewportY: 0,
          getNullCell: () => ({ bg: 0, fg: 0, getCode: () => 0 }),
          getLine: (row: number) => ({
            getCell: (x: number, cell: { bg: number; fg: number; getCode: () => number }) => {
              const c = (rows[row] ?? cells)[x] ?? { bg: 0 }
              cell.bg = c.bg
              cell.fg = c.fg ?? 0
              cell.getCode = () => c.ch?.codePointAt(0) ?? 0
              return cell
            }
          })
        }
      }
    } as unknown as Terminal
    _updateRectangle(v: { attributes: Float32Array }, offset: number, fg: number, bg: number, _startX: number, _endX: number, _y: number): void {
      const rgba = bg & CM_RGB ? (bg & 0xffffff) << 8 : this._themeService.colors.background.rgba
      v.attributes.set([0, 0, 1, 1, ((rgba >>> 24) & 255) / 255, ((rgba >>> 16) & 255) / 255, ((rgba >>> 8) & 255) / 255, 1], offset)
      void fg
    }
    /** Like the real one: a full rebuild of every run from the model, through `_updateRectangle`. */
    _vertices = { attributes: new Float32Array(64) }
    passes = 0
    updateBackgrounds(model: { fg: number; bg: number; x: number; endX: number; y: number }[]): void {
      this.passes++
      model.forEach((r, i) => this._updateRectangle(this._vertices, 8 * i, r.fg, r.bg, r.x, r.endX, r.y))
    }
  }
  const rr = new RectangleRenderer()
  const addon = { _renderer: { _rectangleRenderer: { value: rr } } } as unknown as WebglAddon
  const draw = (fg: number, bg: number, x = 0, endX = x + 1, y = 0): number[] => {
    const v = { attributes: new Float32Array(8) }
    rr._updateRectangle(v, 0, fg, bg, x, endX, y)
    return Array.from(v.attributes)
  }
  return { addon, rr, draw }
}

describe('installGlassCellBackgrounds', () => {
  const panel = CM_RGB | 0x3a3a3a

  it('glass: an app panel becomes its premultiplied lift, a dim run vanishes, overrides stay', () => {
    const { addon, rr, draw } = fakeAddon({ 0: { bg: panel } })
    expect(installGlassCellBackgrounds(addon)).toBe(true)
    setGlassCellAlpha(rr._terminal, 0.675)
    const want = glassPanelFill(grey(58), DARK, 0.675, [])!
    const p = draw(0, panel)
    expect(p[7]).toBeCloseTo(Math.sqrt(want.alpha), 6)
    expect(p[4]).toBeCloseTo((want.rgb[0] / 255) * Math.sqrt(want.alpha), 6)
    expect(draw(0, DIM)[7]).toBe(0)
    expect(draw(0, CM_RGB | 0x264f78)[7]).toBe(1) // rendered bg ≠ buffer bg: selection
    expect(draw(INVERSE, panel)[7]).toBe(1)
  })

  it("reads the run's text, not just its first cell: a light bar with dark text stays opaque", () => {
    const bar = CM_RGB | 0xe0e0e0
    const text = CM_RGB | 0x000000
    const { addon, rr, draw } = fakeAddon({ 0: { bg: bar }, 1: { bg: bar, fg: text, ch: 'x' } })
    installGlassCellBackgrounds(addon)
    setGlassCellAlpha(rr._terminal, 0.675)
    expect(draw(0, bar, 0, 2)[7]).toBe(1)
  })

  it('decides once per panel colour: a multi-row light box does not stripe, and opaque sticks', () => {
    const bar = CM_RGB | 0xe0e0e0
    const blank = { 0: { bg: bar }, 1: { bg: bar } }
    const texted = { 0: { bg: bar }, 1: { bg: bar, fg: CM_RGB | 0x000000, ch: 'x' } }
    const { addon, rr, draw } = fakeAddon({}, { 0: blank, 1: texted, 2: blank })
    installGlassCellBackgrounds(addon)
    setGlassCellAlpha(rr._terminal, 0.675)
    expect(draw(0, bar, 0, 2, 0)[7]).toBeLessThan(1) // blank row, before the box's text was seen
    expect(draw(0, bar, 0, 2, 1)[7]).toBe(1) // dark text: the colour turns opaque…
    expect(draw(0, bar, 0, 2, 2)[7]).toBe(1) // …for every other row of the box
    expect(draw(0, bar, 0, 2, 0)[7]).toBe(1) // and the first row on the next rebuild
    setGlassCellAlpha(rr._terminal, 0.7) // a slider move starts over
    expect(draw(0, bar, 0, 2, 0)[7]).toBeLessThan(1)
  })

  it('a colour that turns opaque mid-pass re-runs the pass once, so earlier rows are not left translucent', () => {
    const bar = CM_RGB | 0xe0e0e0
    const blank = { 0: { bg: bar }, 1: { bg: bar } }
    const texted = { 0: { bg: bar }, 1: { bg: bar, fg: CM_RGB | 0x000000, ch: 'x' } }
    const { addon, rr } = fakeAddon({}, { 0: blank, 1: texted, 2: blank })
    installGlassCellBackgrounds(addon)
    setGlassCellAlpha(rr._terminal, 0.675)
    const model = [0, 1, 2].map((y) => ({ fg: 0, bg: bar, x: 0, endX: 2, y }))
    const alphas = (): number[] => model.map((_, i) => rr._vertices.attributes[8 * i + 7])
    rr.updateBackgrounds(model)
    expect(alphas()).toEqual([1, 1, 1]) // row 0 was drawn translucent before row 1 flipped it
    expect(rr.passes).toBe(2)
    rr.updateBackgrounds(model) // no flip: one pass, no loop
    expect(rr.passes).toBe(3)
  })

  it('panel verdicts are bounded: past PANEL_VERDICTS_MAX colours they start over', () => {
    const bar = CM_RGB | 0xe0e0e0
    const rows: Record<number, Record<number, FakeCell>> = {
      0: { 0: { bg: bar }, 1: { bg: bar } },
      1: { 0: { bg: bar }, 1: { bg: bar, fg: CM_RGB | 0x000000, ch: 'x' } }
    }
    const colour = (i: number): number => CM_RGB | (0x100000 + i) // distinct, never the bar
    for (let i = 0; i < PANEL_VERDICTS_MAX; i++) rows[2 + i] = { 0: { bg: colour(i) } }
    const { addon, rr, draw } = fakeAddon({}, rows)
    installGlassCellBackgrounds(addon)
    setGlassCellAlpha(rr._terminal, 0.675)
    draw(0, bar, 0, 2, 1) // the bar turns opaque
    for (let i = 0; i < PANEL_VERDICTS_MAX - 1; i++) draw(0, colour(i), 0, 1, 2 + i) // map now full
    expect(draw(0, bar, 0, 2, 0)[7]).toBe(1) // still remembered at the cap
    draw(0, colour(PANEL_VERDICTS_MAX - 1), 0, 1, 1 + PANEL_VERDICTS_MAX) // one more: cleared
    expect(draw(0, bar, 0, 2, 0)[7]).toBeLessThan(1) // forgotten, decided afresh
  })

  it('an exception after the original leaves the stock rectangle instead of breaking the frame', () => {
    const { addon, rr, draw } = fakeAddon({ 0: { bg: panel } })
    installGlassCellBackgrounds(addon)
    setGlassCellAlpha(rr._terminal, 0.675)
    rr._terminal.buffer.active.getLine = () => {
      throw new Error('renamed internals')
    }
    expect(() => draw(0, panel)).not.toThrow()
    expect(draw(0, panel)[7]).toBe(1)
  })

  it('non-glass terminals are byte-identical to the stock renderer', () => {
    const stock = fakeAddon({ 0: { bg: panel } })
    const wrapped = fakeAddon({ 0: { bg: panel } })
    installGlassCellBackgrounds(wrapped.addon)
    for (const [fg, bg] of [[0, panel], [0, DIM], [INVERSE, panel], [0, CM_RGB | 0x264f78]]) {
      expect(wrapped.draw(fg, bg)).toEqual(stock.draw(fg, bg))
    }
  })

  it('a re-install (hot reload) wraps the original, never the wrap', () => {
    const once = fakeAddon({ 0: { bg: panel } })
    installGlassCellBackgrounds(once.addon)
    setGlassCellAlpha(once.rr._terminal, 0.675)
    const twice = fakeAddon({ 0: { bg: panel } })
    installGlassCellBackgrounds(twice.addon)
    installGlassCellBackgrounds(twice.addon)
    setGlassCellAlpha(twice.rr._terminal, 0.675)
    expect(twice.draw(0, panel)).toEqual(once.draw(0, panel))
  })

  it('fails open when the internals are missing', () => {
    expect(installGlassCellBackgrounds({} as WebglAddon)).toBe(false)
    expect(installGlassCellBackgrounds({ _renderer: { _rectangleRenderer: { value: {} } } } as unknown as WebglAddon)).toBe(false)
  })
})

/**
 * Guard: the wrap leans on addon-webgl PRIVATES. An upgrade must fail here, loudly, instead of
 * silently falling back to opaque slabs (the wrap fails open). If this fails: re-read
 * `src/RectangleRenderer.ts` of the new version, re-derive the names in glass-cell-backgrounds.ts
 * — or delete the wrap if upstream now honours background alpha.
 */
describe('addon-webgl internals the glass cell wrap relies on', () => {
  const dir = path.resolve(__dirname, '../../../node_modules/@xterm/addon-webgl')
  const bundle = fs.readFileSync(path.join(dir, 'lib/addon-webgl.js'), 'utf8')

  it('is the pinned 0.18.0', () => {
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe('0.18.0')
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'))
    expect({ ...pkg.dependencies, ...pkg.devDependencies }['@xterm/addon-webgl']).toBe('0.18.0')
  })

  it.each([
    'this._renderer=', // WebglAddon._renderer
    '_rectangleRenderer.value=new', // WebglRenderer._rectangleRenderer (a MutableDisposable)
    '_updateRectangle(e,t,i,s,r,o,a){', // (vertices, offset, fg, bg, startX, endX, y)
    'updateBackgrounds(',
    'this._terminal=e,this._gl=t,this._dimensions=i,this._themeService', // RectangleRenderer fields
    'e[t+4]=n,e[t+5]=a,e[t+6]=h,e[t+7]=l', // _addRectangle: r,g,b,a at offset+4..7
    'v=1,this._addRectangle(e.attributes,t,' // the forced alpha 1 the wrap rewrites; gone = fixed upstream?
  ])('bundle contains %s', (needle) => {
    expect(bundle).toContain(needle)
  })
})
