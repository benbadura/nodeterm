import { formatIssueRef, normalizeIssueRef, type IssueRef } from '@shared/github-issue-ref'

/**
 * `#N` — the GitHub issue a session was started on. Drawn by the canvas node header AND the
 * session's board card (the board and the canvas are two views of the same node), and it does the
 * same thing on both: opens the issue. The value comes from node data that was read out of a
 * git-shared file, so it is re-validated here; an invalid binding draws nothing.
 */
export function IssueRefChip({
  issueRef,
  onOpen
}: {
  issueRef: unknown
  onOpen: (ref: IssueRef) => void
}): React.JSX.Element | null {
  const ref = normalizeIssueRef(issueRef)
  if (!ref) return null
  const label = formatIssueRef(ref)
  return (
    <button
      type="button"
      className="issue-ref-chip nodrag"
      title={`Started on GitHub issue ${label} — open it`}
      aria-label={`Open GitHub issue ${label}`}
      onClick={(event) => {
        event.stopPropagation()
        onOpen(ref)
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      #{ref.number}
    </button>
  )
}
