/**
 * ⌘K palette filtering + ranking (pure).
 *
 * The palette used to FILTER only: a case-insensitive subsequence match over label+hint, kept in
 * declaration order and cut at the display cap. Actions are declared before the "Go to <node>"
 * rows, and their keyword-rich hints ("orchestrate parallelize delegate…") subsequence-match
 * almost any short query — so typing "SEO" filled the cap with actions that merely contain an s,
 * an e and an o, and the node actually TITLED "… SEO …" was cut off. Ranking before the cap is
 * the fix: a contiguous hit in the label beats a scattered one, wherever the row was declared.
 */

export interface PaletteSearchable {
  label: string
  hint?: string
  section?: string
  /** Body text (e.g. a terminal's visible output) — matched by substring only. */
  content?: string
}

/** Case-insensitive subsequence match — "ntr" matches "New TeRminal". */
export function subsequenceMatch(text: string, q: string): boolean {
  if (!q) return true
  const s = text.toLowerCase()
  let i = 0
  for (const ch of q.toLowerCase()) {
    i = s.indexOf(ch, i)
    if (i === -1) return false
    i++
  }
  return true
}

export function labelHit(c: PaletteSearchable, q: string): boolean {
  return subsequenceMatch(`${c.label} ${c.hint ?? ''}`, q)
}

export function contentHit(c: PaletteSearchable, q: string): boolean {
  return q.length >= 2 && !!c.content && c.content.toLowerCase().includes(q.toLowerCase())
}

const isWordStart = (s: string, i: number): boolean => i === 0 || /[^\p{L}\p{N}]/u.test(s[i - 1])

/**
 * Lower = better; `null` = no match. Tiers, best first: label substring at a word start, label
 * substring anywhere, hint substring, label subsequence, label+hint subsequence, output content.
 */
export function paletteScore(c: PaletteSearchable, q: string): number | null {
  const query = q.trim().toLowerCase()
  if (!query) return 0
  const label = c.label.toLowerCase()
  let at = label.indexOf(query)
  while (at !== -1) {
    if (isWordStart(label, at)) return 0
    at = label.indexOf(query, at + 1)
  }
  if (label.includes(query)) return 1
  if ((c.hint ?? '').toLowerCase().includes(query)) return 2
  if (subsequenceMatch(c.label, query)) return 3
  if (labelHit(c, query)) return 4
  if (contentHit(c, query)) return 5
  return null
}

/**
 * Matching commands, best first, capped at `limit`. Rows keep their declaration order within a
 * tier, and rows of one section stay together (the palette prints a header on every section
 * change) — sections are ordered by their best row. An empty query returns the input order.
 */
export function rankPaletteCommands<T extends PaletteSearchable>(
  commands: T[],
  q: string,
  limit: number
): T[] {
  if (!q.trim()) return commands.slice(0, limit)
  const scored: { c: T; score: number; idx: number }[] = []
  commands.forEach((c, idx) => {
    const score = paletteScore(c, q)
    if (score !== null) scored.push({ c, score, idx })
  })
  scored.sort((a, b) => a.score - b.score || a.idx - b.idx)
  const top = scored.slice(0, limit)
  const sectionRank = new Map<string, number>()
  top.forEach((r, i) => {
    const key = r.c.section ?? ''
    if (!sectionRank.has(key)) sectionRank.set(key, i)
  })
  return top
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        sectionRank.get(a.r.c.section ?? '')! - sectionRank.get(b.r.c.section ?? '')! || a.i - b.i
    )
    .map(({ r }) => r.c)
}
