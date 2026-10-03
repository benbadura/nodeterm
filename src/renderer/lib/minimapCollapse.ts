// Personal "minimap minimized" flag. Same storage family as the explorer pin
// (`nodeterm.explorerPinned`) and the sessions sidebar pin: this machine only, never settings.json
// or project.json — how much chrome one viewer wants over their canvas is not something a
// git-shared project file should carry to everyone who clones it.
//
// Default EXPANDED: the minimap has always been on screen, so a missing (or unreadable) key must
// keep it there rather than hide it on every existing user's next launch.

export const MINIMAP_COLLAPSED_KEY = 'nodeterm.minimapCollapsed'

/** `'1'` is minimized; missing, `'0'`, or any other value is expanded. */
export function parseMinimapCollapsed(raw: string | null): boolean {
  return raw === '1'
}

export function readMinimapCollapsed(
  getItem: (key: string) => string | null = (key) => localStorage.getItem(key)
): boolean {
  try {
    return parseMinimapCollapsed(getItem(MINIMAP_COLLAPSED_KEY))
  } catch {
    return false
  }
}

export function writeMinimapCollapsed(
  collapsed: boolean,
  setItem: (key: string, value: string) => void = (key, value) => localStorage.setItem(key, value)
): void {
  try {
    setItem(MINIMAP_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    /* private-mode / quota: remembering the choice is a nicety, never fail the UI */
  }
}
