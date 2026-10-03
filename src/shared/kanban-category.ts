/**
 * Column lifecycle categories — what a column MEANS, independent of what it is called.
 *
 * A board's columns are free-form ("Backlog", "Review", "Shipped"), so nothing could tell which of
 * them hold finished work. The optional `KanbanColumn.category` says it once, per column, and three
 * things read it: the board's progress (`boardProgress`), hiding `closed` columns behind a toggle,
 * and the default GitHub completion column (`defaultCompletionColumnId`).
 *
 * It lives in `shared` because the board is git-shared content read by the renderer, the core (the
 * relay's board verbs seed the default board) and — across the repo boundary — the phone, which
 * must at least tolerate the field.
 *
 * **Every reader goes through `columnCategory`.** The value comes from a hand-editable, git-shared
 * file, so a stored string outside the closed set (a typo, or a category a NEWER build added) reads
 * as ABSENT rather than being trusted, and a non-string never reaches a comparison. The value
 * itself is left in the file: dropping an unknown string on save would erase a newer build's data
 * from the shared file the moment an older teammate saved.
 */
import type { KanbanColumn, KanbanColumnCategory, ProjectKanban } from './types'

/** The closed set, in lifecycle order (the order the column menu lists them). */
export const KANBAN_COLUMN_CATEGORIES: readonly KanbanColumnCategory[] = [
  'unstarted',
  'started',
  'done',
  'closed'
]

/** Menu / chip wording for each category. */
export const CATEGORY_LABELS: Readonly<Record<KanbanColumnCategory, string>> = {
  unstarted: 'Not started',
  started: 'Started',
  done: 'Done',
  closed: 'Closed'
}

const KNOWN = new Set<string>(KANBAN_COLUMN_CATEGORIES)

/** The column's category, or undefined when absent, unknown or not a string. Never throws. */
export function columnCategory(
  col: Pick<KanbanColumn, 'category'> | { category?: unknown } | undefined | null
): KanbanColumnCategory | undefined {
  const c = (col as { category?: unknown } | undefined | null)?.category
  return typeof c === 'string' && KNOWN.has(c) ? (c as KanbanColumnCategory) : undefined
}

/** `done` and `closed` both mean "no work left here" — the numerator of the board's progress. */
export function isCompletedCategory(c: KanbanColumnCategory | undefined): boolean {
  return c === 'done' || c === 'closed'
}

/**
 * The board's progress: live cards sitting in a `done`/`closed` column over EVERY live card
 * (Ungrouped included — an unfiled card is unfinished work, not work that does not exist).
 *
 * Null when it would be meaningless: no column carries a completed category (the board has not
 * said what "complete" means, so any number would be invented), or there are no cards (0/0).
 * A dangling assignment (its column deleted elsewhere) is Ungrouped, as everywhere on the board.
 */
export function boardProgress(
  k: ProjectKanban,
  liveIds: readonly string[]
): { complete: number; total: number } | null {
  const completedCols = new Set(
    k.columns.filter((c) => isCompletedCategory(columnCategory(c))).map((c) => c.id)
  )
  if (completedCols.size === 0 || liveIds.length === 0) return null
  const live = new Set(liveIds)
  const complete = new Set(
    k.assignments
      .filter((a) => live.has(a?.nodeId) && completedCols.has(a.columnId))
      .map((a) => a.nodeId)
  ).size
  return { complete, total: live.size }
}

/**
 * The column a GitHub issue should close into by default: the first `done` column, else the first
 * `closed` one, else the LAST column — which is what the default was before categories existed, so
 * an uncategorized board keeps exactly its old behaviour.
 */
export function defaultCompletionColumnId(
  columns: ReadonlyArray<Pick<KanbanColumn, 'id' | 'category'>>
): string | undefined {
  return (
    columns.find((c) => columnCategory(c) === 'done')?.id ??
    columns.find((c) => columnCategory(c) === 'closed')?.id ??
    columns.at(-1)?.id
  )
}

/**
 * What changing a column's category would do to the cards already in it — or null when it would
 * do nothing (unknown column, no live cards in it, or no actual change).
 *
 * A category is not a label on the column, it is a claim about every card in it: moving "Review"
 * from `started` to `done` silently counts its cards as finished, and moving a column to `closed`
 * can hide its cards behind the "show closed" toggle. So the board refuses to do either SILENTLY:
 * a non-null answer means the UI must confirm, naming the count. An empty column changes freely.
 */
export function categoryChangeImpact(
  k: ProjectKanban,
  columnId: string,
  next: KanbanColumnCategory | undefined,
  liveIds: readonly string[]
): { cards: number; from: KanbanColumnCategory | undefined; to: KanbanColumnCategory | undefined } | null {
  const column = k.columns.find((c) => c.id === columnId)
  if (!column) return null
  const from = columnCategory(column)
  const to = columnCategory({ category: next })
  if (from === to) return null
  const live = new Set(liveIds)
  const cards = new Set(
    k.assignments.filter((a) => a?.columnId === columnId && live.has(a.nodeId)).map((a) => a.nodeId)
  ).size
  return cards > 0 ? { cards, from, to } : null
}

/**
 * The confirmation sentence for a category change that would re-mean cards (`categoryChangeImpact`
 * answered non-null). It names the column, the before/after and the COUNT, then the consequence
 * the user cannot see from the menu: the progress numerator moving, or the cards leaving view
 * when the column becomes `closed` while this user hides closed columns.
 */
export function categoryChangeMessage(
  title: string,
  impact: { cards: number; from: KanbanColumnCategory | undefined; to: KanbanColumnCategory | undefined },
  closedHidden: boolean
): string {
  const name = (c: KanbanColumnCategory | undefined): string => (c ? CATEGORY_LABELS[c] : 'No category')
  const n = `${impact.cards} card${impact.cards === 1 ? '' : 's'}`
  const head = `Change "${title}" from ${name(impact.from)} to ${name(impact.to)}?`
  const wasDone = isCompletedCategory(impact.from)
  const nowDone = isCompletedCategory(impact.to)
  const effects: string[] = []
  if (nowDone && !wasDone) effects.push(`Its ${n} will count as finished in the board's progress.`)
  else if (wasDone && !nowDone) effects.push(`Its ${n} will no longer count as finished.`)
  else effects.push(`This changes what the column means for its ${n}.`)
  if (impact.to === 'closed' && closedHidden) {
    effects.push('Closed columns are hidden on your board, so the column and its cards will leave view.')
  }
  return [head, ...effects].join(' ')
}
