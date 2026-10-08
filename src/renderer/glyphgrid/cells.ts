/** One cell = CELL_STRIDE uint32 lanes: [glyph slot, fg RGBA8, bg RGBA8, flags]. This exact
 *  layout is what gl-webgl2.ts binds as instanced vertex attributes — change both together. */
export const CELL_STRIDE = 4

export const FLAG_BOLD = 1
export const FLAG_ITALIC = 2
export const FLAG_UNDERLINE = 4
export const FLAG_CURSOR = 8
export const FLAG_WIDE = 16
export const FLAG_SELECTED = 32
export const FLAG_STRIKETHROUGH = 64

/** RGBA8 packed little-endian style: r in the low byte (matches UNSIGNED_BYTE attr upload).
 *  The trailing `>>> 0` is load-bearing, not cosmetic: `0xff << 24` is NEGATIVE in JS, so
 *  without it every color with alpha >= 128 packs to a signed int while readCell() returns the
 *  buffer's unsigned lane — `readCell(buf, i).fg !== packColor(...)` for the very same color,
 *  which silently defeats any dirty-check written the obvious way. Bytes are identical either
 *  way (Uint32Array assignment does ToUint32); only the JS sign changes. */
export function packColor(r: number, g: number, b: number, a: number): number {
  return (((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff)) >>> 0
}

export function unpackColor(c: number): { r: number; g: number; b: number; a: number } {
  return { r: c & 0xff, g: (c >>> 8) & 0xff, b: (c >>> 16) & 0xff, a: (c >>> 24) & 0xff }
}

export function writeCell(
  buf: Uint32Array,
  cellIndex: number,
  glyph: number,
  fg: number,
  bg: number,
  flags: number
): void {
  const o = cellIndex * CELL_STRIDE
  buf[o] = glyph >>> 0
  buf[o + 1] = fg >>> 0
  buf[o + 2] = bg >>> 0
  buf[o + 3] = flags >>> 0
}

export function readCell(
  buf: Uint32Array,
  cellIndex: number
): { glyph: number; fg: number; bg: number; flags: number } {
  const o = cellIndex * CELL_STRIDE
  return { glyph: buf[o], fg: buf[o + 1], bg: buf[o + 2], flags: buf[o + 3] }
}
