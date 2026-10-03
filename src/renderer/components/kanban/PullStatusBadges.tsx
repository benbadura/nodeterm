import type {
  GitHubPullStatus,
  PullCiState,
  PullMergeState,
  PullStatusFreshness
} from '@shared/github-pull-status'
import { githubClock } from '../../lib/githubSyncStatus'

// ONE vocabulary for a pull request's state on every surface that shows it — the PR card, an issue
// card's "PR #M" chip, a session card's chip, and both modals. Two rules live here and nowhere else:
//  - CI renders only for a real result. `none` (GitHub reports no checks) and an ABSENT ci (the
//    token may not read checks, or the only result is for another commit) both render NOTHING:
//    no tick is ever drawn for checks that do not exist or cannot be seen.
//  - "Ready to merge" renders only for `ready`, which only `mergeStateStatus === CLEAN` produces.

const CI_LABEL: Record<Exclude<PullCiState, 'none'>, { text: string; glyph: string }> = {
  passed: { text: 'Checks passed', glyph: '✓' },
  failed: { text: 'Checks failing', glyph: '✗' },
  pending: { text: 'Checks running', glyph: '●' }
}

/** Merge states worth a word. `unstable` is said by the CI badge already, and `hooks` is neither a
 *  problem nor "ready" — both render nothing rather than a label that means little. */
const MERGE_LABEL: Partial<Record<PullMergeState, string>> = {
  ready: 'Ready to merge',
  conflict: 'Conflicts',
  blocked: 'Blocked',
  behind: 'Behind base',
  undecided: 'Checking mergeability…'
}

const LIFECYCLE_WORD = { draft: 'draft', merged: 'merged', closed: 'closed' } as const

export function ciLabel(ci: PullCiState | undefined): { text: string; glyph: string } | null {
  return ci && ci !== 'none' ? CI_LABEL[ci] : null
}

export function mergeLabel(merge: PullMergeState | undefined): string | null {
  return merge ? MERGE_LABEL[merge] ?? null : null
}

function staleTitle(freshness: PullStatusFreshness, observedAt: number | undefined): string | undefined {
  if (freshness === 'fresh') return undefined
  return observedAt === undefined
    ? 'GitHub could not be reached to check this pull request.'
    : `Last checked at ${githubClock(observedAt)}. GitHub could not be reached since.`
}

/** The CI + merge line of an open PR, for the PR card and the PR modal. */
export function PullStatusLine({
  status,
  freshness,
  observedAt
}: {
  status: GitHubPullStatus | undefined
  freshness: PullStatusFreshness
  observedAt?: number
}): React.JSX.Element | null {
  if (!status) return null
  const ci = ciLabel(status.ci)
  const merge = mergeLabel(status.merge)
  if (!ci && !merge) return null
  return (
    <div
      className={`pull-status pull-status--${freshness}`}
      title={staleTitle(freshness, observedAt)}
      data-testid="pull-status"
    >
      {ci && (
        <span className={`pull-status__ci pull-status__ci--${status.ci}`}>
          <span aria-hidden="true">{ci.glyph}</span> {ci.text}
        </span>
      )}
      {merge && <span className={`pull-status__merge pull-status__merge--${status.merge}`}>{merge}</span>}
      {freshness !== 'fresh' && <span className="pull-status__stale">stale</span>}
    </div>
  )
}

/** "PR #12 ✓ Ready" — the compact form an issue card or a session card carries. */
export function PullRefChip({
  status,
  freshness
}: {
  status: GitHubPullStatus
  freshness: PullStatusFreshness
}): React.JSX.Element {
  const open = status.lifecycle === 'open' || status.lifecycle === 'draft'
  const ci = open ? ciLabel(status.ci) : null
  const merge = open && status.lifecycle === 'open' ? mergeLabel(status.merge) : null
  const word = status.lifecycle === 'open' ? null : LIFECYCLE_WORD[status.lifecycle]
  const parts = [`PR #${status.number}`, word, ci?.text, merge].filter(Boolean)
  return (
    <span
      className={`pull-ref pull-ref--${status.lifecycle}${open ? ` pull-status--${freshness}` : ''}`}
      title={[parts.join(' · '), open ? staleTitle(freshness, undefined) : undefined].filter(Boolean).join('\n')}
    >
      PR #{status.number}
      {word && <span className="pull-ref__word"> {word}</span>}
      {ci && <span className={`pull-ref__ci pull-status__ci--${status.ci}`} aria-label={ci.text}> {ci.glyph}</span>}
      {merge && status.merge === 'ready' && <span className="pull-ref__ready"> ready</span>}
      {merge && status.merge === 'conflict' && <span className="pull-ref__conflict"> conflicts</span>}
    </span>
  )
}
