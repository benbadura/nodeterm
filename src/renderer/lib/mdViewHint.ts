import { isHidden } from './ui-visibility'

/**
 * The quiet "⌘M Markdown view" hint at the right end of a terminal node's label row — the one
 * on-canvas sign that the ⌘M face exists at all (it was otherwise reachable only from the context
 * menu or by knowing the chord).
 *
 * Pure so the decision is testable without mounting a TerminalNode. Rules:
 * - `chip` is `chipFor('node.toggleMarkdown')`: the user's EFFECTIVE binding, platform-aware.
 *   `''` = unbound ⇒ no hint at all. A hint that names a chord which does nothing is worse than
 *   none (same rule the view's own bar follows).
 * - The label names what the chord does on THIS node: while the view is open it returns to the
 *   terminal; otherwise it opens the chat transcript when `chatAvailable` (the node's own
 *   chat-vs-markdown rule — TerminalNode passes the very value its `useChat` is built from, so the
 *   hint cannot promise one face and the chord open the other), else the markdown-of-output view.
 * - User-hideable through Settings → Appearance (`MD_VIEW_HINT_ID` in the header inventory).
 */
export const MD_VIEW_HINT_ID = 'md-hint'

export interface MdViewHint {
  chip: string
  label: string
}

export function mdViewHint(input: {
  chip: string
  open: boolean
  chatAvailable: boolean
  hidden: readonly string[]
}): MdViewHint | null {
  if (!input.chip || isHidden(MD_VIEW_HINT_ID, input.hidden)) return null
  const label = input.open ? 'Terminal' : input.chatAvailable ? 'Chat view' : 'Markdown view'
  return { chip: input.chip, label }
}
