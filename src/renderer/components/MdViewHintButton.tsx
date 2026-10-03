import type { MdViewHint } from '../lib/mdViewHint'

/**
 * Presentational half of the label-row ⌘M hint (the decision is `lib/mdViewHint.ts`). A button,
 * not a span: clicking it does exactly what the chord does, so a user who found the hint by eye
 * does not also have to learn the chord. `nodrag` so a click is a click, never a node move.
 */
export function MdViewHintButton({
  hint,
  tooltip,
  onToggle
}: {
  hint: MdViewHint
  tooltip: string
  onToggle: () => void
}) {
  return (
    <button type="button" className="term-node__mdhint nodrag" title={tooltip} onClick={onToggle}>
      <span className="term-node__mdhint-chip">{hint.chip}</span> {hint.label}
    </button>
  )
}
