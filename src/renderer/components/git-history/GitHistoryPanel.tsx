import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitHistoryItem, GitHistoryResult } from '@shared/git-history'
import { buildDefaultGitHistoryColorMap, buildGitHistoryViewModels } from '@shared/git-history-graph'
import type { GitFileChange } from '@shared/types'
import { GitHistoryRow } from './GitHistoryRow'
import { GitHistoryCommitFiles, type GitHistoryCommitFilesState } from './GitHistoryCommitFiles'

export function GitHistoryPanel({
  result,
  loading,
  error,
  onRefresh,
  onLoadCommitFiles,
  onOpenCommitFile,
  onCommitContextMenu
}: {
  result: GitHistoryResult | null
  loading: boolean
  error: string
  onRefresh: () => void
  onLoadCommitFiles: (item: GitHistoryItem) => Promise<GitFileChange[]>
  onOpenCommitFile: (item: GitHistoryItem, entry: GitFileChange) => void
  onCommitContextMenu: (item: GitHistoryItem, e: React.MouseEvent) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [filesByCommit, setFilesByCommit] = useState<Record<string, GitHistoryCommitFilesState>>({})
  const loadedRef = useRef<Set<string>>(new Set())

  const viewModels = useMemo(() => {
    if (!result) return []
    return buildGitHistoryViewModels(
      result.items,
      buildDefaultGitHistoryColorMap(result),
      result.currentRef,
      result.remoteRef,
      result.baseRef,
      result.hasIncomingChanges,
      result.hasOutgoingChanges,
      result.mergeBase
    )
  }, [result])

  // A new result can reorder commits — drop expansion + cached files.
  useEffect(() => {
    setExpanded(new Set())
    setFilesByCommit({})
    loadedRef.current = new Set()
  }, [result])

  const toggleExpand = useCallback(
    (item: GitHistoryItem) => {
      const id = item.id
      const willExpand = !expanded.has(id)
      setExpanded((prev) => {
        const next = new Set(prev)
        willExpand ? next.add(id) : next.delete(id)
        return next
      })
      if (!willExpand || loadedRef.current.has(id)) return
      loadedRef.current.add(id)
      setFilesByCommit((prev) => ({ ...prev, [id]: { status: 'loading' } }))
      onLoadCommitFiles(item)
        .then((entries) => setFilesByCommit((prev) => ({ ...prev, [id]: { status: 'ready', entries } })))
        .catch((e: unknown) => {
          loadedRef.current.delete(id)
          setFilesByCommit((prev) => ({
            ...prev,
            [id]: { status: 'error', error: e instanceof Error ? e.message : 'Failed to load commit files' }
          }))
        })
    },
    [expanded, onLoadCommitFiles]
  )

  const count = result?.items.length ?? 0

  return (
    <section className="scm-section">
      <div className="scm-history__head">
        <button onClick={() => setCollapsed((c) => !c)} style={{ flex: 1, textAlign: 'left' }}>
          {collapsed ? '▸' : '▾'} COMMITS {result && <span className="scm-history__count">{count}{result.hasMore ? '+' : ''}</span>}
        </button>
        <button title="Refresh commits" onClick={onRefresh}>{loading ? '…' : '⟳'}</button>
      </div>
      {!collapsed && error && !result && <div className="scm-history__msg" style={{ color: 'var(--danger)' }}>{error}</div>}
      {!collapsed && !result && !error && <div className="scm-history__msg">Loading graph…</div>}
      {!collapsed && result && viewModels.length === 0 && <div className="scm-history__msg">No commits yet</div>}
      {!collapsed && viewModels.length > 0 && (
        <div className="scm-history__body">
          {viewModels.map((vm) => {
            const item = vm.historyItem
            const isBoundary = vm.kind === 'incoming-changes' || vm.kind === 'outgoing-changes'
            const isExpanded = !isBoundary && expanded.has(item.id)
            return (
              <React.Fragment key={`${vm.kind}:${item.id}`}>
                <GitHistoryRow
                  viewModel={vm}
                  expanded={isExpanded}
                  preserveRefIds={result?.baseRef ? [result.baseRef.id] : undefined}
                  onToggleExpand={isBoundary ? undefined : toggleExpand}
                  onContextMenu={isBoundary ? undefined : onCommitContextMenu}
                />
                {isExpanded && (
                  <GitHistoryCommitFiles
                    state={filesByCommit[item.id] ?? { status: 'loading' }}
                    author={item.author}
                    timestamp={item.timestamp}
                    onOpenFile={(entry) => onOpenCommitFile(item, entry)}
                  />
                )}
              </React.Fragment>
            )
          })}
        </div>
      )}
    </section>
  )
}
