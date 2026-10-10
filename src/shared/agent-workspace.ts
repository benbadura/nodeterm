export type AgentWorkspaceMode = 'current' | 'new-worktree'

/** Last successful manual creation mode, local to this installation and project. */
export type AgentWorkspacePreferences = Record<string, AgentWorkspaceMode>

export function sanitizeAgentWorkspacePreferences(raw: unknown): AgentWorkspacePreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw).filter(([id, mode]) =>
      id.length > 0 && id.length <= 256 && (mode === 'current' || mode === 'new-worktree')
    )
  )
}

export function agentWorkspaceMode(raw: unknown, projectId: string): AgentWorkspaceMode {
  const preferences = sanitizeAgentWorkspacePreferences(raw)
  return Object.hasOwn(preferences, projectId) ? preferences[projectId] : 'current'
}

export function rememberAgentWorkspaceMode(
  raw: unknown,
  projectId: string,
  mode: AgentWorkspaceMode
): AgentWorkspacePreferences {
  return { ...sanitizeAgentWorkspacePreferences(raw), [projectId]: mode }
}
