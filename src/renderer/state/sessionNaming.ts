import { create } from 'zustand'

// Transient "AI naming in progress" flag per node id. Kept in a store (not in the SessionRow
// component) so the spinner survives the row unmounting — e.g. when the sidebar closes or a
// hover-peek collapses while the name is still being generated. The generate-name request runs
// at the Canvas level and applies its result regardless of the row's mount state.
interface SessionNamingState {
  byId: Record<string, boolean>
  batchProjectId: string | null
  tryStart(id: string): boolean
  tryStartBatch(projectId: string): boolean
  finishBatch(): void
  set(id: string, naming: boolean): void
}

export const useSessionNaming = create<SessionNamingState>((set, get) => ({
  byId: {},
  batchProjectId: null,
  tryStart: (id) => {
    if (get().byId[id]) return false
    get().set(id, true)
    return true
  },
  tryStartBatch: (projectId) => {
    if (get().batchProjectId) return false
    set({ batchProjectId: projectId })
    return true
  },
  finishBatch: () => set({ batchProjectId: null }),
  set: (id, naming) =>
    set((s) => {
      if (!!s.byId[id] === naming) return s
      const byId = { ...s.byId }
      if (naming) byId[id] = true
      else delete byId[id]
      return { byId }
    })
}))
