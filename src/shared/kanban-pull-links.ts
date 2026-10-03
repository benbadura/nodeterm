// How pull requests relate to session cards, and what may move a card when they merge.
//
// Two stores, split by audience on purpose:
//
//  - `ProjectKanban.pullLinks` — GIT-SHARED board content (it rides `.nodeterm/project.json` with
//    the rest of the board). It holds only statements about CARDS that a teammate should see the
//    same way: "this card is not about PR #12" (a tombstone, so a branch auto-link never comes
//    back) and "never auto-move this card". Hostile input: every reader goes through
//    `readPullLinks`, which drops anything malformed rather than trusting it.
//
//    It is a board-level field, not a new field on `meta[]` entries, because every card-meta setter
//    (`toggleAssignee`, `setCardDue`, the label transforms, the phone's label verb and its Swift
//    twin) rebuilds an entry from a fixed list of known fields — a field added there would be
//    silently erased the next time someone assigned a member. Board-level keys survive every
//    transform, which all spread `...k`.
//
//  - `Settings.kanbanPullAutoMove` — MACHINE-LOCAL (settings.json), keyed by project id. Turning
//    the auto-move on makes THIS machine write the shared board on its own, whenever a merge is
//    observed. If the switch lived in the project file, cloning or pulling a repository would make
//    every teammate's app start moving cards (and committing those moves) without anyone on that
//    machine having asked for it — so it is off unless this machine turns it on. It is written
//    ONLY by the user's own Settings action: what this machine has observed about each PR lives in
//    core (core/github/pull-memory.ts), because a background settings write from a second Server
//    Edition tab would overwrite whatever the user just changed in the first.
import type { ProjectKanban } from './types'

export interface KanbanPullLinks {
  /** Card ↔ PR links the user removed. A branch auto-link never re-adds one. */
  unlinked?: Array<{ nodeId: string; pull: number }>
  /** Cards that never auto-move, whatever their PRs do. */
  noAutoMove?: string[]
}

const MAX_ENTRIES = 2_000

function nodeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function pullNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** The links block, tolerant of anything a hand-edited or hostile file puts there. */
export function readPullLinks(board: ProjectKanban | undefined): {
  unlinked: Array<{ nodeId: string; pull: number }>
  noAutoMove: string[]
} {
  const raw = board?.pullLinks as unknown
  const value = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const unlinked = Array.isArray(value.unlinked)
    ? value.unlinked.slice(0, MAX_ENTRIES).flatMap((entry) => {
      const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null
      return item && nodeId(item.nodeId) && pullNumber(item.pull)
        ? [{ nodeId: item.nodeId, pull: item.pull }]
        : []
    })
    : []
  const noAutoMove = Array.isArray(value.noAutoMove)
    ? [...new Set(value.noAutoMove.slice(0, MAX_ENTRIES).filter(nodeId))]
    : []
  return { unlinked, noAutoMove }
}

/** Writes the two lists back. Any OTHER key already in the block — one a newer build added — rides
 *  along untouched: the file is shared with builds this one cannot know about, and a write here
 *  must not erase what they stored. */
function withPullLinks(
  board: ProjectKanban,
  next: { unlinked: Array<{ nodeId: string; pull: number }>; noAutoMove: string[] }
): ProjectKanban {
  const { pullLinks: previous, ...bare } = board
  const others = previous && typeof previous === 'object' && !Array.isArray(previous)
    ? Object.fromEntries(Object.entries(previous as Record<string, unknown>)
      .filter(([key]) => key !== 'unlinked' && key !== 'noAutoMove'))
    : {}
  const links = {
    ...others,
    ...(next.unlinked.length ? { unlinked: next.unlinked } : {}),
    ...(next.noAutoMove.length ? { noAutoMove: next.noAutoMove } : {})
  } as KanbanPullLinks
  return Object.keys(links).length ? { ...bare, pullLinks: links } : bare
}

export function isPullUnlinked(board: ProjectKanban | undefined, cardId: string, pull: number): boolean {
  return readPullLinks(board).unlinked.some((entry) => entry.nodeId === cardId && entry.pull === pull)
}

export function unlinkPull(board: ProjectKanban, cardId: string, pull: number): ProjectKanban {
  const links = readPullLinks(board)
  if (links.unlinked.some((entry) => entry.nodeId === cardId && entry.pull === pull)) return board
  return withPullLinks(board, { ...links, unlinked: [...links.unlinked, { nodeId: cardId, pull }] })
}

export function relinkPull(board: ProjectKanban, cardId: string, pull: number): ProjectKanban {
  const links = readPullLinks(board)
  const unlinked = links.unlinked.filter((entry) => !(entry.nodeId === cardId && entry.pull === pull))
  return unlinked.length === links.unlinked.length ? board : withPullLinks(board, { ...links, unlinked })
}

export function setNoAutoMove(board: ProjectKanban, cardId: string, optedOut: boolean): ProjectKanban {
  const links = readPullLinks(board)
  const has = links.noAutoMove.includes(cardId)
  if (has === optedOut) return board
  return withPullLinks(board, {
    ...links,
    noAutoMove: optedOut ? [...links.noAutoMove, cardId] : links.noAutoMove.filter((id) => id !== cardId)
  })
}

/** Drops entries for cards that no longer exist. Returns the SAME object when nothing changed. */
export function prunePullLinks(board: ProjectKanban, live: ReadonlySet<string>): ProjectKanban {
  if (board.pullLinks === undefined) return board
  const links = readPullLinks(board)
  const unlinked = links.unlinked.filter((entry) => live.has(entry.nodeId))
  const noAutoMove = links.noAutoMove.filter((id) => live.has(id))
  if (unlinked.length === links.unlinked.length && noAutoMove.length === links.noAutoMove.length) {
    return board
  }
  return withPullLinks(board, { unlinked, noAutoMove })
}

// ── Machine-local switch ────────────────────────────────────────────────────────────────────────

export interface KanbanPullAutoMoveEntry {
  /** The column cards move to. A column deleted since then means no move, not a guess. */
  columnId: string
  /** When this machine switched it on (epoch ms). Only merges observed AFTER this count, so turning
   *  the switch on never sweeps cards whose PRs merged earlier. */
  armedAt: number
}

export interface KanbanPullAutoMove {
  projects: Record<string, KanbanPullAutoMoveEntry>
}

/** settings.json is hand-editable: read it through this, never directly. An entry without a valid
 *  `armedAt` is OFF — a guessed arming time would decide which past merges count. */
export function sanitizeKanbanPullAutoMove(raw: unknown): KanbanPullAutoMove {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const projects = value.projects && typeof value.projects === 'object' && !Array.isArray(value.projects)
    ? value.projects as Record<string, unknown>
    : {}
  const out: Record<string, KanbanPullAutoMoveEntry> = {}
  for (const [projectId, entryRaw] of Object.entries(projects).slice(0, 500)) {
    const entry = entryRaw && typeof entryRaw === 'object' ? entryRaw as Record<string, unknown> : null
    if (!nodeId(projectId) || !entry || !nodeId(entry.columnId)) continue
    const armedAt = entry.armedAt
    if (typeof armedAt !== 'number' || !Number.isSafeInteger(armedAt) || armedAt < 0) continue
    out[projectId] = { columnId: entry.columnId, armedAt }
  }
  return { projects: out }
}

/** Drops projects this machine no longer has (closed projects are kept: closing parks, it does
 *  not delete). Settings.json is forever, so a switch keyed to a vanished id must not linger. */
export function prunePullAutoMove(value: KanbanPullAutoMove, liveProjectIds: ReadonlySet<string>): KanbanPullAutoMove {
  const projects = Object.fromEntries(Object.entries(value.projects).filter(([id]) => liveProjectIds.has(id)))
  return { projects }
}
