import type { Terminal } from '@xterm/xterm'
import type { WebglAddon } from '@xterm/addon-webgl'
import { composite, contrastRatio, relativeLuminance, worstContrast } from '../lib/glassContrast'

/**
 * Cell backgrounds on a Liquid Glass terminal become glass instead of opaque slabs.
 *
 * addon-webgl 0.18.0 paints every background rectangle at alpha 1 (`RectangleRenderer.
 * _updateRectangle`: `$a = 1`), whatever the colour came from. Under glass the viewport itself is
 * transparent, so two things read as black/grey cards over the wallpaper:
 *  - app-painted backgrounds (Grok's full-screen `48;2;20;20;20`, Codex's composer, Claude's
 *    user bubble), and
 *  - attribute-only runs: DIM / ITALIC / HAS_EXTENDED live in the bg word, so a dim run on the
 *    DEFAULT background still gets a rectangle, filled with the theme background at alpha 1
 *    (Codex's all-dim header box). That half is an xterm bug for any `allowTransparency` user.
 *
 * xterm has no option for either (`allowTransparency` is all there is, and palette alpha is
 * ignored), so this wraps the private `_updateRectangle` on the shared prototype and rewrites the
 * colour the original just wrote — the same private coupling a bundle patch would need, minus the
 * postinstall and Vite pre-bundle cache. Fail-open like `dom-renderer-spacing.ts`: a build that
 * renamed anything keeps stock rendering. `glass-cell-backgrounds.test.ts` pins the addon version
 * and every private name used here.
 *
 * Only terminals given an alpha through `setGlassCellAlpha` are touched; for every other terminal
 * the wrap returns right after the original, so non-glass output is byte-identical.
 *
 * Ceiling: the DOM renderer fallback (WebGL budget exhausted / context lost) keeps opaque explicit
 * backgrounds — its inline truecolor `background-color` cannot be re-alpha'd from CSS.
 */

type Rgb = readonly [number, number, number]

// xterm's packed attribute bits (common/buffer/Constants.ts).
const FG_INVERSE = 0x4000000
const CM_MASK = 0x3000000
const CM_P16 = 0x1000000
const CM_P256 = 0x2000000
const CM_RGB = 0x3000000

/**
 * How a background run renders on glass: `'stock'` = the renderer's own opaque rectangle, `'panel'`
 * = the app's own background (→ `glassPanelFill`), or a number = the THEME background at that alpha.
 * - inverse video (and the fake cursors TUIs draw with it) is stock;
 * - an attribute-only run (default bg + DIM/ITALIC/…) gets the theme background's alpha, which is
 *   what the rest of the viewport gets (0 under glass);
 * - a rendered bg that differs from the buffer cell's raw bg is a RENDERER override — selection,
 *   the block cursor, a search/decoration highlight — and is stock.
 */
export function classifyRun(fg: number, bg: number, cellBg: number, themeBgA: number): 'stock' | 'panel' | number {
  if (fg & FG_INVERSE) return 'stock'
  if ((bg & CM_MASK) === 0) return themeBgA
  if (bg !== cellBg) return 'stock'
  return 'panel'
}

/** OKLab (L, a, b) of an sRGB colour, 0..255 channels. */
export function oklab([r, g, b]: Rgb): [number, number, number] {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

/** ponytail: tuning knobs. Panel overlay alpha = PANEL_K × OKLab distance(panel, theme bg), clamped.
 *  K = 1 puts Claude's #3a3a3a bubble on #1e1e1e at 0.11 white and Grok's #141414 screen at 0.044
 *  black; raise K for bolder panels (the contrast check below still holds). */
const PANEL_K = 1
const PANEL_ALPHA_MIN = 0.04
const PANEL_ALPHA_MAX = 0.22
/** OKLab distance under which a panel IS the theme background (drawn as nothing). */
const PANEL_DEAD_ZONE = 0.02
/** OKLab chroma above which a panel keeps its own hue (a coloured status bar) instead of going grey. */
const PANEL_CHROMA_MIN = 0.04
/** Glyphs under this contrast on the app's own opaque panel are decoration (a dim prompt chevron),
 *  not text — unprotected, like ANSI colours on plain glass. */
const TEXT_MIN_CONTRAST = 3

/**
 * An app panel as a vibrancy fill: a gentle lift or sink of the glass, NEVER a second slab of the
 * node's tint (drawing the panel colour at the tint alpha stacked the two, and #3a3a3a over a bright
 * wallpaper read as a dark smudge).
 *
 * The panel colour C is judged against the theme background B: the overlay's alpha is
 * `PANEL_K × OKLab distance`, clamped to [0.04, 0.22], independent of the node alpha `t` (the Glass
 * slider keeps meaning the node's glass). Its colour: C itself when C is clearly chromatic (a
 * coloured bar stays coloured), otherwise neutral — white for a lift, black for a sink.
 *
 * A neutral move AWAY from the text (a sink on a dark theme) only adds contrast. A move TOWARD it
 * (a lift on a dark theme, a sink on a light one) is where the guarantee lives: at or right of the
 * Readable tick the overlay is the glass's own composite over the extreme backdrop (`B·t + white·
 * (1−t)` for a dark-theme lift), so it lifts wherever the backdrop leaves room and can never push
 * the composite past the glass's worst case — the theme foreground keeps exactly the plain glass's
 * 4.5:1. Left of the tick (no guarantee there, as on the plain glass) it slides toward pure white in
 * proportion to how far the glass already is from 4.5:1, so it is continuous at the tick.
 *
 * Every text colour on the run is then checked (`panelTextOk`); a panel that fails returns null:
 * opaque, exactly the app's own panel.
 *
 * Returns the fill (0..255 colour, alpha) or null for opaque. `alpha` 0 = draw nothing.
 */
export function glassPanelFill(
  c: Rgb,
  theme: { bg: Rgb; fg: Rgb },
  t: number,
  texts: readonly Rgb[]
): { rgb: Rgb; alpha: number } | null {
  const fill = panelFill(c, theme, t)
  return fill && texts.every((f) => panelTextOk(f, c, fill, theme, t)) ? fill : null
}

type PanelFill = { rgb: Rgb; alpha: number }

/** The panel's lift/sink before any text is considered; null only under Reduce Transparency. */
function panelFill(c: Rgb, theme: { bg: Rgb; fg: Rgb }, t: number): PanelFill | null {
  if (t >= 1) return null // Reduce Transparency: the app's panels, opaque
  const [lc, ac, bc] = oklab(c)
  const [lb, ab, bb] = oklab(theme.bg)
  const dist = Math.hypot(lc - lb, ac - ab, bc - bb)
  if (dist < PANEL_DEAD_ZONE) return { rgb: c, alpha: 0 }
  const alpha = Math.min(PANEL_ALPHA_MAX, Math.max(PANEL_ALPHA_MIN, PANEL_K * dist))
  const glassWorst = worstContrast(theme.fg, theme.bg, t)
  const fgLight = relativeLuminance(theme.fg) > relativeLuminance(theme.bg)
  if (Math.hypot(ac, bc) > PANEL_CHROMA_MIN) return { rgb: c, alpha }
  const lift = lc > lb
  const extreme: Rgb = lift ? [255, 255, 255] : [0, 0, 0]
  if (lift !== fgLight) return { rgb: extreme, alpha }
  const ceiling = composite(theme.bg, extreme, t)
  const toward = glassWorst >= 4.5 ? 0 : Math.min(1, (4.5 - glassWorst) / 3.5)
  return { rgb: composite(extreme, ceiling, toward), alpha }
}

/**
 * Does text colour `f` stay readable on panel `c` drawn as `fill`? Glyphs under
 * `TEXT_MIN_CONTRAST` on the opaque panel are decoration (e.g. a dim prompt chevron) and pass.
 *  - text of INVERTED polarity — on the other side of the PANEL from the theme foreground (dark
 *    text on a light bar in a dark theme): the panel is what makes it readable, so it must keep
 *    min(4.5, its contrast on the opaque panel) over ANY backdrop;
 *  - other text, while the guarantee is on, must fare no worse than on the plain glass around it.
 * Polarity is judged against the panel, not the theme background: #303030 text is "lighter than
 * #1e1e1e" yet dark on a #e4e4e4 bar, and judging it by the theme let that bar go translucent
 * (worst contrast 1.00).
 */
function panelTextOk(f: Rgb, c: Rgb, fill: PanelFill, theme: { bg: Rgb; fg: Rgb }, t: number): boolean {
  if (fill.alpha === 0) return true // drawn as nothing: the plain glass
  const own = contrastRatio(f, c)
  if (own < TEXT_MIN_CONTRAST) return true
  const guaranteed = worstContrast(theme.fg, theme.bg, t) >= 4.5
  const fgLight = relativeLuminance(theme.fg) > relativeLuminance(theme.bg)
  const lf = relativeLuminance(f)
  const inverted = lf > relativeLuminance(c) !== fgLight
  if (!inverted && !guaranteed) return true
  // Over backdrop X the node shows G(X) = B·t + X·(1−t); the panel paints rgb·alpha over it. Both
  // are affine in X, so the composite's luminance range is spanned by X = black and X = white.
  const lo = composite(fill.rgb, composite(theme.bg, [0, 0, 0], t), fill.alpha)
  const hi = composite(fill.rgb, composite(theme.bg, [255, 255, 255], t), fill.alpha)
  const [llo, lhi] = [relativeLuminance(lo), relativeLuminance(hi)].sort((x, y) => x - y)
  const worst = lf > llo && lf < lhi ? 1 : Math.min(contrastRatio(f, lo), contrastRatio(f, hi))
  const need = inverted ? Math.min(4.5, own) : Math.min(own, worstContrast(f, theme.bg, t))
  return worst >= need - 1e-9
}

/** The node's glass alpha per terminal; absent = not glass = stock rendering. */
const cellAlpha = new WeakMap<Terminal, number>()

/** Set (or clear with null) a terminal's glass alpha. True when it changed — the caller then owes a
 *  model rebuild (`term.clearTextureAtlas()`), since backgrounds are only recomputed for changed
 *  cells. */
export function setGlassCellAlpha(term: Terminal, alpha: number | null): boolean {
  panelVerdicts.delete(term)
  if (alpha === null) return cellAlpha.delete(term)
  if (cellAlpha.get(term) === alpha) return false
  cellAlpha.set(term, alpha)
  return true
}

/**
 * One verdict per PANEL COLOUR per terminal, not per run: addon-webgl rebuilds every row's
 * rectangles on any cell change (each cursor blink included), and deciding each row alone striped a
 * multi-row light box (rows with dark text opaque, the blank rows of the same box lifted). The fill
 * is computed once; each text colour is checked once; a failure makes the colour opaque for good —
 * and the pass that saw it is re-run (see the `updateBackgrounds` wrap) so the rows drawn before it
 * do not stay translucent on an idle screen. Dropped whenever the slider alpha or the theme's bg/fg
 * changes, and wholesale past `PANEL_VERDICTS_MAX` colours (truecolor images/video paint thousands).
 * ponytail: an OSC 4 palette-only change keeps the old verdicts until the next alpha/theme change;
 * key on the ANSI table too if an app is ever seen recolouring its panels that way.
 */
interface PanelVerdicts {
  key: string
  panels: Map<number, { fill: PanelFill | null; ok: Set<number> }>
}
const panelVerdicts = new WeakMap<Terminal, PanelVerdicts>()
/** ponytail: a full clear past this many panel colours, not an LRU — verdicts are cheap to redo. */
export const PANEL_VERDICTS_MAX = 4096
/** Set when a panel colour turns opaque mid-pass; read by the `updateBackgrounds` wrap. */
let flippedThisPass = false

/** The colour part of a packed fg/bg word (mode + palette index or RGB), flags stripped. */
const COLOR_BITS = CM_MASK | 0xffffff

/** How long a slider drag must pause before the terminals rebuild (see `scheduleGlassCellAlpha`). */
export const GLASS_CELL_REBUILD_MS = 150

/**
 * `setGlassCellAlpha` + the rebuild it owes, for a React effect (returns its cleanup). A rebuild is
 * `term.clearTextureAtlas()`, which wipes the SHARED glyph atlas and redraws every glass terminal —
 * and a Glass-slider drag streams an alpha per 0.01 step. So a change between two glass alphas
 * waits until the drag has been still for `GLASS_CELL_REBUILD_MS`; switching glass on or off is
 * immediate (the theme changes with it, and a stale alpha would paint panels over an opaque bg).
 */
export function scheduleGlassCellAlpha(term: Terminal, alpha: number | null, rebuild: () => void): () => void {
  const apply = (): void => {
    if (setGlassCellAlpha(term, alpha)) rebuild()
  }
  if (alpha === null || !cellAlpha.has(term)) {
    apply()
    return () => {}
  }
  const id = setTimeout(apply, GLASS_CELL_REBUILD_MS)
  return () => clearTimeout(id)
}

type Vertices = { attributes: Float32Array }
type UpdateRectangle = (
  v: Vertices,
  offset: number,
  fg: number,
  bg: number,
  startX: number,
  endX: number,
  y: number
) => void
interface RectangleRendererLike {
  _terminal: Terminal
  _themeService?: {
    colors?: { background?: { rgba: number }; foreground?: { rgba: number }; ansi?: { rgba: number }[] }
  }
}
interface CellLike {
  bg?: number
  fg?: number
  getCode?(): number
}

/** Kept on the prototype, not in module state, so a hot-reloaded copy of this module re-wraps the
 *  ORIGINAL instead of stacking a second wrap over the first. */
const ORIGINAL = Symbol.for('nodeterm.glassCellBackgrounds.original')
const ORIGINAL_UPDATE_BACKGROUNDS = Symbol.for('nodeterm.glassCellBackgrounds.originalUpdateBackgrounds')

const rgbOf = (rgba: number): Rgb => [(rgba >>> 24) & 255, (rgba >>> 16) & 255, (rgba >>> 8) & 255]

/** Write `rgb` (0..255) at `alpha` into a rectangle's colour slots. The canvas is premultiplied and
 *  the addon blends SRC_ALPHA/ONE_MINUS_SRC_ALPHA on the alpha channel too, so writing (c, k) would
 *  store (c·k, k²); (c·√k, √k) stores exactly (c·k, k). */
function writeFill(a: Float32Array, offset: number, rgb: Rgb, alpha: number): void {
  const s = Math.sqrt(alpha)
  a[offset + 4] = (rgb[0] / 255) * s
  a[offset + 5] = (rgb[1] / 255) * s
  a[offset + 6] = (rgb[2] / 255) * s
  a[offset + 7] = s
}

/** Wrap the addon's rectangle renderer once (all instances share the prototype). Call after
 *  `term.loadAddon(addon)`, when the renderer exists. Returns whether the wrap is in place. */
export function installGlassCellBackgrounds(addon: WebglAddon): boolean {
  try {
    const rr = (addon as unknown as { _renderer?: { _rectangleRenderer?: { value?: object } } })._renderer
      ?._rectangleRenderer?.value
    const proto = rr && (Object.getPrototypeOf(rr) as Record<PropertyKey, unknown>)
    if (!proto) return false
    const orig = (proto[ORIGINAL] ?? proto._updateRectangle) as UpdateRectangle | undefined
    if (typeof orig !== 'function') return false
    proto[ORIGINAL] = orig
    let scratch: CellLike | undefined
    // The part after the original, for glass terminals only. `a` is read by the caller AFTER the
    // original, which may have grown the array.
    const glassRectangle = (
      rr: RectangleRendererLike,
      a: Float32Array,
      offset: number,
      fg: number,
      bg: number,
      startX: number,
      endX: number,
      y: number,
      t: number
    ): void => {
      const colors = rr._themeService?.colors
      const back = colors?.background?.rgba
      const fore = colors?.foreground?.rgba
      if (back === undefined || fore === undefined) return
      let line: { getCell(x: number, cell: never): unknown } | undefined
      let cellBg = NaN // unknown = treated as a renderer override (stock opaque)
      if ((bg & CM_MASK) !== 0 && !(fg & FG_INVERSE)) {
        const buf = rr._terminal.buffer.active
        scratch ??= buf.getNullCell() as unknown as CellLike
        line = buf.getLine(buf.viewportY + y)
        // No line = unknown. `scratch` is shared across calls, so reading it without a fresh
        // getCell would judge this run against the PREVIOUS run's cell.
        if (line) {
          line.getCell(startX, scratch as never)
          if (typeof scratch.bg === 'number') cellBg = scratch.bg
        }
      }
      const kind = classifyRun(fg, bg, cellBg, (back & 255) / 255)
      if (kind === 'stock') return
      if (typeof kind === 'number') {
        if (kind < 1) writeFill(a, offset, rgbOf(back), kind)
        return
      }
      const key = `${t}|${back}|${fore}`
      let verdicts = panelVerdicts.get(rr._terminal)
      if (verdicts?.key !== key) panelVerdicts.set(rr._terminal, (verdicts = { key, panels: new Map() }))
      const run: Rgb = [a[offset + 4] * 255, a[offset + 5] * 255, a[offset + 6] * 255]
      const theme = { bg: rgbOf(back), fg: rgbOf(fore) }
      let panel = verdicts.panels.get(bg & COLOR_BITS)
      if (!panel) {
        if (verdicts.panels.size >= PANEL_VERDICTS_MAX) verdicts.panels.clear()
        verdicts.panels.set(bg & COLOR_BITS, (panel = { fill: panelFill(run, theme, t), ok: new Set() }))
      }
      // The run's text colours: a run spans cells of one bg but any fg, and the fg the renderer
      // passes is only the first cell's. Each colour is checked once per panel colour.
      for (let x = startX; x < endX && panel.fill && line && scratch; x++) {
        line.getCell(x, scratch as never)
        const f = scratch.fg
        const code = scratch.getCode?.() ?? 0
        if (typeof f !== 'number' || code === 0 || code === 32 || panel.ok.has(f & COLOR_BITS)) continue
        const mode = f & CM_MASK
        const text =
          mode === CM_RGB
            ? rgbOf((f & 0xffffff) << 8)
            : (mode === CM_P16 || mode === CM_P256) && colors?.ansi?.[f & 0xff]
              ? rgbOf(colors.ansi[f & 0xff].rgba)
              : rgbOf(fore)
        if (panelTextOk(text, run, panel.fill, theme, t)) panel.ok.add(f & COLOR_BITS)
        else {
          panel.fill = null // opaque sticks for this colour
          flippedThisPass = true
        }
      }
      if (panel.fill) writeFill(a, offset, panel.fill.rgb, panel.fill.alpha)
    }
    proto._updateRectangle = function (
      this: RectangleRendererLike,
      v: Vertices,
      offset: number,
      fg: number,
      bg: number,
      startX: number,
      endX: number,
      y: number
    ): void {
      orig.call(this, v, offset, fg, bg, startX, endX, y)
      const t = cellAlpha.get(this._terminal)
      if (t === undefined) return
      // Fail open per call too: an exception here would otherwise break every frame. The original
      // already wrote the stock rectangle, so returning leaves exactly that.
      try {
        glassRectangle(this, v.attributes, offset, fg, bg, startX, endX, y, t)
      } catch {
        /* stock rectangle */
      }
    }
    // A verdict that turns opaque mid-pass leaves the rows ALREADY drawn in this pass translucent,
    // and `term.refresh` would not fix them: the addon calls `updateBackgrounds` only when a model
    // cell changed. `updateBackgrounds` is a full rebuild from the model, so re-run it once — the
    // re-run cannot flip again (an opaque colour's text loop is skipped). Optional: missing ⇒ the
    // rows catch up on the next rebuild, as before.
    const origUpdate = (proto[ORIGINAL_UPDATE_BACKGROUNDS] ?? proto.updateBackgrounds) as
      | ((model: unknown) => void)
      | undefined
    if (typeof origUpdate === 'function') {
      proto[ORIGINAL_UPDATE_BACKGROUNDS] = origUpdate
      proto.updateBackgrounds = function (this: unknown, model: unknown): void {
        flippedThisPass = false
        origUpdate.call(this, model)
        if (flippedThisPass) origUpdate.call(this, model)
        flippedThisPass = false
      }
    }
    return true
  } catch {
    return false
  }
}
