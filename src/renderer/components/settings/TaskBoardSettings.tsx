import type { Project } from '@shared/types'
import { taskBoardPreference } from '@shared/tasks'
import { useSettings } from '../../state/settings'
import { isBrowserRuntime } from '../../bridge/runtime'
import { projectSessionSource } from '../LiveLinkChip'
import { Switch } from '../../ui/Switch'
import { FieldRow } from './FieldRow'

export function TaskBoardSettings({ project }: { project: Project }) {
  const raw = useSettings(s => s.settings.taskBoards)
  const config = taskBoardPreference({ taskBoards: raw }, project.id)
  const unsupported = isBrowserRuntime() || !!(project.ssh || project.remote) || projectSessionSource(project.id) !== 'local'
  const save = (patch: Partial<typeof config>) => useSettings.getState().update({ taskBoards: { ...raw, [project.id]: { ...config, ...patch } } })
  return <div>
    <FieldRow label="Task board" description="Track tasks through implementation and acceptance, with agent runs and evidence under each task. The session board stays available."
      note={unsupported ? 'Available for local Desktop projects.' : 'Saved on this machine. Turning off keeps all task history.'}
      control={<Switch ariaLabel="Task board" checked={config.enabled} disabled={unsupported} onChange={enabled => save({ enabled })} />} />
    {config.enabled && <FieldRow label="Concurrent task runs" description="Queued tasks wait for a free slot. After restarting the app, resume the queue explicitly."
      control={<select aria-label="Concurrent task runs" value={config.maxConcurrent} onChange={e => save({ maxConcurrent: Number(e.target.value) })}>{Array.from({ length: 8 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select>} />}
  </div>
}
