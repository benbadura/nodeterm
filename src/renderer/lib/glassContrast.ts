/**
 * The contrast guarantee behind glass terminal nodes.
 *
 * A glass node paints the terminal theme's background as a translucent tint over whatever is
 * behind it (a wallpaper, the canvas), so the effective background of every glyph is
 * `tint·a + backdrop·(1−a)`. The backdrop is unknowable — any pixel of any wallpaper.
 *
 * Why checking pure white and pure black is enough: contrast depends only on luminance, and the
 * composite's luminance rises monotonically with each backdrop channel, so EVERY backdrop's
 * composite lies in the luminance interval [composite over black, composite over white]. Against a
 * fixed text colour, contrast falls as the background's luminance approaches the text's and rises
 * away from it — so over that interval the worst case is an endpoint, UNLESS the text's own
 * luminance falls inside the interval, where some backdrop matches it exactly (ratio 1). That case
 * is checked explicitly (`worstContrast`) and fails. For the built-in themes' foregrounds it never
 * arises at a ≥ 0.55: the tint then dominates the composite, keeping the whole interval on the
 * tint's side of the text. `glassContrast.test.ts` samples grey backdrops to pin the claim.
 *
 * Compositing is in gamma-encoded sRGB, the way the browser blends an rgba() fill; the WCAG
 * relative luminance is computed on the result.
 *
 * Pure and platform-free (no DOM), so it runs under vitest's node environment.
 */

type Rgb = readonly [number, number, number]

/** `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha ignored) → 0..255 channels; null when unparseable. */
export function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.replace(/./g, (c) => c + c)
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function channelLuminance(c: number): number {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `tint` at `alpha` over `backdrop`, in sRGB (what `background: rgba(...)` renders). */
export function composite(tint: Rgb, backdrop: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => tint[i] * alpha + backdrop[i] * (1 - alpha)) as unknown as Rgb
}

export const GLASS_ALPHA_MIN = 0.55
export const GLASS_ALPHA_MAX = 0.95
const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]
const STEP = 0.005

/** The lowest contrast `fg` can have against the tint over ANY backdrop (see the module header). */
export function worstContrast(fg: Rgb, tint: Rgb, alpha: number): number {
  const overBlack = composite(tint, BLACK, alpha)
  const overWhite = composite(tint, WHITE, alpha)
  const l = relativeLuminance(fg)
  if (l > relativeLuminance(overBlack) && l < relativeLuminance(overWhite)) return 1
  return Math.min(contrastRatio(fg, overWhite), contrastRatio(fg, overBlack))
}

function passes(fg: Rgb, tint: Rgb, alpha: number, minRatio: number): boolean {
  return worstContrast(fg, tint, alpha) >= minRatio
}

/**
 * The smallest tint alpha at which `fg` keeps `minRatio` contrast over BOTH a white and a black
 * backdrop, floored at 0.55 so the glass never gets clearer than that.
 *
 * Scanned DOWN from opaque, stopping at the first failure. Contrast is not monotonic in alpha when
 * the fg's luminance lies between the backdrop's and the tint's (light text on a dark tint over
 * white: the composite passes through the text's own grey), so a scan up from 0 could return an
 * alpha whose neighbours above it fail. Scanning down returns the bottom of the contiguous passing
 * range that reaches opaque, so every alpha at or above the answer passes.
 *
 * The design ceiling is 0.95, and for every built-in theme but the two Solarized ones the answer
 * sits under it (measured: 0.62–0.885). The guarantee outranks the ceiling, though — readable text
 * is the load-bearing requirement and "never fully opaque" is a look:
 *  - Solarized Dark (opaque contrast 4.75) needs 0.985, and gets it.
 *  - Solarized Light is 4.13:1 OPAQUE — under 4.5 before any glass — so no alpha passes. It gets 1:
 *    the glass can only match the theme's own contrast, and 1 is the one alpha that never makes it
 *    worse. `glassContrast.test.ts` pins both as named exceptions.
 * Unparseable colours get the ceiling.
 */
export function glassTintAlpha(fg: string, tint: string, minRatio = 4.5): number {
  const f = parseHex(fg)
  const t = parseHex(tint)
  if (!f || !t) return GLASS_ALPHA_MAX
  let lowest = Infinity
  for (let i = Math.round(1 / STEP); i >= 0; i--) {
    const a = i * STEP
    if (!passes(f, t, a, minRatio)) break
    lowest = a
  }
  if (lowest === Infinity) return 1
  return Math.max(GLASS_ALPHA_MIN, lowest)
}

/* Status chips on a glass header (styles.css `.term-node__status` under Liquid Glass): the label
   is the terminal foreground, and the chip behind it is a wash of the status hue. The wash moves
   the surface under the text, so it gets the same treatment as the tint: the LARGEST wash (up to
   GLASS_CHIP_WASH_MAX) at which the foreground keeps 4.5:1 for every hue a badge can take, over
   any backdrop. A fixed wash cannot do it — measured, One Dark's yellow chip falls to 3.93:1 at
   12% — and a theme with no margin (Solarized Dark) gets 0, where the chip is its ring alone. */
export const GLASS_CHIP_WASH_MAX = 0.24
/** Every hue a glass status badge can be: the text-safe and fill tokens those badges read under
 *  Liquid Glass, dark then light values (styles.palette.test.ts pins them to the stylesheet). */
export const GLASS_CHIP_HUES = [
  '#30d158', '#6cb0ff', '#ff9f0a', '#ff453a', '#ffd60a', '#98989d', '#bf5af2',
  '#1f7a38', '#0060df', '#a85c00', '#c62a1f', '#34c759', '#806100', '#8e8e93', '#af52de'
]
/** The glass header's own layer over the node tint (see `glassTint().header`). */
const HEADER_LAYER_ALPHA = 0.35
const CHIP_BACKDROPS: Rgb[] = (() => {
  const out: Rgb[] = []
  for (const r of [0, 255]) for (const g of [0, 255]) for (const b of [0, 255]) out.push([r, g, b])
  for (let v = 0; v <= 255; v += 5) out.push([v, v, v])
  return out
})()
const chipWashCache = new Map<string, number>()

/** Largest status-chip wash keeping `fg` at 4.5:1 on a glass header tinted `bg` at `alpha`. */
export function glassChipWash(fg: string, bg: string, alpha: number): number {
  const key = `${fg}|${bg}|${alpha.toFixed(3)}`
  const hit = chipWashCache.get(key)
  if (hit !== undefined) return hit
  const f = parseHex(fg)
  const b = parseHex(bg)
  const hues = GLASS_CHIP_HUES.map((h) => parseHex(h)!)
  let best = 0
  if (f && b) {
    const heads = CHIP_BACKDROPS.map((d) => composite(b, composite(b, d, alpha), HEADER_LAYER_ALPHA))
    for (let i = 1; i <= Math.round(GLASS_CHIP_WASH_MAX * 100); i++) {
      const w = i / 100
      if (!heads.every((h) => hues.every((hue) => contrastRatio(f, composite(hue, h, w)) >= 4.5))) break
      best = w
    }
  }
  chipWashCache.set(key, best)
  return best
}

export interface GlassTint {
  /** The node's glass fill, `rgba(r, g, b, a)`. */
  background: string
  /** The header's extra layer on top of it — slightly more opaque in total. */
  header: string
  /** The status-chip wash for this theme, as a CSS percentage (`glassChipWash`). */
  chipWash: string
  /** The theme foreground: header text sits on the TERMINAL's tint, so it takes the terminal's
   *  text colour, not the app's (a light app theme over a dark terminal theme measured 1.31:1). */
  foreground: string
  /** The fill's alpha as a number — app-painted cell backgrounds follow it
   *  (`terminal/glass-cell-backgrounds.ts`). */
  alpha: number
}

/** CSS for a theme's glass at a Glass-slider position (default: the Readable tick), or null when
 *  its background is not a colour we can parse. */
export function glassTint(
  theme: { background?: string; foreground?: string },
  slider: number = GLASS_READABLE_TICK,
  a11y: GlassA11y = NO_GLASS_A11Y
): GlassTint | null {
  const bg = theme.background ? parseHex(theme.background) : null
  if (!bg) return null
  const foreground = theme.foreground ?? '#ffffff'
  const readable = glassTintAlpha(foreground, theme.background!)
  const alpha = glassSurfaceAlpha(slider, readable, a11y)
  const rgb = bg.join(', ')
  // Sized at the Readable tick, whatever the slider: left of it the promise is off anyway, and
  // right of it a denser tint only leaves MORE room for the wash, so the tick's wash still passes —
  // one computation per theme instead of a ~21k-check cache miss per slider step.
  const chipWash = glassChipWash(foreground, theme.background!, readable)
  return {
    background: `rgba(${rgb}, ${alpha.toFixed(3)})`,
    header: `rgba(${rgb}, ${HEADER_LAYER_ALPHA})`,
    chipWash: `${Math.round(chipWash * 100)}%`,
    foreground,
    alpha
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Liquid Glass CHROME (tab bar, dock, menus, sidebar, dialogs, Settings, non-terminal nodes).
 *
 * Same guarantee, one difference that matters: the app's `--text` is itself TRANSLUCENT
 * (`rgba(var(--tint-rgb), 0.85)`), so the ink a user sees is the text colour blended over the
 * surface it sits on — and that surface is now a blend over an unknown backdrop. The foreground
 * therefore moves WITH the backdrop, which breaks the white/black endpoint argument above (it
 * assumes a fixed fg). So this one samples: a 6×6×6 grid of backdrop colours (every channel at
 * 0, 51, …, 255) plus a grey ramp at step 5. `glassContrast.test.ts` re-checks the answer on a
 * finer grey sweep for both app themes.
 * ------------------------------------------------------------------------------------------- */

/** `#hex`, `rgb(r, g, b)` or `rgba(r, g, b, a)` → channels + alpha; null when unparseable. */
export function parseCssColor(css: string): { rgb: Rgb; alpha: number } | null {
  const hex = parseHex(css)
  if (hex) return { rgb: hex, alpha: 1 }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(css.trim())
  if (!m) return null
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: m[4] === undefined ? 1 : Number(m[4]) }
}

const CHROME_BACKDROPS: Rgb[] = (() => {
  const out: Rgb[] = []
  for (let r = 0; r <= 255; r += 51)
    for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) out.push([r, g, b])
  for (let v = 0; v <= 255; v += 5) out.push([v, v, v])
  return out
})()

/** Contrast of (possibly translucent) text on `panel`@`alpha` over one backdrop pixel. */
export function chromeContrast(
  text: { rgb: Rgb; alpha: number },
  panel: Rgb,
  alpha: number,
  backdrop: Rgb
): number {
  const surface = composite(panel, backdrop, alpha)
  return contrastRatio(composite(text.rgb, surface, text.alpha), surface)
}

/** The highlight washes on glass rows (styles.css `--glass-lift` = theme ink at this alpha,
 *  `--glass-select` = the accent mixed at this share). Pinned to the stylesheet by
 *  glassContrast.test.ts, so the two cannot drift apart. */
export const GLASS_LIFT_ALPHA = 0.14
export const GLASS_SELECT_MIX = 0.3

/** A highlighted state on a chrome surface: `wash` composited over the fill, `ink` on top. */
export interface ChromeHighlight {
  ink: string
  wash: string
}

/** Contrast of `text` on a highlight `wash` over `panel`@`alpha` over one backdrop pixel. */
export function chromeHighlightContrast(
  text: { rgb: Rgb; alpha: number },
  wash: { rgb: Rgb; alpha: number },
  panel: Rgb,
  alpha: number,
  backdrop: Rgb
): number {
  return chromeContrast(text, wash.rgb, wash.alpha, composite(panel, backdrop, alpha))
}

/** The highlighted states every glass chrome surface carries, from the resolved tokens: the ink
 *  lift (hover, active tab) and the accent selection, both with `--text-strong` labels (styles.css
 *  sets that ink on them under glass). An unparseable accent drops only the selection check. */
export function glassChromeHighlights(textStrong: string, tintRgb: string, accent: string): ChromeHighlight[] {
  const out: ChromeHighlight[] = [{ ink: textStrong, wash: `rgba(${tintRgb}, ${GLASS_LIFT_ALPHA})` }]
  const a = parseCssColor(accent)
  if (a) out.push({ ink: textStrong, wash: `rgba(${a.rgb.join(', ')}, ${GLASS_SELECT_MIX})` })
  return out
}

/**
 * The smallest alpha (floored at 0.55) for a chrome surface of colour `panel` that keeps `text`
 * at `minRatio` over every sampled backdrop; 1 when even opaque does not reach it; null when a
 * colour cannot be parsed (the caller then leaves the chrome opaque).
 *
 * `highlights` are the washes a row or tab lays over the same fill (hover lift, active tab,
 * selected row) with the ink they carry: the fill must hold `minRatio` for EVERY one of them too.
 * A lift of the theme's own ink moves the surface toward the text, so without this the plain fill
 * passed and the active tab measured 3.9:1 (visual QA round 2, N2).
 */
export function glassChromeAlpha(
  text: string,
  panel: string,
  minRatio = 4.5,
  highlights: readonly ChromeHighlight[] = []
): number | null {
  const t = parseCssColor(text)
  const p = parseCssColor(panel)
  if (!t || !p) return null
  const hs = highlights.map((h) => ({ ink: parseCssColor(h.ink), wash: parseCssColor(h.wash) }))
  if (hs.some((h) => !h.ink || !h.wash)) return null
  const holds = (a: number, b: Rgb): boolean =>
    chromeContrast(t, p.rgb, a, b) >= minRatio &&
    hs.every((h) => chromeHighlightContrast(h.ink!, h.wash!, p.rgb, a, b) >= minRatio)
  let lowest = Infinity
  for (let i = Math.round(1 / STEP); i >= 0; i--) {
    const a = i * STEP
    if (!CHROME_BACKDROPS.every((b) => holds(a, b))) break
    lowest = a
  }
  if (lowest === Infinity) return 1
  return Math.max(GLASS_ALPHA_MIN, lowest)
}

/* ------------------------------------------------------------------------------------------- *
 * The Glass slider (Settings → Appearance, Liquid Glass only): Clear ↔ Tinted, like iOS 26.
 *
 * One setting drives every glass surface, and every surface has its OWN readable alpha (the chrome
 * fill, each terminal theme). So the slider is not an alpha: it is a position `t` in 0..1, and each
 * surface maps it through three points — Clear at 0, its own readable alpha at the Readable tick,
 * Tinted at 1. At the tick every surface sits exactly at the alpha the functions above computed,
 * which is why the tick can promise 4.5:1; right of it every alpha is higher, and the scans above
 * return the bottom of a range that reaches opaque, so the promise holds all the way to Tinted.
 * Left of the tick is clearer than the guarantee, and the Settings row says so.
 * ------------------------------------------------------------------------------------------- */

/** Tint alpha at the Clear end: never fully clear, the tint still says where a surface is. */
export const GLASS_CLEAR_ALPHA = 0.2
/** Chrome floor at Clear for the small floating CONTROLS (dock, zoom, toolbar buttons, minimap,
 *  pills, tab bar): Apple's one published dimming figure ("consider adding a dark dimming layer of
 *  35% opacity", materials.md). At 0.2 their icons vanished over a bright wallpaper (visual QA H4). */
export const GLASS_CONTROL_CLEAR_ALPHA = 0.35
/** Tint alpha at the Tinted end (a surface whose readable alpha is higher keeps its own). */
export const GLASS_TINTED_ALPHA = 0.95
/** Where the Readable tick sits on the track — also the default, so an untouched slider is the
 *  look Liquid Glass shipped with. 0.7 is close to where the chrome's readable alpha falls on a
 *  straight Clear→Tinted scale (dark 0.70 → 0.67, light 0.745 → 0.73), so the track reads as
 *  roughly linear. */
export const GLASS_READABLE_TICK = 0.7

/** `settings.glassTint` → a slider position. Absent / not a finite number = the Readable tick. */
export function resolveGlassSlider(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : GLASS_READABLE_TICK
}

/** The tint alpha of a surface whose readable alpha is `readable`, at slider position `t`.
 *  `clear` is the surface's alpha at the Clear end (terminal nodes 0.2, controls 0.35). */
export function glassSliderAlpha(t: number, readable: number, clear = GLASS_CLEAR_ALPHA): number {
  const tinted = Math.max(readable, GLASS_TINTED_ALPHA)
  if (t <= GLASS_READABLE_TICK) {
    return clear + ((readable - clear) * t) / GLASS_READABLE_TICK
  }
  return readable + ((tinted - readable) * (t - GLASS_READABLE_TICK)) / (1 - GLASS_READABLE_TICK)
}

/** Edge-lens displacement (feDisplacementMap `scale`, objectBoundingBox units): strongest at
 *  Clear, flat at Tinted. It moves backdrop pixels, never the tint, so it cannot touch contrast. */
export const GLASS_REFRACT_MAX = 0.025
export function glassRefraction(t: number): number {
  return GLASS_REFRACT_MAX * (1 - t)
}

/** The system accessibility settings that outrank the Glass slider, like iOS. */
export interface GlassA11y {
  /** Reduce Transparency: glass becomes opaque (and loses blur, refraction and sheen in CSS). */
  reduceTransparency: boolean
  /** Increase Contrast: the slider pins to the Tinted end. */
  moreContrast: boolean
}
export const NO_GLASS_A11Y: GlassA11y = { reduceTransparency: false, moreContrast: false }

/** The tint alpha a surface actually gets: the slider's, unless an accessibility setting wins. */
export function glassSurfaceAlpha(
  t: number,
  readable: number,
  a11y: GlassA11y = NO_GLASS_A11Y,
  clear = GLASS_CLEAR_ALPHA
): number {
  if (a11y.reduceTransparency) return 1
  return glassSliderAlpha(a11y.moreContrast ? 1 : t, readable, clear)
}

/**
 * The two chrome fills (Phase 4 slider scope; HIG: the regular variant for anything with a lot of
 * text). Left of the Readable tick only the small floating CONTROLS follow the slider, down to
 * `GLASS_CONTROL_CLEAR_ALPHA`; TEXT surfaces (Settings, menus, popovers, the palette, dialogs, the
 * sessions sidebar, kanban columns) never go below their readable alpha. Right of the tick both
 * follow the slider. Terminal nodes are neither: they keep their own tint (`glassTint`).
 */
export function glassChromeAlphas(
  t: number,
  readable: number,
  a11y: GlassA11y = NO_GLASS_A11Y,
  controlClear = GLASS_CONTROL_CLEAR_ALPHA
): { text: number; control: number } {
  return {
    text: glassSurfaceAlpha(Math.max(t, GLASS_READABLE_TICK), readable, a11y),
    control: glassSurfaceAlpha(t, readable, a11y, Math.min(controlClear, readable))
  }
}

/**
 * The CONTROLS' alpha at Clear: at least `GLASS_CONTROL_CLEAR_ALPHA`, and enough that `text` (their
 * icons) keeps 3:1 — WCAG's non-text minimum — over every sampled backdrop once the control blur's
 * `brightness(dim)` has scaled it (styles.css `--glass-control-dim`: 0.7 dark, 1.3 light). The
 * dark theme's dimming carries it at 0.35; brightening cannot lift near-black water, so light glass
 * needs a denser floor (visual QA round 2, H4: zoom − measured 2.1:1 in light at Clear).
 */
export function glassControlClearAlpha(text: string, panel: string, dim: number): number {
  const t = parseCssColor(text)
  const p = parseCssColor(panel)
  if (!t || !p || !Number.isFinite(dim)) return GLASS_CONTROL_CLEAR_ALPHA
  const dimmed = CHROME_BACKDROPS.map((b) => b.map((c) => Math.min(255, c * dim)) as unknown as Rgb)
  for (let i = Math.round(GLASS_CONTROL_CLEAR_ALPHA / STEP); i <= Math.round(1 / STEP); i++) {
    const a = i * STEP
    if (dimmed.every((b) => chromeContrast(t, p.rgb, a, b) >= 3)) return a
  }
  return 1
}

/** Magnetic detent, like a macOS slider's tick marks: a drag within this of the tick lands on it. */
export const GLASS_TICK_DETENT = 0.03
/** Keyboard arrow step. */
export const GLASS_SLIDER_STEP = 0.05

export function snapGlassSlider(v: number): number {
  return Math.abs(v - GLASS_READABLE_TICK) <= GLASS_TICK_DETENT + 1e-9 ? GLASS_READABLE_TICK : v
}

/** One arrow press from `v` (dir -1 / +1): a step of 0.05 that stops on the tick if it crosses it. */
export function stepGlassSlider(v: number, dir: -1 | 1): number {
  const next = Math.min(1, Math.max(0, Math.round((v + dir * GLASS_SLIDER_STEP) * 1000) / 1000))
  const crosses = dir > 0 ? v < GLASS_READABLE_TICK && next > GLASS_READABLE_TICK : v > GLASS_READABLE_TICK && next < GLASS_READABLE_TICK
  return crosses ? GLASS_READABLE_TICK : snapGlassSlider(next)
}

/** `settings.glassBlurWhileMoving`: only a literal false pauses the blur during camera moves. */
export function keepGlassBlurWhileMoving(value: unknown): boolean {
  return value !== false
}
