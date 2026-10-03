import { memo } from 'react'
import { useAgentStatus } from '../../state/agentStatus'
import { issueRunChipSig, type IssueRun, type IssueRunChipKind } from '../../lib/issueRuns'

const LABEL: Record<IssueRunChipKind, string | null> = {
  running: 'RUNNING',
  needs: 'NEEDS YOU',
  failed: 'TURN FAILED',
  dropped: 'DROPPED',
  paused: 'PAUSED',
  sleeping: 'SLEEPING',
  idle: null
}

/**
 * The live sessions bound to one GitHub issue card: one chip per session, carrying its state
 * (RUNNING / NEEDS YOU / …) and unread dot. Clicking a chip opens that session's card.
 *
 * READ-ONLY by construction: this is the only place the board looks at a bound session's hook
 * state, and it renders — it never writes an assignment. A hook `done` ends a TURN, not the work,
 * so it changes the chip (to idle) and nothing else; the card moves only when the session `assign`s
 * itself or a person drags it.
 */
export const IssueRunChips = memo(function IssueRunChips({
  runs,
  onOpen
}: {
  runs: readonly IssueRun[]
  onOpen: (nodeId: string) => void
}): React.JSX.Element | null {
  if (runs.length === 0) return null
  return (
    <div className="issue-run-chips" aria-label="Sessions working on this issue">
      {runs.map((run) => (
        <IssueRunChip key={run.id} run={run} onOpen={onOpen} />
      ))}
    </div>
  )
})

function IssueRunChip({ run, onOpen }: { run: IssueRun; onOpen: (nodeId: string) => void }) {
  // A primitive derived from this ONE node's entry — never `s.byId`, whose identity changes on
  // every hook event of every node (the `loopSig` / `armedDepSig` discipline). Same-state events
  // refresh `stateAt` in place and leave this string, and so the chip, untouched.
  const sig = useAgentStatus((s) => issueRunChipSig(s.byId[run.id]))
  const [kind, unread] = sig.split('|') as [IssueRunChipKind, string]
  const label = LABEL[kind]
  const name = run.title || run.agentId || 'Session'
  return (
    <button
      type="button"
      className={`issue-run-chip issue-run-chip--${kind}`}
      title={`${name}${label ? ` — ${label.toLowerCase()}` : ''} · open its card`}
      data-state={kind}
      onClick={(event) => {
        event.stopPropagation()
        onOpen(run.id)
      }}
      // The chip sits inside the issue card, which opens its summary on Enter/Space.
      onKeyDown={(event) => event.stopPropagation()}
    >
      <span className="issue-run-chip__name">{name}</span>
      {label && <span className="issue-run-chip__state">{label}</span>}
      {unread === '1' && <span className="kanban-card__unread" aria-label="unread" />}
    </button>
  )
}
