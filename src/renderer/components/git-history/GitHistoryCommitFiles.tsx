import type { GitFileChange } from '@shared/types'
import { formatGitHistoryTimestamp } from './git-history-format'
import { gitStatusColor } from '../../lib/gitStatusColors'


export type GitHistoryCommitFilesState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; entries: GitFileChange[] }

export function GitHistoryCommitFiles({
  state,
  author,
  timestamp,
  onOpenFile
}: {
  state: GitHistoryCommitFilesState
  author?: string
  timestamp?: number
  onOpenFile: (entry: GitFileChange) => void
}) {
  const meta = [author, formatGitHistoryTimestamp(timestamp)].filter(Boolean).join(' · ')
  return (
    <div className="scm-history__files">
      {meta && <div className="scm-history__meta">{meta}</div>}
      {state.status === 'loading' && <div className="scm-history__meta">Loading files…</div>}
      {state.status === 'error' && <div className="scm-history__meta" style={{ color: 'var(--danger)' }} title={state.error}>{state.error}</div>}
      {state.status === 'ready' && state.entries.length === 0 && (
        <div className="scm-history__meta">No file changes in this commit</div>
      )}
      {state.status === 'ready' &&
        state.entries.map((entry) => {
          const name = entry.path.split('/').pop() || entry.path
          const dir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
          return (
            <button key={entry.path} type="button" className="scm-history__file" title={entry.path} onClick={() => onOpenFile(entry)}>
              <span style={{ width: 12, textAlign: 'center', fontWeight: 700, fontSize: 10, color: gitStatusColor(entry.status) }}>
                {entry.status}
              </span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {name}
                {dir && <span className="scm-history__file-dir">{dir}</span>}
              </span>
            </button>
          )
        })}
    </div>
  )
}
