/**
 * The app's one loading spinner: a CSS-only rotating ring (`.nt-spinner` in styles.css — no
 * dependency), frozen to a static ring under `prefers-reduced-motion`.
 *
 * Two ways to use it, and the difference is who speaks to a screen reader:
 * - `label` given → the spinner IS the status: a polite live region named by the label. Use it
 *   where nothing beside it says what is happening.
 * - no label → decorative (`aria-hidden`). Use it beside visible text ("Capturing…") and put the
 *   `role="status"` on the element holding that text, so the words are announced once — a labelled
 *   spinner next to the same words would be read twice.
 */
export function Spinner({ label }: { label?: string }) {
  return label ? (
    <span className="nt-spinner" role="status" aria-live="polite" aria-label={label} />
  ) : (
    <span className="nt-spinner" aria-hidden="true" />
  )
}
