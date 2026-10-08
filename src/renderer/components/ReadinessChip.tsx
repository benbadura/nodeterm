import { reportCompleteness, type ReadinessApi } from '@shared/task-readiness'
import { useReadiness, useTaskReadiness } from '../state/taskReadiness'
import { useViewMode } from '../state/viewMode'

export function ReadinessChip({ api, projectId, nodeId, onOpen, enabled = true }: {
  api?: ReadinessApi; projectId?: string; nodeId: string; onOpen?: (nodeId: string) => void; enabled?: boolean
}) {
  const { entry, ref } = useReadiness(api, projectId, nodeId, enabled)
  if (!enabled || !api || !projectId || entry.unsupported) return null
  const report = entry.view?.reports[0]
  const freshness = entry.view?.freshness
  const completeness = report ? reportCompleteness(report) : undefined
  const label = entry.error || freshness === 'unknown' ? 'Cannot verify' : freshness === 'stale' ? 'Needs refresh' : completeness === 'problems' ? 'Reported issues' : completeness === 'incomplete' ? 'Missing evidence' : completeness === 'complete' ? 'Current report' : 'Readiness'
  const tone = freshness === 'stale' || completeness === 'incomplete' ? 'warning' : completeness === 'problems' ? 'error' : freshness === 'current' && completeness === 'complete' ? 'current' : 'neutral'
  return <div ref={ref} className="readiness-chip-wrap">
    <button className={`readiness-chip readiness-chip--${tone}`} title={entry.error || entry.view?.reason || 'Open task readiness — reported evidence and code version'} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => {
      e.stopPropagation()
      useTaskReadiness.getState().request(nodeId)
      if (onOpen) onOpen(nodeId)
      else { useViewMode.getState().setView(projectId, 'kanban'); useViewMode.getState().requestCard(nodeId) }
    }}>{label}</button>
  </div>
}
