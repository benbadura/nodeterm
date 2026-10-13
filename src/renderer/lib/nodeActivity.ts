import { normalizeNodeTimestamp } from '@shared/node-timestamps'
import type { CanvasNode } from '../state/workspace'

type ActivityListener = (id: string, at: number) => void
const listeners = new Set<ActivityListener>()
const flushers = new Set<() => void>()

export function recordNodeActivity(id: string, at = Date.now()): void {
  if (!id || normalizeNodeTimestamp(at) === undefined) return
  for (const listener of listeners) listener(id, at)
}

/** A fixed window (not a trailing debounce): continuous output still advances the date. */
export function subscribeNodeActivityBatch(
  onBatch: (activity: ReadonlyMap<string, number>) => void,
  delay = 1000
): () => void {
  let pending = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!pending.size) return
    const batch = pending
    pending = new Map()
    onBatch(batch)
  }
  const onActivity: ActivityListener = (id, at) => {
    pending.set(id, Math.max(at, pending.get(id) ?? 0))
    timer ??= setTimeout(flush, delay)
  }
  listeners.add(onActivity)
  flushers.add(flush)
  return () => {
    flush()
    listeners.delete(onActivity)
    flushers.delete(flush)
  }
}

/** Drain before saving or switching projects, so the last second of work is persisted too. */
export function flushNodeActivities(): void {
  for (const flush of flushers) flush()
}

export function stampNodeActivities(nodes: CanvasNode[], activity: ReadonlyMap<string, number>): CanvasNode[] {
  let changed = false
  const next = nodes.map((node) => {
    const at = activity.get(node.id)
    if (at === undefined || at <= (normalizeNodeTimestamp(node.data.lastActivityAt) ?? 0)) return node
    changed = true
    return { ...node, data: { ...node.data, lastActivityAt: at } }
  })
  return changed ? next : nodes
}

/** Selection and layout measurements are not work; user moves and content edits are. */
export function nodeActivityChanged(before: CanvasNode, after: CanvasNode): boolean {
  // A peer already stamped this edit. Do not turn it into another local clock update.
  if (before.data.lastActivityAt !== after.data.lastActivityAt) return false
  if (before.position.x !== after.position.x || before.position.y !== after.position.y ||
      before.width !== after.width || before.height !== after.height || before.parentId !== after.parentId) return true
  if (before.data === after.data) return false
  const ignored = new Set(['createdAt', 'lastActivityAt', 'expandedHeight', 'ghost'])
  return [...new Set([...Object.keys(before.data), ...Object.keys(after.data)])]
    .some((key) => !ignored.has(key) && !Object.is(before.data[key], after.data[key]))
}
