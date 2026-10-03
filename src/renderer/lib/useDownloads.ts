// The download state a file surface shows: a strip of transfers, and a per-ROW mark on the entry
// that was clicked. Shared by the Explorer drawer and the file-manager node so both report a
// download the same way — the transport itself is `performDownload` (lib/download.ts).
import { useCallback, useRef, useState } from 'react'
import type { FilesApi } from '@shared/types'
import { performDownload, triggerBrowserDownload, type DownloadRoute } from './download'

/** What a row's download mark is showing right now. */
export type RowDownloadState = 'running' | 'done' | 'error'

/** How long a finished row keeps its ✓ / ! before falling back to nothing. Long enough to be
 *  read after a click, short enough that a listing of them doesn't stay decorated. */
export const ROW_FLASH_MS = 2200

/** Row tooltip per state. The failure text points at the strip, which carries the reason. */
export const ROW_DOWNLOAD_TITLE: Record<RowDownloadState, string> = {
  running: 'Downloading…',
  done: 'Downloaded',
  error: 'Download failed — see the list below'
}

/** One entry in a download strip. `localPath` is set once a desktop (scp) download has landed,
 *  which is what makes it revealable. */
export interface DownloadItem {
  id: number
  name: string
  dir: boolean
  status: 'running' | 'done' | 'error'
  detail?: string
  localPath?: string
}

export interface Downloads {
  downloads: DownloadItem[]
  /** Download state per path — the whole map, so a row anywhere sees its own entry. */
  rowDl: Record<string, RowDownloadState>
  /** Download one entry. `destDir` (desktop only) overrides the OS Downloads folder — it comes
   *  from the native folder picker, and main still builds the final path itself. */
  download: (path: string, isDir: boolean, destDir?: string) => Promise<void>
  /** "Download to…" — desktop only (the browser has no native folder picker, and its own
   *  download location is a browser setting, not ours to ask about). */
  downloadTo: (path: string, isDir: boolean) => Promise<void>
  dismiss: (id: number) => void
}

export function useDownloads({
  route,
  projectId,
  files
}: {
  route: DownloadRoute
  /** The SSH project whose ControlMaster the scp route pulls over. */
  projectId: string | undefined
  /** The SESSION's files api — the ticket must be minted by the core the tree belongs to. */
  files: Pick<FilesApi, 'downloadTicket'>
}): Downloads {
  const [downloads, setDownloads] = useState<DownloadItem[]>([])
  const seq = useRef(0)
  // Per-ROW state, keyed by path. The strip reports the same transfers, but the user's eye is on
  // the entry they just acted on — and on the HTTP route the whole thing can be over before a
  // glance travels down there. So the row answers for itself.
  const [rowDl, setRowDl] = useState<Record<string, RowDownloadState>>({})

  const patch = useCallback((id: number, p: Partial<DownloadItem>): void => {
    setDownloads((list) => list.map((d) => (d.id === id ? { ...d, ...p } : d)))
  }, [])

  /**
   * Both routes report through the same strip, but they finish differently on purpose: an scp
   * pull is ours from start to finish, so it ends as a revealable local file; an HTTP download is
   * handed to the BROWSER at the first byte, and its own download shelf owns the progress from
   * there — so the strip's job is just to cover the mint round-trip and then get out of the way.
   */
  const download = useCallback(
    async (path: string, isDir: boolean, destDir?: string): Promise<void> => {
      if (route === 'none') return
      const id = ++seq.current
      const name = path.split('/').filter(Boolean).pop() || path
      setDownloads((list) => [...list, { id, name, dir: isDir, status: 'running' }])
      setRowDl((m) => ({ ...m, [path]: 'running' }))
      const res = await performDownload(
        route,
        { path, projectId, destDir },
        {
          scp: (p, remotePath, dest) => window.nodeTerminal.sshProject.downloadFile(p, remotePath, dest),
          ticket: (p) => files.downloadTicket(p),
          hand: triggerBrowserDownload
        }
      )
      if (!res.ok) patch(id, { status: 'error', detail: res.error })
      else if (res.localPath) patch(id, { status: 'done', localPath: res.localPath })
      else {
        patch(id, { status: 'done', detail: 'Sent to your browser downloads.' })
        // The browser has it now; the strip row would just be noise from here on.
        setTimeout(() => setDownloads((list) => list.filter((d) => d.id !== id)), 4000)
      }
      const state: RowDownloadState = res.ok ? 'done' : 'error'
      setRowDl((m) => ({ ...m, [path]: state }))
      // Clear the row after the flash. Keyed by PATH, so a second download of the same entry
      // started meanwhile owns the row and its timer must not wipe that state.
      setTimeout(
        () =>
          setRowDl((m) => {
            if (m[path] !== state) return m
            const next = { ...m }
            delete next[path]
            return next
          }),
        ROW_FLASH_MS
      )
    },
    [route, projectId, files, patch]
  )

  const downloadTo = useCallback(
    async (path: string, isDir: boolean): Promise<void> => {
      const dir = await window.nodeTerminal.dialog.selectFolder()
      if (dir) await download(path, isDir, dir)
    },
    [download]
  )

  const dismiss = useCallback((id: number): void => {
    setDownloads((list) => list.filter((d) => d.id !== id))
  }, [])

  return { downloads, rowDl, download, downloadTo, dismiss }
}
