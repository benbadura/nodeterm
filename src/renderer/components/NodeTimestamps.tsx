import { nodeTimestamps, type NodeTimestamps as Timestamps } from '@shared/node-timestamps'

const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' })

/** Sibling of the node body, whose overflow:hidden would otherwise clip this metadata strip. */
export function NodeTimestamps({ id, data }: { id: string; data: Timestamps & { ghost?: boolean } }) {
  if (data.ghost) return null
  const { createdAt, lastActivityAt } = nodeTimestamps({ ...data, id })
  const date = (label: string, at: number | undefined) => (
    <span className="node-timestamps__date" title={`${label}: ${at === undefined ? 'Unknown' : new Date(at).toLocaleString()}`}>
      {label}: {at === undefined ? '—' : <time dateTime={new Date(at).toISOString()}>{formatter.format(at)}</time>}
    </span>
  )
  return (
    <div className="node-timestamps nodrag nowheel" aria-label="Node dates">
      {date('Created', createdAt)}
      {date('Last active', lastActivityAt)}
    </div>
  )
}
