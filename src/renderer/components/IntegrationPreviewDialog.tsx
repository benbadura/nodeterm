import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  previewOptionsValid, PREVIEW_DEFAULT_TIMEOUT_MINUTES, PREVIEW_HISTORY_LIMIT,
  type IntegrationPreviewApi, type PreviewInspection, type PreviewOptions, type PreviewReport
} from '@shared/integration-preview'
import { useDialogStack } from './dialog-stack'

const PHASES = ['resolving', 'merging', 'preparing', 'testing', 'cleaning', 'finished'] as const
const PHASE_LABELS = { resolving: 'Snapshot', merging: 'Merge', preparing: 'Prepare', testing: 'Test', cleaning: 'Cleanup', finished: 'Finished' }
const OUTCOMES = {
  passed: 'Tests passed', conflict: 'Merge conflict', 'git-error': 'Git failed', 'setup-failed': 'Preparation failed',
  'tests-failed': 'Tests failed', cancelled: 'Cancelled', 'timed-out': 'Time limit exceeded', interrupted: 'Interrupted'
}
const emptyOptions = (): PreviewOptions => ({ baseRef: '', branches: [], setupCommand: '', testCommand: '', timeoutMinutes: PREVIEW_DEFAULT_TIMEOUT_MINUTES })
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function IntegrationPreviewDialog({ projectId, api, onClose }: {
  projectId: string
  api: IntegrationPreviewApi
  onClose(): void
}) {
  const [inspection, setInspection] = useState<PreviewInspection | null>(null)
  const [options, setOptions] = useState<PreviewOptions>(emptyOptions)
  const [reports, setReports] = useState<PreviewReport[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [suggestion, setSuggestion] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const editedCommands = useRef(false)
  const inspectionEpoch = useRef(0)
  const isTop = useDialogStack()
  const applyReport = useCallback((report: PreviewReport) => setReports((previous) => {
    const old = previous.find((r) => r.runId === report.runId)
    if (old && old.seq >= report.seq) return previous
    return [report, ...previous.filter((r) => r.runId !== report.runId)]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, PREVIEW_HISTORY_LIMIT)
  }), [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTop() && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isTop, onClose])

  useEffect(() => {
    let alive = true
    const unsubscribe = api.onEvent(projectId, (report) => { if (alive) applyReport(report) })
    void Promise.all([api.inspect(projectId), api.listReports(projectId)]).then(([info, history]) => {
      if (!alive) return
      setInspection(info)
      for (const report of history) applyReport(report)
      if (info.defaults) {
        editedCommands.current = true
        setOptions({ ...info.defaults, baseRef: info.defaultBaseRef, branches: info.defaults.branches.filter((b) => info.branches.includes(b) && b !== info.defaultBaseRef) })
      } else {
        const detected = info.suggestions.length === 1 ? info.suggestions[0] : undefined
        setOptions({ ...emptyOptions(), baseRef: info.defaultBaseRef, setupCommand: detected?.setupCommand ?? '', testCommand: detected?.testCommand ?? '' })
        if (detected) setSuggestion('0')
      }
    }).catch((e) => { if (alive) setError(errorText(e)) })
    return () => { alive = false; inspectionEpoch.current++; unsubscribe() }
  }, [api, projectId, applyReport])

  const latest = reports[0]
  const running = latest && latest.phase !== 'finished'
  const report = reports.find((r) => r.runId === selectedId) ?? latest
  const locked = busy || !!running

  const changeBase = async (baseRef: string) => {
    setOptions((v) => ({ ...v, baseRef, branches: v.branches.filter((b) => b !== baseRef) }))
    const epoch = ++inspectionEpoch.current
    setInspecting(true)
    setError('')
    try {
      const info = await api.inspect(projectId, baseRef)
      if (epoch !== inspectionEpoch.current) return
      setInspection(info)
      setSuggestion('')
      if (!editedCommands.current) {
        const detected = info.suggestions.length === 1 ? info.suggestions[0] : undefined
        setOptions((v) => ({ ...v, setupCommand: detected?.setupCommand ?? '', testCommand: detected?.testCommand ?? '' }))
        if (detected) setSuggestion('0')
      }
    } catch (e) { if (epoch === inspectionEpoch.current) setError(errorText(e)) }
    finally { if (epoch === inspectionEpoch.current) setInspecting(false) }
  }

  const start = async (value: PreviewOptions) => {
    setBusy(true)
    setError('')
    setOptions(value)
    try {
      const result = await api.start(projectId, value)
      if (!result.ok) setError(result.message || 'Could not start the preview.')
      else {
        setSelectedId(result.runId ?? '')
        const current = await api.get(projectId)
        if (current) applyReport(current)
      }
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }

  const moveBranch = (index: number, offset: number) => setOptions((v) => {
    const branches = [...v.branches]
    ;[branches[index], branches[index + offset]] = [branches[index + offset], branches[index]]
    return { ...v, branches }
  })
  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try { await action() } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }

  return createPortal(
    <div className="confirm-overlay" onClick={onClose}>
      <div className="confirm integration-preview" role="dialog" aria-modal="true" aria-labelledby="integration-preview-title" onClick={(e) => e.stopPropagation()}>
        <div className="integration-preview__heading">
          <h2 id="integration-preview-title">Integration preview</h2>
          <button className="confirm__btn" onClick={onClose} aria-label="Close integration preview">Close</button>
        </div>
        <p className="integration-preview__note">Combine committed changes in a temporary worktree, then run tests. The worktree is removed when the run finishes.</p>
        {!inspection && !error && <p>Loading branches and test commands…</p>}
        {inspection && !inspection.available && <p role="alert">{inspection.reason}</p>}
        {inspection?.available && <>
          <fieldset disabled={locked} className="integration-preview__fields">
            <label>Base branch
              <select aria-label="Base branch" value={options.baseRef} onChange={(e) => void changeBase(e.target.value)}>
                {inspection.branches.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            <label>Add branch
              <select aria-label="Add branch" value="" onChange={(e) => {
                if (e.target.value) setOptions((v) => ({ ...v, branches: [...v.branches, e.target.value] }))
              }}>
                <option value="">Select a branch…</option>
                {inspection.branches.filter((b) => b !== options.baseRef && !options.branches.includes(b)).map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            <ol className="integration-preview__branches">
              {options.branches.map((branch, i) => <li key={branch}>
                <span>{branch}</span>
                <button aria-label={`Move ${branch} up`} disabled={locked || i === 0} onClick={() => moveBranch(i, -1)}>↑</button>
                <button aria-label={`Move ${branch} down`} disabled={locked || i === options.branches.length - 1} onClick={() => moveBranch(i, 1)}>↓</button>
                <button aria-label={`Remove ${branch}`} onClick={() => setOptions((v) => ({ ...v, branches: v.branches.filter((b) => b !== branch) }))}>×</button>
              </li>)}
            </ol>
            {options.branches.length < 2 && <p className="integration-preview__note">Choose at least two branches. They are merged in the order above.</p>}
            {inspection.suggestions.length > 0 && <label>Detected test configuration
              <select aria-label="Detected test configuration" value={suggestion} disabled={inspecting} onChange={(e) => {
                setSuggestion(e.target.value)
                const picked = inspection.suggestions[Number(e.target.value)]
                if (e.target.value !== '' && picked) {
                  editedCommands.current = true
                  setOptions((v) => ({ ...v, setupCommand: picked.setupCommand, testCommand: picked.testCommand }))
                }
              }}>
                <option value="">Custom commands</option>
                {inspection.suggestions.map((s, i) => <option value={i} key={`${s.label}-${i}`}>{s.label} — {s.source}</option>)}
              </select>
            </label>}
            <label>Preparation command (optional)
              <textarea aria-label="Preparation command" value={options.setupCommand} rows={2} onChange={(e) => {
                editedCommands.current = true; setSuggestion(''); setOptions((v) => ({ ...v, setupCommand: e.target.value }))
              }} />
            </label>
            <label>Test command
              <textarea aria-label="Test command" value={options.testCommand} rows={2} onChange={(e) => {
                editedCommands.current = true; setSuggestion(''); setOptions((v) => ({ ...v, testCommand: e.target.value }))
              }} />
            </label>
            <label>Time limit per command (minutes)
              <input aria-label="Time limit per command" type="number" min={1} max={120} value={options.timeoutMinutes} onChange={(e) => setOptions((v) => ({ ...v, timeoutMinutes: Number(e.target.value) }))} />
            </label>
          </fieldset>
          <div className="confirm__actions">
            {running ? <button className="confirm__btn" disabled={busy || latest.phase === 'cleaning'} onClick={() => void runAction(() => api.cancel(projectId, latest.runId))}>Cancel run</button> :
              <button className="confirm__btn primary" disabled={locked || inspecting || !previewOptionsValid(options)} onClick={() => void start(options)}>{busy ? 'Starting…' : 'Run preview'}</button>}
          </div>
        </>}
        {error && <p className="integration-preview__error" role="alert">{error}</p>}
        {reports.length > 0 && <section className="integration-preview__report" aria-label="Integration report">
          <label>Recent runs
            <select aria-label="Recent runs" value={report?.runId ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
              {reports.map((r) => <option key={r.runId} value={r.runId}>{new Date(r.startedAt).toLocaleString()} · {r.outcome ? OUTCOMES[r.outcome] : PHASE_LABELS[r.phase]}</option>)}
            </select>
          </label>
          {report && <>
            <div className="integration-preview__progress" aria-label="Run progress">
              {PHASES.map((phase) => {
                const reached = phase === 'resolving' || phase === report.phase ||
                  (phase === 'merging' && (!!report.currentBranch || report.mergedBranches.length > 0)) ||
                  (phase === 'preparing' && report.setupExitCode !== undefined) ||
                  (phase === 'testing' && report.testExitCode !== undefined) ||
                  (phase === 'cleaning' && report.cleanup !== 'pending')
                return <span key={phase} className={reached ? 'reached' : ''} aria-current={phase === report.phase ? 'step' : undefined}>{PHASE_LABELS[phase]}</span>
              })}
            </div>
            <strong role="status">{report.outcome ? OUTCOMES[report.outcome] : `${PHASE_LABELS[report.phase]}${report.currentBranch ? `: ${report.currentBranch}` : '…'}`}</strong>
            <p className="integration-preview__note">These results cover the combined code. Individual branches were not tested separately.</p>
            {report.message && <p>{report.message}</p>}
            {report.conflicts.length > 0 && <><b>Conflicted files</b><ul>{report.conflicts.map((file) => <li key={file}><code>{file}</code></li>)}</ul></>}
            <details><summary>Commits and commands</summary>
              <p>Base: {report.base?.name} <code>{report.base?.sha}</code></p>
              <ol>{report.branches.map((b) => <li key={b.name}>{b.name} <code>{b.sha}</code> · {report.mergedBranches.includes(b.name) ? 'merged' : report.currentBranch === b.name ? 'merge stopped' : 'not checked'}</li>)}</ol>
              <pre>{[report.options.setupCommand, report.options.testCommand].filter(Boolean).join('\n')}</pre>
              <p>Started: {new Date(report.startedAt).toLocaleString()}{report.finishedAt && ` · Finished: ${new Date(report.finishedAt).toLocaleString()}`}</p>
            </details>
            {(['git', 'setup', 'tests'] as const).map((stage) => report.logs[stage] && <details key={stage} open={stage === 'tests' && report.outcome === 'tests-failed'}>
              <summary>{stage === 'git' ? 'Git log' : stage === 'setup' ? `Preparation log · exit ${report.setupExitCode ?? 'pending'}` : `Test log · exit ${report.testExitCode ?? 'pending'}`}</summary>
              <pre>{report.logs[stage]}</pre>
            </details>)}
            <p>Cleanup: {report.cleanup}{report.cleanupMessage && ` · ${report.cleanupMessage}`}</p>
            <div className="confirm__actions">
              {report.cleanup === 'failed' && <button className="confirm__btn" disabled={locked} onClick={() => void runAction(() => api.retryCleanup(projectId, report.runId))}>Retry cleanup</button>}
              {report.phase === 'finished' && inspection?.available && <button className="confirm__btn" disabled={locked} onClick={() => void start(report.options)}>Run again</button>}
            </div>
          </>}
        </section>}
      </div>
    </div>, document.body
  )
}
