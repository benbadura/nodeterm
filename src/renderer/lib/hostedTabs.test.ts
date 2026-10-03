import { describe, it, expect } from 'vitest'
import { planSharedChange, dismissTab, EMPTY_TAB_SET } from './hostedTabs'

describe('planSharedChange', () => {
  it('opens new shared projects and closes unshared ones, in the host order', () => {
    expect(planSharedChange({ shown: ['a', 'b'], dismissed: [] }, ['c', 'a'])).toEqual({
      open: ['c'], close: ['b'], next: { shown: ['c', 'a'], dismissed: [] }
    })
  })
  it('a tab the user closed is not reopened while it stays shared; unsharing forgets that', () => {
    const set = dismissTab({ shown: ['a', 'b'], dismissed: [] }, 'b')
    expect(set).toEqual({ shown: ['a'], dismissed: ['b'] })
    expect(planSharedChange(set, ['a', 'b']).open).toEqual([])
    const afterUnshare = planSharedChange(set, ['a']).next
    expect(afterUnshare.dismissed).toEqual([])
    expect(planSharedChange(afterUnshare, ['a', 'b']).open).toEqual(['b'])
  })
  it('ignores junk and duplicates in the list', () => {
    expect(planSharedChange(EMPTY_TAB_SET, ['a', 'a', 7 as never, '' ]).next.shown).toEqual(['a'])
  })
})
