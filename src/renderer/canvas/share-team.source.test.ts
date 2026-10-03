import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the "Share with team" glue in Canvas.tsx, the same class of test as
 * `hosted-team.source.test.ts`: the behaviour is proven against the real modules
 * (`lib/shareSshTeam.test.ts` for the order and every undo, `lib/shareTeamCanvas.test.ts` for the
 * store steps and the tab follow, `components/ShareTeamDialog.test.tsx` for the dialog). What only a
 * source read can pin is which Canvas actions those steps are bound to.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function between(start: string, end: string): string {
  const a = src.indexOf(start)
  expect(a, start).toBeGreaterThan(-1)
  const b = src.indexOf(end, a + start.length)
  expect(b, end).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('Share with team glue in Canvas', () => {
  const body = between('const startShare = useCallback(', '\n  )\n')

  it('closes through the non-destructive close, never the confirm-raising wrapper', () => {
    expect(body).toContain('close: () => performCloseProject(projectId)')
    expect(body).not.toMatch(/\bcloseProject\(/)
  })

  it('reopens through the unchecked reopen (the share undoes its own close without a question)', () => {
    expect(body).toContain('reopen: () => reopenProjectUnchecked(projectId)')
    // The human reopen asks first for a handed-off project, then goes through the same unchecked one.
    const human = between('const reopenProject = useCallback(', '\n  )\n')
    expect(human).toContain('confirmHandedOffReopen(id)')
    expect(human).toContain('reopenProjectUnchecked(id)')
  })

  it('never undoes anything itself: the orchestrator owns every undo', () => {
    expect(body).not.toMatch(/\bcatch\b/)
    expect(body).toContain('return runShare(')
  })

  it('a busy join follows the shared tab; the joiner answer is returned, not dropped', () => {
    expect(body).toContain('join: joinApprovedTeam')
    expect(body).toContain('followTab: followSharedTab')
    const join = between('const joinApprovedTeam = useCallback(', '}, [])')
    expect(join).toContain('return hostedJoinerRef.current?.joinApproved(')
  })

  it('every entry opens through one gate', () => {
    expect(src).toContain('onShareWithTeam={openShareWithTeam}')
    expect(src).toContain('shareBlockedReason={shareBlockedReason}')
    expect(src).toContain("onClick: () => openShareWithTeam(projectId)")
    expect(src).toContain('run: () => openShareWithTeam(activeProject.id)')
  })
})
