import type { BoardLogEvent, KanbanCardMeta, ProjectKanban } from '@shared/types'
import { cardAssignees } from '@shared/kanban-labels'

// Pure prev→next board diff → the events worth recording in the board log. No fs, no IPC:
// the caller computes the next board (renderer/lib/kanban.ts) and asks here what changed.
// Column names are resolved at event time; the virtual (unassigned) column is 'Ungrouped'.

const UNGROUPED = 'Ungrouped'

/** Board events implied by a prev→next board change. Column names resolved at event time;
 *  the virtual column is named 'Ungrouped'. Pure; returns [] when nothing loggable changed.
 *
 *  BINDING INVARIANT — `cardTitle` MUST return '' for, and ONLY for, a nodeId whose node no
 *  longer exists: a removed assignment with an empty title is read as a prune (not a move) and
 *  suppressed. A LIVE node with an empty title must map to a non-empty placeholder ('Untitled'),
 *  never '' — otherwise moving/removing an untitled card would be silently dropped. */
export function boardLogEvents(
  prev: ProjectKanban,
  next: ProjectKanban,
  cardTitle: (nodeId: string) => string
): Array<{ nodeId?: string; event: BoardLogEvent }> {
  const out: Array<{ nodeId?: string; event: BoardLogEvent }> = []
  const prevCols = new Map(prev.columns.map((c) => [c.id, c.title]))
  const nextCols = new Map(next.columns.map((c) => [c.id, c.title]))

  // Column added / renamed, in next order.
  for (const c of next.columns) {
    const old = prevCols.get(c.id)
    if (old === undefined) out.push({ event: { type: 'column-added', title: c.title } })
    else if (old !== c.title) out.push({ event: { type: 'column-renamed', from: old, to: c.title } })
  }
  // Column deleted — records ONLY column-deleted; the per-card "moved to Ungrouped" noise that
  // deleteColumn produces (it drops the column's assignments too) is suppressed below.
  const deleted = new Set<string>()
  for (const c of prev.columns) {
    if (!nextCols.has(c.id)) {
      deleted.add(c.id)
      out.push({ event: { type: 'column-deleted', title: c.title } })
    }
  }

  const prevA = new Map(prev.assignments.map((a) => [a.nodeId, a.columnId]))
  const nextA = new Map(next.assignments.map((a) => [a.nodeId, a.columnId]))
  const nodeIds: string[] = []
  const seen = new Set<string>()
  for (const a of [...prev.assignments, ...next.assignments]) {
    if (!seen.has(a.nodeId)) {
      seen.add(a.nodeId)
      nodeIds.push(a.nodeId)
    }
  }

  for (const nodeId of nodeIds) {
    const pc = prevA.get(nodeId)
    const nc = nextA.get(nodeId)
    if (pc === nc) continue // unchanged, or same column with only an intra-column reorder
    const fromName = pc === undefined ? UNGROUPED : prevCols.get(pc) ?? UNGROUPED
    const toName = nc === undefined ? UNGROUPED : nextCols.get(nc) ?? UNGROUPED
    if (nc === undefined) {
      if (pc !== undefined && deleted.has(pc)) continue // column deleted → not a move
      if (!cardTitle(nodeId)) continue // node no longer exists (pruneAssignments) → not a move
    }
    out.push({ nodeId, event: { type: 'card-moved', from: fromName, to: toName } })
  }
  // Card metadata: assignee add/remove (per person, matched by name) and due set/change/clear.
  // A dead node's meta disappearing is the prune path — suppressed via the same cardTitle guard.
  const metaOf = (k: ProjectKanban): Map<string, KanbanCardMeta> => {
    const m = new Map<string, KanbanCardMeta>()
    if (Array.isArray(k.meta)) for (const e of k.meta) if (e?.nodeId) m.set(e.nodeId, e)
    return m
  }
  const prevM = metaOf(prev)
  const nextM = metaOf(next)
  const metaIds: string[] = []
  const seenM = new Set<string>()
  for (const id of [...prevM.keys(), ...nextM.keys()]) {
    if (!seenM.has(id)) {
      seenM.add(id)
      metaIds.push(id)
    }
  }
  for (const nodeId of metaIds) {
    const pm = prevM.get(nodeId)
    const nm = nextM.get(nodeId)
    if (!nm && !cardTitle(nodeId)) continue // node gone (prune) → nothing to narrate
    const pa = cardAssignees(pm)
    const na = cardAssignees(nm)
    for (const a of na) if (!pa.some((x) => x.name === a.name))
      out.push({ nodeId, event: { type: 'member-assigned', to: a.name } })
    for (const a of pa) if (!na.some((x) => x.name === a.name))
      out.push({ nodeId, event: { type: 'member-unassigned', to: a.name } })
    const pd = pm?.dueAt
    const nd = nm?.dueAt
    if (pd !== nd) {
      if (nd !== undefined) out.push({ nodeId, event: { type: 'due-set', to: new Date(nd).toISOString() } })
      else out.push({ nodeId, event: { type: 'due-cleared' } })
    }
    const pp = pm?.priority
    const np = nm?.priority
    if (pp !== np) {
      if (np !== undefined) out.push({ nodeId, event: { type: 'priority-set', to: np } })
      else out.push({ nodeId, event: { type: 'priority-cleared' } })
    }
  }

  return out
}
