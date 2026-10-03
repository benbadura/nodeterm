import type { DownloadItem } from '../lib/useDownloads'
import { IconClose } from './icons'

/**
 * The list of transfers under a file surface (the Explorer drawer, a file-manager node): one row
 * per download, a spinner while it runs, Reveal once an scp pull has landed on this machine.
 * Renders nothing while there is nothing to report.
 */
export function DownloadStrip({
  downloads,
  onDismiss,
  className
}: {
  downloads: DownloadItem[]
  onDismiss: (id: number) => void
  className?: string
}) {
  if (downloads.length === 0) return null
  return (
    <div className={className ? `ex-dls ${className}` : 'ex-dls'}>
      {downloads.map((d) => (
        <div key={d.id} className={`ex-dls__row ${d.status}`}>
          {d.status === 'running' && <span className="ex-dls__spin" />}
          <span className="ex-dls__name" title={d.detail || d.localPath || d.name}>
            {d.name}
            {d.dir && d.status === 'running' ? ' (folder)' : ''}
          </span>
          {d.status === 'done' && d.localPath && (
            <button className="ex-dls__act" onClick={() => window.nodeTerminal.shell.reveal(d.localPath!)}>
              Reveal
            </button>
          )}
          <button
            className="ex-dls__act ex-dls__dismiss"
            aria-label="Dismiss"
            onClick={() => onDismiss(d.id)}
          >
            <IconClose />
          </button>
        </div>
      ))}
    </div>
  )
}
