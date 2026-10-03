/**
 * The ONE git file-status colour table. Both git panels (Source Control and the history commit
 * list) draw a status letter with it; each value is a role token from styles.css, so an appearance
 * re-maps it there (Liquid Glass does) and the light theme's text-safe hues apply by construction.
 * An unknown status (`??`, `C`, `T`…) draws in the plain label colour.
 */
const GIT_STATUS_COLORS: Record<string, string> = {
  M: 'var(--git-modified)',
  A: 'var(--git-added)',
  D: 'var(--git-deleted)',
  R: 'var(--git-renamed)',
  U: 'var(--git-conflict)'
}

export function gitStatusColor(status: string): string {
  return GIT_STATUS_COLORS[status] ?? 'var(--text)'
}
