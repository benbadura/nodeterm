import { create } from 'zustand'
import { useEffect, useRef } from 'react'
import type { ReadinessApi, ReadinessView } from '@shared/task-readiness'

interface Entry { view?: ReadinessView; error?: string; unsupported?: boolean }
interface State {
  byKey: Record<string, Entry>
  requestedNode: string | null
  request(nodeId: string): void
  clearRequest(): void
  load(api: ReadinessApi, projectId: string, nodeId: string): Promise<void>
}
const keyFor = (p: string, n: string): string => JSON.stringify([p, n])
const EMPTY: Entry = {}
const flights = new Map<string, Promise<void>>()
export const useTaskReadiness = create<State>((set) => ({
  byKey: {}, requestedNode: null,
  request: (nodeId) => set({ requestedNode: nodeId }),
  clearRequest: () => set({ requestedNode: null }),
  load: async (api, projectId, nodeId) => {
    const key = keyFor(projectId, nodeId)
    const running = flights.get(key)
    if (running) return running
    const promise = (async () => {
      try {
        const result = await api.check(projectId, nodeId)
        set((s) => ({ byKey: { ...s.byKey, [key]: result.ok ? { view: result.value, unsupported: result.value.unsupported } : { error: result.error, unsupported: result.unsupported } } }))
      } catch (e) {
        set((s) => ({ byKey: { ...s.byKey, [key]: { error: e instanceof Error ? e.message : 'Could not check readiness.' } } }))
      }
    })()
    flights.set(key, promise)
    try { await promise } finally { if (flights.get(key) === promise) flights.delete(key) }
  }
}))

/** Poll only a visible surface; focus and saves also refresh. Cleanup releases every subscription. */
export function useReadiness(api: ReadinessApi | undefined, projectId: string | undefined, nodeId: string, enabled = true) {
  const ref = useRef<HTMLDivElement>(null)
  const entry = useTaskReadiness((s) => s.byKey[keyFor(projectId ?? '', nodeId)] ?? EMPTY)
  useEffect(() => {
    if (!enabled || !api || !projectId) return
    let visible = true
    let stopped = false
    const refresh = (): void => {
      if (visible && !stopped && document.visibilityState !== 'hidden') void useTaskReadiness.getState().load(api, projectId, nodeId)
    }
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) refresh() })
    if (observer && ref.current) { visible = false; observer.observe(ref.current) } else refresh()
    const unsubscribe = api.onChanged((p, n) => { if (p === projectId && n === nodeId) refresh() })
    const timer = setInterval(refresh, 5000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { stopped = true; observer?.disconnect(); unsubscribe(); clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [api, projectId, nodeId, enabled])
  return { entry, ref, refresh: () => api && projectId ? useTaskReadiness.getState().load(api, projectId, nodeId) : Promise.resolve() }
}
