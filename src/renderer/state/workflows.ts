import { useCallback, useSyncExternalStore } from 'react'
import type { WorkflowsApi, WorkflowRun } from '@shared/workflows'

const EMPTY: WorkflowRun[] = []
type Entry = { runs: WorkflowRun[]; listeners: Set<() => void>; revision: number }
const stores = new WeakMap<WorkflowsApi, { entries: Map<string, Entry>; off?: () => void }>()

/** One event listener per host API, one initial read per visible project. No relay history leaks. */
export function useWorkflowRuns(api: WorkflowsApi | undefined, projectId: string): WorkflowRun[] {
  const subscribe = useCallback((listener: () => void) => {
    if (!api) return () => {}
    let store = stores.get(api)
    if (!store) { store = { entries: new Map() }; stores.set(api, store) }
    let entry = store.entries.get(projectId)
    if (!entry) { entry = { runs: EMPTY, listeners: new Set(), revision: 0 }; store.entries.set(projectId, entry) }
    const first = entry.listeners.size === 0
    entry.listeners.add(listener)
    if (!store.off) store.off = api.onChanged((id, runs) => {
      const e = store!.entries.get(id)
      if (!e) return
      e.runs = runs; e.revision++
      e.listeners.forEach(fn => fn())
    })
    if (first) {
      const revision = entry.revision
      void api.list(projectId).then(runs => {
        if (entry!.revision !== revision || !entry!.listeners.size) return
        entry!.runs = runs; entry!.listeners.forEach(fn => fn())
      }).catch(() => {})
    }
    return () => {
      entry!.listeners.delete(listener)
      if ([...store!.entries.values()].every(e => !e.listeners.size)) { store!.off?.(); store!.off = undefined }
    }
  }, [api, projectId])
  const snapshot = useCallback(() => api ? stores.get(api)?.entries.get(projectId)?.runs ?? EMPTY : EMPTY, [api, projectId])
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY)
}
