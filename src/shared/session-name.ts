/** Per-node persistent session name (tmux, Zellij and the Windows session host all use it). Must
 *  stay stable — it is the persistence key. Lives in `src/shared` so the renderer can map a host's
 *  session list back to canvas nodes with the exact rule core used to name them. */
export function nodeSessionName(persistKey: string): string {
  return `nt-${persistKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}
