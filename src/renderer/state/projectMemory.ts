import { create } from 'zustand'
import type { AgentId } from '@shared/agents/config'
import type { MemorySelection } from '@shared/project-memory'

export interface MemoryHandoffRequest { projectId: string; taskId: string; sourceNodeId?: string; agentId: AgentId; model?: string }
interface MemoryPanelState {
  opened?: { projectId: string; selection: MemorySelection }
  handoff?: MemoryHandoffRequest
  source?: { projectId: string; nodeId: string }
  open(projectId: string, selection?: MemorySelection): void
  close(): void
  transfer(request: MemoryHandoffRequest): void
  consumeTransfer(): void
  openSource(projectId: string, nodeId: string): void
  consumeSource(): void
}
export const useProjectMemoryPanel = create<MemoryPanelState>((set) => ({
  open: (projectId, selection = {}) => set({ opened: { projectId, selection } }),
  close: () => set({ opened: undefined }),
  transfer: (handoff) => set({ handoff }),
  consumeTransfer: () => set({ handoff: undefined }),
  openSource: (projectId, nodeId) => set({ source: { projectId, nodeId }, opened: undefined }),
  consumeSource: () => set({ source: undefined })
}))
