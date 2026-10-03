/**
 * The context menu's "Markdown view" over a SELECTION: one verdict for every targeted terminal.
 *
 * It used to flip each node independently, so a mixed selection INVERTED — the nodes showing the
 * view turned it off while the others turned it on — and no number of clicks could bring the
 * selection into one state. The rule now is the usual multi-select toggle (Finder's, Figma's): if
 * ANY targeted terminal has the view off, the action turns it ON for all of them; only when every
 * one already has it on does it turn them all off. A single node still simply toggles.
 *
 * Only terminal nodes carry `mdMode` (an editor's preview is its own local state), so everything
 * else — and every untargeted node — is ignored when deciding. `null` = no targeted terminal, i.e.
 * nothing to change.
 */
export function nextMdMode(
  nodes: readonly { id: string; type?: string; data: Readonly<Record<string, unknown>> }[],
  ids: readonly string[]
): boolean | null {
  const set = new Set(ids)
  const targets = nodes.filter((n) => set.has(n.id) && n.type === 'terminal')
  if (!targets.length) return null
  return targets.some((n) => !n.data.mdMode)
}
