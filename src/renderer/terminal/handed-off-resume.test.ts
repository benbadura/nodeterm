import { afterEach, describe, expect, it } from 'vitest'
import { resetColdResumeSkipsForTests, skipNextColdResumeFor, skipsColdResume, takeColdResumeSkip } from './handed-off-resume'

afterEach(() => resetColdResumeSkipsForTests())

describe('the skip-once mark of a project taken back from a hosted team', () => {
  it('marks the terminal nodes only (a legacy node without a kind is one)', () => {
    skipNextColdResumeFor([{ id: 't', kind: 'terminal' }, { id: 'legacy' } as never, { id: 's', kind: 'sticky' }])
    expect(takeColdResumeSkip('t')).toBe(true)
    expect(takeColdResumeSkip('legacy')).toBe(true)
    expect(takeColdResumeSkip('s')).toBe(false)
  })

  it('is consumed once: the next mount of the same node resumes as usual', () => {
    skipNextColdResumeFor([{ id: 't', kind: 'terminal' }])
    expect(takeColdResumeSkip('t')).toBe(true)
    expect(takeColdResumeSkip('t')).toBe(false)
  })
})

describe('skipsColdResume', () => {
  it('skips only a relaunch that would have happened', () => {
    expect(skipsColdResume({ coldStart: true, canColdRestore: true, marked: true })).toBe(true)
    // Unmarked: the ordinary cold restore.
    expect(skipsColdResume({ coldStart: true, canColdRestore: true, marked: false })).toBe(false)
    // A warm attach relaunches nothing, and neither does a node that could not cold-restore (a
    // relay tab, a paused or armed node, a plain terminal): nothing to skip, nothing to say.
    expect(skipsColdResume({ coldStart: false, canColdRestore: true, marked: true })).toBe(false)
    expect(skipsColdResume({ coldStart: true, canColdRestore: false, marked: true })).toBe(false)
  })
})
