/**
 * Pure keyboard navigation over the kanban board: the order a J/K/arrow press walks, and which
 * focused controls own a key the board must therefore leave alone.
 */
import type { BoardKeyAction } from './boardKeys'

/** The neighbour of `current` in board order (`dir` 1 = next, -1 = previous), or null at an end
 *  or when `current` is not on the board. */
export function stepCard(order: readonly string[], current: string, dir: 1 | -1): string | null {
  const i = order.indexOf(current)
  if (i === -1) return null
  return order[i + dir] ?? null
}

/** The card in the nearest NON-EMPTY column to the left/right of `current`, on the same row
 *  (clamped to that column's length). Null at the board's edge. */
export function columnStep(
  columns: ReadonlyArray<readonly string[]>,
  current: string,
  dir: 1 | -1
): string | null {
  const col = columns.findIndex((c) => c.includes(current))
  if (col === -1) return null
  const row = columns[col].indexOf(current)
  for (let c = col + dir; c >= 0 && c < columns.length; c += dir) {
    const cards = columns[c]
    if (cards.length) return cards[Math.min(row, cards.length - 1)]
  }
  return null
}

/** ARIA composite widgets use arrows AND letters (type-ahead) for their own navigation. */
const COMPOSITE_ROLES = new Set([
  'listbox', 'option', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'slider', 'spinbutton', 'tab', 'tablist', 'radio', 'radiogroup', 'combobox', 'grid', 'gridcell',
  'tree', 'treeitem', 'treegrid'
])
/** Controls that a Space press ACTIVATES natively. */
const SPACE_ACTIVATED = new Set(['BUTTON', 'A', 'SUMMARY', 'INPUT'])

/**
 * Does the focused element use this key itself? Then the board declines and the key reaches it.
 * (Text surfaces never get here: the registry refuses every board command while typing.)
 *  - a `<select>` owns everything: arrows change its value, letters type-ahead;
 *  - an ARIA composite widget owns everything, for the same reasons;
 *  - a button, link, summary or checkbox owns Space — the key that presses it.
 * A card itself owns nothing: it is what the board's keys are for — but a button inside a card is a
 * button.
 */
export function keyOwnedByControl(el: Element | null, action: BoardKeyAction): boolean {
  if (!el) return false
  // Only the CARD itself owns nothing. A control INSIDE a card (the context meter, a chip) is still
  // that control: Space presses it rather than opening the card behind it.
  if (el.getAttribute?.('data-kanban-card') != null) return false
  if (el.tagName === 'SELECT') return true
  const role = el.getAttribute?.('role')
  if (role && COMPOSITE_ROLES.has(role)) return true
  if (action === 'open') {
    return SPACE_ACTIVATED.has(el.tagName) || role === 'button' || role === 'checkbox' || role === 'switch'
  }
  return false
}
