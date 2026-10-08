/** The color/glyph brain of the xterm integration: buffer cells in, engine lanes out.
 *
 *  This module imports NOTHING from xterm — everything arrives through `CellView` (a narrow view
 *  of `IBufferCell`) and `ThemeLanes` (a snapshot of the theme already packed into the engine's
 *  color space). That is what keeps it pure, headless-testable and free of a dependency on
 *  xterm's internals, which are the part of that library most likely to move under us. */

import type { GlyphAtlas, GlyphPart } from './atlas'
import type { CursorShape } from './cursor'
import { decorationAt, type DecorationReader } from './decorations'
import {
  FLAG_BOLD,
  FLAG_CURSOR,
  FLAG_ITALIC,
  FLAG_SELECTED,
  FLAG_STRIKETHROUGH,
  FLAG_UNDERLINE,
  FLAG_WIDE,
  packColor,
  writeCell
} from './cells'

/** Narrow view of one buffer cell — the subset of xterm's IBufferCell the feed reads. The shell
 *  passes real cells; tests pass literals. */
export interface CellView {
  /** The cell's full string. A combining sequence lives HERE as one string ("e" + U+0301) —
   *  which is exactly what `getCode()` cannot express, since it reports only the LAST code point
   *  of a combined string. See `glyphCode`. */
  getChars(): string
  getCode(): number
  getWidth(): number
  isBold(): number
  isItalic(): number
  isUnderline(): number
  isStrikethrough(): number
  isInverse(): number
  isDim(): number
  isFgDefault(): boolean
  isFgPalette(): boolean
  isFgRGB(): boolean
  isBgDefault(): boolean
  isBgPalette(): boolean
  isBgRGB(): boolean
  getFgColor(): number // palette index | 0xRRGGBB when RGB
  getBgColor(): number
}

/** Snapshot of the theme in the engine's packed-color space (packColor lanes). Built once per
 *  theme change by the shell from _themeService.colors: rgb = (color.rgba >> 8) & 0xffffff. */
export interface ThemeLanes {
  fg: number // packColor default foreground
  bg: number // packColor default background (opaque)
  ansi: number[] // 256 packed colors (16 base + 240 extended)
  cursorFg: number // glyph color when under the block cursor
  cursorBg: number
  selectionBg: number // opaque selection background
}

export interface RowFeedOpts {
  cols: number
  atlas: Pick<GlyphAtlas, 'glyphFor'>
  theme: ThemeLanes
  /** Selection span on THIS viewport row, in columns [startCol, endColExclusive), or null. */
  selection: readonly [number, number] | null
  /**
   * The HOVERED LINK's column span on THIS row, `[startCol, endColExclusive)`, or null.
   *
   * Separate from `decorations` because it is not a colour: xterm's linkifier reports a hovered
   * link as a range and its own render layers answer by drawing an underline, which is the
   * affordance that tells you ⌘-click will open it. A renderer that replaces xterm's own therefore
   * has to draw it too, or the link is silently unclickable-looking (reported 2026-08-05 — the
   * `claude /login` URL underlined in GPU mode and bare in shared).
   *
   * It sets the SAME `FLAG_UNDERLINE` a cell's own SGR 4 attribute sets, so the two are one
   * mechanism with two sources and can never disagree about how an underline looks.
   */
  linkUnderline?: readonly [number, number] | null
  /** The cursor's column on THIS row, or -1. */
  cursorCol: number
  /** The shape the cursor at `cursorCol` takes. Only `block` is expressible as a cell rewrite —
   *  inverting the glyph needs the atlas asked for the swapped colours, which only this pass can do
   *  — so every other shape is drawn as an OVERLAY after the cells and leaves this row untouched
   *  (see `cursor.ts`). Defaults to `block`: every caller that predates cursor styles passes only a
   *  column, and a block is what it meant. */
  cursorShape?: CursorShape
  /** Whether the terminal has focus. The only thing it changes HERE is the selection colour — the
   *  blurred cursor is an overlay and never reaches this module. Defaults to true, so a caller that
   *  says nothing keeps the active colours it has always had. */
  focused?: boolean
  /** The terminal's decorations (search highlights and anything else that colours cells), or
   *  undefined for "this terminal has none" — which is what every caller that predates them passes,
   *  and what an xterm build with no decoration service degrades to. */
  decorations?: DecorationReader
  /** ABSOLUTE buffer row this viewport row shows — the coordinate space decoration markers are
   *  keyed in. Only read when `decorations` is set; defaults to 0 so every existing caller stays
   *  valid. */
  bufferRow?: number
}

const MAX_CODE_POINT = 0x10ffff

/** What a cell reported at the moment it packed to "draw nothing". */
export interface BlankCellReport {
  col: number
  row: number
  /** `cell.getWidth()`, or -1 when the buffer had no cell for this column at all. */
  width: number
  /** The code the feed derived — 0 when nothing was derived. */
  code: number
  /** `cell.getChars()`, i.e. what the buffer says is actually IN the cell. */
  chars: string
}

/** Debug-only tap, off unless something installs it.
 *
 *  This exists because a blank cell has several possible authors — a column past the end of the
 *  line, a code the crash guard refuses, a stray width-0 cell with no lead to be the second half of
 *  — and a screenshot cannot tell them apart. It fires only when the cell HAS content and we still
 *  drew nothing, which is the exact shape of the 2026-08-05 "a letter goes missing mid-word"
 *  report.
 *
 *  Its SILENCE is a result too: if a cell renders blank on screen and this never fires, the feed
 *  asked for the right glyph and the loss happened downstream (lane upload or draw), which is a
 *  different hunt entirely. */
let blankProbe: ((report: BlankCellReport) => void) | null = null

export function setBlankCellProbe(fn: ((report: BlankCellReport) => void) | null): void {
  blankProbe = fn
}

/** Whether a code point may reach the atlas — i.e. whether `String.fromCodePoint(code)` in the
 *  rasterizer is safe AND worth a slot.
 *
 *  This is a CRASH GUARD, not a nicety: `String.fromCodePoint` THROWS a RangeError on a negative,
 *  non-integer, or out-of-range argument, and a lone surrogate (0xD800-0xDFFF) rasterizes to
 *  garbage. A buffer cell can hold any of those after a malformed UTF-8 run, and the throw would
 *  take down the whole frame — the Phase 0 review's Task-4 crash class.
 *
 *  Everything at or below 0x20 is excluded too, for a different reason: control codes have no
 *  printable form, and space (0x20) is the most common cell on the canvas — answering it here
 *  saves a map lookup per blank cell (the atlas would return slot 0 for it anyway). */
function isRenderableCode(code: number): boolean {
  return (
    Number.isInteger(code) &&
    code > 0x20 &&
    code <= MAX_CODE_POINT &&
    !(code >= 0xd800 && code <= 0xdfff)
  )
}

/**
 * Is this a BLANK the atlas can still be asked to paint — i.e. a space, or the 0 an empty cell
 * reports?
 *
 * Only reached for an UNDERLINED or STRUCK cell (see the request site). A blank normally
 * short-circuits to the blank slot, and must keep doing so: it is the most common cell on the
 * canvas, and a slot per space-with-these-colours would burn the page for pixels that are pure
 * background. A line decoration is the one thing that makes a blank cell carry ink.
 */
function drawableBlank(code: number): boolean {
  return code === 0x20 || code === 0
}

/** Which code point this cell should draw.
 *
 *  `getCode()` alone is WRONG for a combining sequence: xterm stores the whole sequence in the
 *  cell's string and `getCode()` returns its LAST code point, so "e" + U+0301 would rasterize as
 *  the bare accent — the base letter would vanish off the screen. Taking the string's FIRST code
 *  point instead draws the base character.
 *
 *  TRADEOFF, stated plainly: this renders "é" (decomposed) as "e", dropping the mark. That is the
 *  correct v1 degradation — readable, and never a phantom glyph — but it is a degradation.
 *  Rendering the full grapheme needs the atlas keyed by STRING rather than by code point (so the
 *  rasterizer can draw the whole cluster into one slot), which is Phase 2 atlas work.
 *
 *  `getCode()` remains the fallback for an empty string: a cell can report no chars (a fresh or
 *  reset cell), and its code is then the only thing there is to go on. */
function glyphCode(cell: CellView): number {
  const chars = cell.getChars()
  return chars.length > 0 ? (chars.codePointAt(0) as number) : cell.getCode()
}

/** 0xRRGGBB (xterm's RGB encoding) → an opaque packed lane. */
function rgbLane(v: number): number {
  return packColor((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff, 0xff)
}

/** A palette index outside the theme's 256 entries falls back to the default rather than writing
 *  `undefined` (which a Uint32Array silently stores as 0 = transparent black). */
function paletteLane(theme: ThemeLanes, index: number, fallback: number): number {
  const c = theme.ansi[index]
  return typeof c === 'number' ? c : fallback
}

/** DIM halves the RGB channels and keeps alpha. NOTE: xterm's own renderers dim by drawing the
 *  foreground at 50% OPACITY (blending toward the background); halving the channels blends toward
 *  black instead. The two agree on a dark background and differ on a light one — matching xterm's
 *  blend is Phase 2 work, and needs the resolved bg, so it belongs here when it lands. */
function dimLane(c: number): number {
  return packColor(
    (c & 0xff) >>> 1,
    ((c >>> 8) & 0xff) >>> 1,
    ((c >>> 16) & 0xff) >>> 1,
    (c >>> 24) & 0xff
  )
}

/**
 * How far an UNFOCUSED terminal's selection is blended toward the plate — limitation L3's fix.
 *
 * A fixed factor rather than a colour, because there is no colour to read: `ThemeLanes` carries one
 * selection background, and xterm's own `selectionInactiveBackground` is a theme entry most themes
 * (including nodeterm's) never define. Blending toward the background keeps the hue the theme chose
 * and simply quiets it, which cannot disagree with a theme that never stated an inactive colour.
 * Half-way is enough to read as "not this one" at a glance without making the selection vanish.
 */
const INACTIVE_SELECTION_BLEND = 0.5

/** Blend two packed lanes per channel, `t` of the way from `a` to `b`. Alpha rides along, which is
 *  a no-op for the opaque lanes this feed deals in and correct if one ever is not. */
function blendLane(a: number, b: number, t: number): number {
  const mix = (shift: number): number =>
    Math.round(((a >>> shift) & 0xff) + ((((b >>> shift) & 0xff) - ((a >>> shift) & 0xff)) * t))
  return packColor(mix(0), mix(8), mix(16), mix(24))
}

function resolveFg(cell: CellView, theme: ThemeLanes): number {
  if (cell.isFgPalette()) return paletteLane(theme, cell.getFgColor(), theme.fg)
  if (cell.isFgRGB()) return rgbLane(cell.getFgColor())
  return theme.fg // isFgDefault, and anything unclassifiable
}

function resolveBg(cell: CellView, theme: ThemeLanes): number {
  if (cell.isBgPalette()) return paletteLane(theme, cell.getBgColor(), theme.bg)
  if (cell.isBgRGB()) return rgbLane(cell.getBgColor())
  return theme.bg
}

/** Pack one viewport row into engine lanes. PURE. Row buffer is caller-provided and reused.
 *
 *  ORDER OF RESOLUTION (each step depends on the previous one — do not reorder):
 *    1. resolve fg and bg independently (default / palette / RGB),
 *    2. INVERSE swaps the RESOLVED pair — so "inverse on a palette fg" moves that palette color
 *       into the background, which is what makes inverse composable with any color mode,
 *    3. DIM halves the foreground that step 2 left in place (never the background).
 *  This matches xterm's own renderers, which swap during resolution and apply dim to whatever
 *  foreground came out of it.
 *
 *  BOLD selects the bold glyph variant only — no bright-color promotion, matching modern xterm's
 *  default `drawBoldTextInBrightColors: false`. Making that an option is Phase 2 work.
 *
 *  WIDE / ZERO-WIDTH cells are one mechanism seen from two sides. A double-width glyph occupies
 *  two buffer cells: the lead reports width 2, and the cell right after it reports width 0. The
 *  lead carries the glyph's LEFT half (plus FLAG_WIDE) and the follower its RIGHT half — the same
 *  character, same style, same colors, asked of the atlas as 'wide-right' (see
 *  `GlyphAtlas.glyphFor`).
 *  Carrying the LEAD's colors into the follower is what keeps the background under a wide glyph —
 *  a selection, the cursor, a colored block — one unbroken run instead of two halves that can
 *  disagree. The follower is never skipped: this row buffer is REUSED across frames, so "write
 *  nothing" would leave the previous frame's lanes standing at that column. Every column in
 *  [0, cols) is always written.
 *
 *  THE FOLLOWER USED TO BE BLANK, and that was a real loss, not a simplification: a slot's ink box
 *  is one cell and raster.ts cuts the overflow, so a character the terminal had already reserved
 *  two cells for was rendered as its first cell only. The 2026-08-05 device round is that defect —
 *  ⭐ arriving as a fragment. A stray width-0 cell with NO lead still writes a blank, because there
 *  is no character for it to be the second half of.
 *
 *  THE BLOCK CURSOR REACHES THE FOLLOWER, and that is the fix for limitation L13. The cursor is one
 *  COLUMN and a wide glyph is two, so applying the override to the cursor's column alone painted the
 *  left half of 日 and left the right half un-inverted. A cursor sitting on a wide LEAD therefore
 *  carries into its follower (and nowhere else — not past it, and not into a stray zero-width cell
 *  that follows a narrow one). The follower's slot is keyed on the colours it ends up with, so the
 *  cursor colours reach the right half's PIXELS too — the whole character inverts, ink included.
 *  (When the follower's lane was blank this only reached its background; the right half showed no
 *  ink at all, because there was none anywhere.)
 *
 *  DECORATIONS (a search hit's highlight is one) sit between the cell's own colours and the
 *  selection: they OVERRIDE base/inverse/dim — a hit on coloured output has to be visible — and
 *  LOSE to selection and cursor. That end matters just as much: a highlight that punched a hole in
 *  a drag-selection band, or that swallowed the cursor when it landed on a match, reads as a broken
 *  terminal rather than as a highlight. The whole per-cell lookup is skipped when the terminal has
 *  no decorations at all (the common case), which is what makes an undecorated canvas pay nothing.
 *
 *  CURSOR and SELECTION are applied last, over whatever the cell resolved to. Selection repaints
 *  only the background (the foreground must stay readable as itself); the cursor repaints both.
 *  On overlap the CURSOR WINS the colors, and BOTH flags stay set — the flags describe the cell's
 *  state (this cell is selected AND under the cursor), only the paint has to pick a winner.
 *
 *  An UNFOCUSED terminal's selection is blended toward the plate (`INACTIVE_SELECTION_BLEND`) —
 *  limitation L3. Only the selection: the blurred CURSOR is a shape (xterm's hollow outline), and a
 *  shape is an overlay drawn after the cells, so `focused` changes nothing else in this pass.
 *
 *  THE ATLAS REQUEST IS THE LAST THING THAT HAPPENS, and it has to be. The atlas is keyed by
 *  COLOUR: the rasterizer bakes the requested fg/bg into the slot's pixels and the shader blits
 *  them unmodified, so a slot requested before the overrides is painted in the cell's UNSELECTED,
 *  UNCURSORED colours and renders that way however correct the lanes are. Which code point / bold /
 *  italic to draw is decided in the loop below (it depends on the cell, not on the overrides); the
 *  request itself waits until fg/bg are final. Everything that is NOT a request — the flags, the
 *  wide-cell carry, the blank branches — is unchanged, so the lanes this writes are what they have
 *  always been. */
export function packViewportRow(
  out: Uint32Array,
  readCell: (col: number, into: CellView) => CellView | undefined,
  workCell: CellView,
  opts: RowFeedOpts
): void {
  const { cols, atlas, theme, selection, cursorCol } = opts
  const selStart = selection ? selection[0] : -1
  const selEnd = selection ? selection[1] : -1
  const linkStart = opts.linkUnderline ? opts.linkUnderline[0] : -1
  const linkEnd = opts.linkUnderline ? opts.linkUnderline[1] : -1
  // Only a block is a cell rewrite; every other shape is the overlay pass's business (cursor.ts).
  const blockCursor = (opts.cursorShape ?? 'block') === 'block'
  // Resolved ONCE per row, and only for a row that HAS a selection: the blend is four roundings, and
  // `focused === false` is true of every terminal on the canvas except one — computing it per row
  // regardless would charge a colour nobody paints to every row of every unfocused terminal. The
  // same standard the `decorations` hoist below is written to.
  const selectionBg =
    opts.focused === false && selection
      ? blendLane(theme.selectionBg, theme.bg, INACTIVE_SELECTION_BLEND)
      : theme.selectionBg
  // Hoisted out of the loop: `empty()` is answered ONCE per row rather than once per cell, and a
  // terminal with no decorations leaves this null so the per-cell branch below is a null test.
  const decorations = opts.decorations && !opts.decorations.empty() ? opts.decorations : null
  const bufferRow = opts.bufferRow ?? 0

  // Colors carried from a wide lead into its zero-width follower (see the doc comment).
  let carryPending = false
  let carryFg = 0
  let carryBg = 0
  /** The lead's CHARACTER, carried so the follower can ask the atlas for its right half. Styling
   *  rides along because the half is rasterized from the same face as the lead — a bold emoji's two
   *  halves must come off the same glyph or they meet at a step. */
  let carryCode = 0
  let carryBold = false
  let carryItalic = false
  let carryStrikethrough = false
  /** Was the wide lead we are carrying from the one the BLOCK cursor covers? Separate from the
   *  colour carry because the colours are captured PRE-override and the cursor is applied post — the
   *  follower has to re-apply it, not inherit an already-overridden pair. */
  let carryCursor = false

  for (let col = 0; col < cols; col++) {
    const cell = readCell(col, workCell)
    // Whether the block cursor paints THIS column: its own column, or the follower half of a wide
    // glyph whose lead it covers (set in the width-0 branch below).
    let cursorHere = blockCursor && col === cursorCol
    let fg = theme.fg
    let bg = theme.bg
    let flags = 0
    // What this cell will ask the atlas for, decided here and REQUESTED after the overrides below.
    // 0 is "nothing to draw" — it fails `isRenderableCode`, which is the answer a blank cell and a
    // control code give. A wide glyph's follower does NOT: it adopts the lead's character below.
    let code = 0
    let bold = false
    let italic = false
    /** Which part of `code` this cell draws, and how many cells that character is entitled to.
     *  'whole' unless we are inside a double-width character. */
    let part: GlyphPart = 'whole'
    // Debug-only witnesses, read at the bottom of the loop. -1 distinguishes "no cell" from a cell
    // that reported width 0; `getChars()` is only called when the probe is installed, because it
    // allocates a string per cell and this loop runs for every cell of every packed row.
    let probeWidth = -1
    let probeChars = ''

    if (cell) {
      fg = resolveFg(cell, theme)
      bg = resolveBg(cell, theme)
      if (cell.isInverse()) {
        const swap = fg
        fg = bg
        bg = swap
      }
      if (cell.isDim()) fg = dimLane(fg)

      const width = cell.getWidth()
      if (blankProbe) {
        probeWidth = width
        probeChars = cell.getChars()
      }
      if (width === 0) {
        // Second half of the preceding wide glyph: it draws the LEAD's character, right half, in
        // the lead's colors (a stray width-0 cell with no lead has neither — it stays blank on its
        // own colors, which is still never stale). Underline continuity across a wide glyph is
        // Phase 2, since nothing renders underline yet.
        if (carryPending) {
          fg = carryFg
          bg = carryBg
          // The other half of the character the cursor is on — see the doc comment's L13 note.
          if (carryCursor) cursorHere = true
          // The lane that used to be 0 here. A double-width character's ink is cut at one cell
          // (raster.ts), so leaving this blank threw its right half away — the 2026-08-05 ⭐
          // report. The two cells the terminal reserved for this character now hold its two halves.
          code = carryCode
          bold = carryBold
          italic = carryItalic
          // Unlike underline (still Phase 2), a strikethrough IS carried: a struck double-width
          // character with only its left half crossed out reads as two different characters.
          if (carryStrikethrough) flags |= FLAG_STRIKETHROUGH
          part = 'wide-right'
        }
        carryPending = false
        carryCursor = false
      } else {
        bold = cell.isBold() !== 0
        italic = cell.isItalic() !== 0
        // The guard runs on the DERIVED code: a string can start with a lone surrogate just as
        // easily as getCode() can return one, and the rasterizer must never see either.
        code = glyphCode(cell)
        if (bold) flags |= FLAG_BOLD
        if (italic) flags |= FLAG_ITALIC
        if (cell.isUnderline() !== 0) flags |= FLAG_UNDERLINE
        if (cell.isStrikethrough() !== 0) flags |= FLAG_STRIKETHROUGH
        if (width === 2) {
          flags |= FLAG_WIDE
          // The LEFT half of a two-cell character, which is a different request from 'whole' even
          // though both draw from the character's left edge: this one is allowed to spread over two
          // cells, so the rasterizer must not shrink it to fit one.
          part = 'wide-left'
          carryPending = true
          // The lead's RESOLVED colors, captured before the selection/decoration overrides on
          // purpose: those are decided per COLUMN, so the follower applies whichever ones cover IT.
          // The CURSOR is the one exception, carried explicitly — a block on a wide glyph covers
          // the whole character (L13), which a per-column rule alone cannot express.
          carryFg = fg
          carryBg = bg
          carryCursor = cursorHere
          carryCode = code
          carryBold = bold
          carryItalic = italic
          carryStrikethrough = (flags & FLAG_STRIKETHROUGH) !== 0
        } else {
          carryPending = false
          carryCursor = false
        }
      }
    } else {
      // Past the end of a short line (or no line at all): a blank cell on the theme background.
      carryPending = false
      carryCursor = false
    }

    // Over the cell's own colours (base/inverse/dim), under the selection and the cursor below.
    if (decorations) {
      const deco = decorationAt(decorations, col, bufferRow)
      if (deco) {
        if (deco.bg !== undefined) bg = deco.bg
        if (deco.fg !== undefined) fg = deco.fg
      }
    }

    // The hovered link's underline, ORed in rather than assigned: a link drawn over text that is
    // ALREADY underlined stays underlined, and hovering it must not be able to turn one off.
    if (col >= linkStart && col < linkEnd) flags |= FLAG_UNDERLINE
    if (col >= selStart && col < selEnd) {
      bg = selectionBg
      flags |= FLAG_SELECTED
    }
    if (cursorHere) {
      fg = theme.cursorFg
      bg = theme.cursorBg
      flags |= FLAG_CURSOR
    }

    // fg/bg are FINAL here — this is the only place the atlas may be asked, see the doc comment.
    //
    // An UNDERLINED cell is asked for even when its code is not renderable on its own. The rule is
    // an underline runs UNDER THE WHOLE RUN, spaces included (`\e[4munder line\e[0m`, and every
    // hovered URL with a space in it): skipping the blanks would break one rule into dashes at each
    // word gap. `isRenderableCode` still guards the CRASH cases — a lone surrogate or a control
    // code is refused whatever its underline says — so this only widens it to the blanks the atlas
    // knows how to answer.
    //
    // A strikethrough follows the same rule for the same reason: a struck run crosses its spaces.
    const underlined = (flags & FLAG_UNDERLINE) !== 0
    const struck = (flags & FLAG_STRIKETHROUGH) !== 0
    const wantsSlot = isRenderableCode(code) || ((underlined || struck) && drawableBlank(code))
    const glyph = wantsSlot ? atlas.glyphFor(code, bold, italic, fg, bg, part, underlined, struck) : 0
    // A cell that HOLDS something and still draws nothing is the defect under investigation. A
    // space is excluded because that is the correct answer for it, not a loss.
    if (blankProbe && glyph === 0 && probeChars !== '' && probeChars !== ' ') {
      blankProbe({ col, row: bufferRow, width: probeWidth, code, chars: probeChars })
    }
    writeCell(out, col, glyph, fg, bg, flags)
  }
}
