import { describe, expect, it } from 'vitest'
import { parseAcceptance, parseReadinessReport, reportCompleteness, type ReadinessReport } from './task-readiness'

const payload = () => ({ snapshotId: 'snapshot-1', criteria: [{ id: 'c1', status: 'met', note: 'Observed expected behavior' }], tests: { status: 'recorded', items: [{ command: 'npm test', status: 'passed', exitCode: 0, summary: 'Passed' }] }, review: { status: 'recorded', items: [{ summary: 'Reviewed', outcome: 'passed', findings: [] }] }, preview: { status: 'not-applicable', reason: 'No UI', items: [] } })
function full(): ReadinessReport {
  const { snapshotId: _id, ...input } = parseReadinessReport(payload())
  return { ...input, id: 'r', at: 1, author: 'agent', source: 'agent', acceptance: [{ id: 'c1', text: 'Expected behavior' }], snapshot: { id: 's', at: 0, checkout: '/repo', head: 'a'.repeat(40), fingerprint: 'b'.repeat(64), baseCommit: 'a'.repeat(40), files: [], criteriaRevision: 1, acceptance: [{ id: 'c1', text: 'Expected behavior' }] } }
}
describe('readiness input and completeness', () => {
  it('requires a reason for not applicable and rejects executable preview URLs', () => {
    expect(() => parseReadinessReport({ ...payload(), preview: { status: 'not-applicable', items: [] } })).toThrow('reason')
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.com']) expect(() => parseReadinessReport({ ...payload(), preview: { status: 'recorded', items: [{ label: 'Preview', url }] } })).toThrow()
    expect(parseReadinessReport({ ...payload(), preview: { status: 'recorded', items: [{ label: 'Preview', url: 'http://localhost:3000' }] } }).preview.items[0].url).toBe('http://localhost:3000/')
  })
  it('rejects duplicate criteria and contradictory evidence', () => {
    expect(() => parseAcceptance([{ id: 'a', text: 'One' }, { id: 'a', text: 'Two' }])).toThrow()
    expect(() => parseReadinessReport({ ...payload(), tests: { status: 'recorded', items: [{ command: 'test', status: 'passed', exitCode: 1, summary: 'False pass' }] } })).toThrow('exit code')
    expect(() => parseReadinessReport({ ...payload(), review: { status: 'recorded', items: [{ summary: 'False pass', outcome: 'passed', findings: [{ summary: 'Broken', severity: 'blocking' }] }] } })).toThrow('blocking')
    expect(() => parseReadinessReport({ ...payload(), tests: { status: 'recorded', items: [] } })).toThrow('evidence')
  })
  it('does not treat missing, skipped, or unassessed evidence as a complete report', () => {
    const r = full()
    expect(reportCompleteness(r)).toBe('complete')
    r.tests = { status: 'missing', items: [] }
    expect(reportCompleteness(r)).toBe('incomplete')
    r.tests = { status: 'recorded', items: [{ command: 'test', status: 'skipped', summary: '' }] }
    expect(reportCompleteness(r)).toBe('incomplete')
    r.tests.items[0].status = 'failed'
    expect(reportCompleteness(r)).toBe('problems')
    r.tests = { status: 'not-applicable', reason: 'Documentation only', items: [] }
    r.criteria[0].status = 'unknown'
    expect(reportCompleteness(r)).toBe('incomplete')
  })
})
