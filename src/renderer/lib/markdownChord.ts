/**
 * Whether a CANVAS node (the terminal node's ⌘M view, the editor node's preview) owns a ⌘M
 * (`node.toggleMarkdown`) press.
 *
 * Only a hovered node takes the chord — and never while a kanban board is up. The board is an
 * opaque overlay over a still-mounted canvas, and a node's hover flag is driven by mouseenter /
 * mouseleave: a node that was under the pointer when the board opened (⌘⇧B) gets no guaranteed
 * mouseleave until the pointer moves, so its flag can read "hovered" under the board. The card
 * modal owns the chord there (its own ⌘M view); without this refusal one press would flip both
 * the hidden node and the modal.
 */
export function canvasOwnsMarkdownChord(hovered: boolean, boardUp: boolean): boolean {
  return hovered && !boardUp
}
