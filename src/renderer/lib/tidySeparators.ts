import type { MenuItem } from '../components/ContextMenu'

/** Drop the separators a hidden row leaves dangling: the menu's rules are written between blocks,
 *  so hiding every row of a block would otherwise emit two rules in a row (or one hanging at the
 *  top / bottom). Also drops a rule directly under a section label, which reads as a double line.
 *  Cheap and total, so the builders can stay plain array literals instead of tracking what is left. */
export const tidySeparators = (items: MenuItem[]): MenuItem[] =>
  items
    .filter((item, i, all) => {
      if (item.type !== 'separator') return true
      const prev = all[i - 1]
      return !!prev && prev.type !== 'separator' && prev.type !== 'label'
    })
    .filter((item, i, all) => item.type !== 'separator' || i < all.length - 1)
