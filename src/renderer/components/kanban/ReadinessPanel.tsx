import { useEffect, useState } from 'react'
import {
  reportCompleteness, type AcceptanceCriterion, type CodeSnapshot, type EvidenceSection,
  type ReadinessReport, type ReadinessReportInput, type ReadinessView,
  type ReadinessTest, type ReadinessReview, type ReadinessPreview
} from '@shared/task-readiness'
import { useSession } from '../../session/session'
import { useReadiness } from '../../state/taskReadiness'
import { uuid } from '../../lib/uuid'
import { projectSessionSource } from '../LiveLinkChip'

const missing = <T,>(): EvidenceSection<T> => ({ status: 'missing', items: [] })
const statusLabel = { current: 'Current code', stale: 'Needs refresh', unknown: 'Cannot verify', none: 'No report yet' }

function SectionInput<T>({ title, section, set, make, children }: {
  title: string; section: EvidenceSection<T>; set: (s: EvidenceSection<T>) => void; make: () => T; children: React.ReactNode
}) {
  return <fieldset className="readiness-section"><legend>{title}</legend>
    <label>Status <select value={section.status} onChange={(e) => {
      const status = e.target.value as EvidenceSection<T>['status']
      set({ status, reason: section.reason, items: status === 'recorded' ? section.items.length ? section.items : [make()] : [] })
    }}><option value="missing">Missing evidence</option><option value="recorded">Recorded</option><option value="not-applicable">Not applicable</option></select></label>
    {section.status === 'not-applicable' && <label>Reason <textarea value={section.reason ?? ''} onChange={(e) => set({ ...section, reason: e.target.value })} required /></label>}
    {section.status === 'recorded' && children}
  </fieldset>
}

function ReportView({ report, openUrl }: { report: ReadinessReport; openUrl: (url: string) => void }) {
  const state = reportCompleteness(report)
  return <article className="readiness-report">
    <div className="readiness-report__stamp"><strong>{report.source === 'agent' ? 'Agent report' : 'User entry'}</strong> · {report.author} · {new Date(report.at).toLocaleString()} <span>{state === 'complete' ? 'Complete evidence' : state === 'problems' ? 'Reported issues' : 'Missing evidence'}</span></div>
    <p className="readiness-version">HEAD <code title={report.snapshot.head}>{report.snapshot.head.slice(0, 12)}</code> · working snapshot <code title={report.snapshot.fingerprint}>{report.snapshot.fingerprint.slice(0, 12)}</code></p>
    <p className="readiness-muted">Snapshot taken {new Date(report.snapshot.at).toLocaleString()}. Results are declarations by the named author.</p>
    <section><h3>Acceptance criteria</h3>{!report.acceptance.length && <p className="readiness-muted">No acceptance criteria recorded.</p>}
      <ul>{report.acceptance.map((c) => {
        const result = report.criteria.find((r) => r.id === c.id)
        return <li key={c.id}><span className={`readiness-result readiness-result--${result?.status ?? 'unknown'}`}>{result?.status ?? 'missing'}</span> {c.text}{result?.note && <p>{result.note}</p>}</li>
      })}</ul>
    </section>
    <section><h3>Checkout changes <span className="readiness-muted">({report.snapshot.files.length})</span></h3><p className="readiness-muted">Compared with {report.snapshot.baseCommit.slice(0, 12)}; may include other work in this checkout.</p>
      {report.snapshot.files.length ? <details><summary>Changed files</summary><ul className="readiness-files">{report.snapshot.files.map((p) => <li key={p}><code>{p}</code></li>)}</ul></details> : <p>No changed files.</p>}
    </section>
    <section><h3>Tests</h3><EvidenceState section={report.tests} />{report.tests.items.map((t, i) => <div className="readiness-evidence" key={i}><strong className={`readiness-result readiness-result--${t.status}`}>{t.status}</strong> <code>{t.command}</code>{t.exitCode !== undefined && <span> · exit {t.exitCode}</span>}<p>{t.summary}</p></div>)}</section>
    <section><h3>Review</h3><EvidenceState section={report.review} />{report.review.items.map((r, i) => <div className="readiness-evidence" key={i}><strong>{r.outcome === 'passed' ? 'Reviewed' : 'Issues found'}</strong>{r.sourceNodeId && <span> · source {r.sourceNodeId}</span>}<p>{r.summary}</p><ul>{r.findings.map((f, n) => <li key={n}><strong>{f.severity}</strong> {f.file && <code>{f.file}{f.line ? `:${f.line}` : ''}</code>} {f.summary}</li>)}</ul></div>)}</section>
    <section><h3>Preview</h3><EvidenceState section={report.preview} />{report.preview.items.map((p, i) => <p key={i}><a href={p.url} onClick={(e) => { e.preventDefault(); openUrl(p.url) }}>{p.label || p.url}</a></p>)}</section>
  </article>
}
function EvidenceState({ section }: { section: EvidenceSection<unknown> }) {
  return section.status === 'not-applicable' ? <p>Not applicable — {section.reason}</p> : section.status === 'missing' ? <p className="readiness-muted">Missing evidence</p> : null
}

function CriteriaEditor({ view, save, busy }: { view: ReadinessView; save: (criteria: AcceptanceCriterion[], base: string) => Promise<void>; busy: boolean }) {
  const [criteria, set] = useState(view.criteria)
  const [base, setBase] = useState(view.baseCommit)
  useEffect(() => { set(view.criteria); setBase(view.baseCommit) }, [view.criteriaRevision, view.baseCommit])
  return <details className="readiness-criteria-editor" open={!view.criteria.length}><summary>Edit acceptance criteria and comparison base</summary>
    {criteria.map((c, i) => <div className="readiness-edit-row" key={c.id}><label>Criterion {i + 1}<textarea value={c.text} maxLength={2000} onChange={(e) => set(criteria.map((row) => row.id === c.id ? { ...row, text: e.target.value } : row))} /></label><button type="button" onClick={() => set(criteria.filter((row) => row.id !== c.id))} aria-label={`Remove criterion ${i + 1}`}>Remove</button></div>)}
    <button type="button" disabled={busy} onClick={() => set([...criteria, { id: uuid(), text: '' }])}>Add criterion</button>
    <label>Comparison base (full local commit SHA)<input value={base} onChange={(e) => setBase(e.target.value)} placeholder="Defaults to the code at task start" /></label>
    <button disabled={busy} onClick={() => void save(criteria, base)}>Save criteria</button>
  </details>
}

function ReportEditor({ snapshot, criteria, submit, cancel, busy }: { snapshot: CodeSnapshot; criteria: AcceptanceCriterion[]; submit: (r: ReadinessReportInput) => Promise<void>; cancel: () => void; busy: boolean }) {
  const [draft, setDraft] = useState<ReadinessReportInput>(() => ({ snapshotId: snapshot.id, criteria: criteria.map((c) => ({ id: c.id, status: 'unknown', note: '' })), tests: missing(), review: missing(), preview: missing() }))
  const change = <K extends keyof ReadinessReportInput,>(key: K, value: ReadinessReportInput[K]): void => setDraft((d) => ({ ...d, [key]: value }))
  return <form className="readiness-report-editor" onSubmit={(e) => { e.preventDefault(); void submit(draft) }}>
    <h3>New user report</h3><p>Run your checks against the captured code, then record the results. Code changes will mark this report as needing refresh.</p>
    <p className="readiness-version">Snapshot: {snapshot.head.slice(0, 12)} · {new Date(snapshot.at).toLocaleTimeString()}</p>
    {criteria.map((c, i) => <fieldset className="readiness-section" key={c.id}><legend>{c.text}</legend><label>Result <select value={draft.criteria[i].status} onChange={(e) => change('criteria', draft.criteria.map((r, n) => n === i ? { ...r, status: e.target.value as typeof r.status } : r))}><option value="unknown">Not assessed</option><option value="met">Met</option><option value="unmet">Unmet</option></select></label><label>Evidence<textarea value={draft.criteria[i].note} maxLength={2000} onChange={(e) => change('criteria', draft.criteria.map((r, n) => n === i ? { ...r, note: e.target.value } : r))} /></label></fieldset>)}
    <SectionInput<ReadinessTest> title="Tests" section={draft.tests} set={(s) => change('tests', s)} make={() => ({ command: '', status: 'unknown', summary: '' })}>
      {draft.tests.items.map((t, i) => <div className="readiness-evidence" key={i}><label>Command<input value={t.command} required maxLength={2000} onChange={(e) => change('tests', { ...draft.tests, items: draft.tests.items.map((r, n) => n === i ? { ...r, command: e.target.value } : r) })} /></label><label>Result<select value={t.status} onChange={(e) => change('tests', { ...draft.tests, items: draft.tests.items.map((r, n) => n === i ? { ...r, status: e.target.value as typeof r.status } : r) })}><option value="unknown">Unknown</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="skipped">Skipped</option></select></label><label>Summary<textarea value={t.summary} maxLength={8000} onChange={(e) => change('tests', { ...draft.tests, items: draft.tests.items.map((r, n) => n === i ? { ...r, summary: e.target.value } : r) })} /></label><button type="button" onClick={() => change('tests', { ...draft.tests, items: draft.tests.items.filter((_, n) => n !== i) })}>Remove test</button></div>)}
      <button type="button" onClick={() => change('tests', { ...draft.tests, items: [...draft.tests.items, { command: '', status: 'unknown', summary: '' }] })}>Add test</button>
    </SectionInput>
    <SectionInput<ReadinessReview> title="Review" section={draft.review} set={(s) => change('review', s)} make={() => ({ summary: '', outcome: 'issues', findings: [] })}>
      {draft.review.items.map((r, i) => <div className="readiness-evidence" key={i}>
        <label>Review outcome<select value={r.outcome} onChange={(e) => change('review', { ...draft.review, items: draft.review.items.map((row, n) => n === i ? { ...row, outcome: e.target.value as typeof r.outcome } : row) })}><option value="issues">Issues found</option><option value="passed">No blocking issues</option></select></label>
        <label>Summary<textarea value={r.summary} maxLength={8000} onChange={(e) => change('review', { ...draft.review, items: draft.review.items.map((row, n) => n === i ? { ...row, summary: e.target.value } : row) })} /></label>
        <label>Reviewer node id (optional)<input value={r.sourceNodeId ?? ''} onChange={(e) => change('review', { ...draft.review, items: draft.review.items.map((row, n) => n === i ? { ...row, sourceNodeId: e.target.value || undefined } : row) })} /></label>
        {r.findings.map((f, j) => <div className="readiness-finding" key={j}><label>Finding<input value={f.summary} required onChange={(e) => change('review', { ...draft.review, items: draft.review.items.map((row, n) => n === i ? { ...row, findings: row.findings.map((item, m) => m === j ? { ...item, summary: e.target.value } : item) } : row) })} /></label><label>Severity<select value={f.severity} onChange={(e) => change('review', { ...draft.review, items: draft.review.items.map((row, n) => n === i ? { ...row, findings: row.findings.map((item, m) => m === j ? { ...item, severity: e.target.value as typeof f.severity } : item) } : row) })}><option value="info">Info</option><option value="warning">Warning</option><option value="blocking">Blocking</option></select></label><button type="button" onClick={() => change('review', { ...draft.review, items: draft.review.items.map((row, n) => n === i ? { ...row, findings: row.findings.filter((_, m) => m !== j) } : row) })}>Remove finding</button></div>)}
        <button type="button" onClick={() => change('review', { ...draft.review, items: draft.review.items.map((row, n) => n === i ? { ...row, findings: [...row.findings, { summary: '', severity: 'warning' as const }] } : row) })}>Add finding</button>
      </div>)}
    </SectionInput>
    <SectionInput<ReadinessPreview> title="Preview" section={draft.preview} set={(s) => change('preview', s)} make={() => ({ label: '', url: '' })}>
      {draft.preview.items.map((p, i) => <div className="readiness-evidence" key={i}><label>Label<input value={p.label} maxLength={300} onChange={(e) => change('preview', { ...draft.preview, items: draft.preview.items.map((r, n) => n === i ? { ...r, label: e.target.value } : r) })} /></label><label>HTTP(S) URL<input value={p.url} type="url" required maxLength={2000} onChange={(e) => change('preview', { ...draft.preview, items: draft.preview.items.map((r, n) => n === i ? { ...r, url: e.target.value } : r) })} /></label></div>)}
    </SectionInput>
    <div className="readiness-actions"><button type="submit" disabled={busy}>Save report</button><button type="button" disabled={busy} onClick={cancel}>Cancel</button></div>
  </form>
}

export function ReadinessPanel({ projectId, nodeId, active = true }: { projectId: string; nodeId: string; active?: boolean }) {
  const { api } = useSession()
  const source = projectSessionSource(projectId)
  const supported = source !== 'relay' && source !== 'server'
  const { entry, ref, refresh } = useReadiness(api.readiness, projectId, nodeId, supported && active)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [snapshot, setSnapshot] = useState<CodeSnapshot>()
  const [draftCriteria, setDraftCriteria] = useState<AcceptanceCriterion[]>([])
  const [history, setHistory] = useState<ReadinessReport[]>([])
  const view = entry.view
  useEffect(() => { setSnapshot(undefined); setHistory([]); setError('') }, [projectId, nodeId])
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError('')
    try { await operation() } catch (e) { setError(e instanceof Error ? e.message : 'Could not save readiness.') } finally { setBusy(false) }
  }
  if (!supported || !api.readiness || entry.unsupported) return <div className="readiness-panel" hidden={!active}><p>Readiness is available for local Git projects in Desktop.</p></div>
  return <div className="readiness-panel" hidden={!active} ref={ref}>
    <div className="readiness-panel__heading"><div><h2>Task readiness</h2><p className="readiness-muted">Evidence, checkout changes and the code version they describe.</p></div><button disabled={busy} onClick={() => void run(refresh)}>Check freshness</button></div>
    {(error || entry.error) && <p role="alert" className="readiness-error">{error || entry.error}</p>}
    {view ? <>
      <p className={`readiness-freshness readiness-freshness--${view.freshness}`}><strong>{statusLabel[view.freshness]}</strong>{view.reason && <span> · {view.reason}</span>}</p>
      {!snapshot && <CriteriaEditor view={view} busy={busy} save={(criteria, base) => run(async () => { const r = await api.readiness.criteria(projectId, nodeId, criteria, view.criteriaRevision, base || undefined); if (!r.ok) throw new Error(r.error); await refresh() })} />}
      {snapshot ? <ReportEditor key={snapshot.id} snapshot={snapshot} criteria={draftCriteria} busy={busy} cancel={() => setSnapshot(undefined)} submit={(report) => run(async () => { const r = await api.readiness.report(projectId, nodeId, report); if (!r.ok) throw new Error(r.error); setSnapshot(undefined); setHistory([]); await refresh() })} /> : <button className="readiness-new-report" disabled={busy} onClick={() => void run(async () => { const r = await api.readiness.capture(projectId, nodeId); if (!r.ok) throw new Error(r.error); setDraftCriteria(r.value.acceptance); setSnapshot(r.value) })}>Capture code and start a new report</button>}
      {view.reports[0] ? <ReportView report={view.reports[0]} openUrl={(url) => void api.shell.openExternal(url)} /> : <p className="readiness-empty">No results recorded yet. Add acceptance criteria, then capture the code before running your checks.</p>}
      {view.total > 1 && <details className="readiness-history"><summary>Previous reports ({view.total - 1})</summary>{[...view.reports.slice(1), ...history].map((r) => <details key={r.id}><summary>{new Date(r.at).toLocaleString()} · {r.snapshot.head.slice(0, 12)} · {r.author}</summary><ReportView report={r} openUrl={(url) => void api.shell.openExternal(url)} /></details>)}
        {view.reports.length + history.length < view.total && <button disabled={busy} onClick={() => void run(async () => { const r = await api.readiness.read(projectId, nodeId, view.reports.length + history.length); if (!r.ok) throw new Error(r.error); setHistory((old) => [...old, ...r.value.reports]) })}>Load older reports</button>}
      </details>}
    </> : !entry.error && <p>Loading readiness…</p>}
  </div>
}
