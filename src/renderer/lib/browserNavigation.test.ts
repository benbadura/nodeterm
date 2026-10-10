import { describe, expect, it } from 'vitest'
import { browserNavigationData } from './browserNavigation'

describe('browser navigation after naming', () => {
  it('updates the URL without replacing an explicitly chosen title', () => {
    const current = { title: 'Release Research', titleAuto: false, url: 'https://old.test', id: 'b' }
    expect(browserNavigationData(current, { title: 'Page Title', url: 'https://new.test' })).toEqual({
      ...current, url: 'https://new.test'
    })
  })

  it('keeps tracking page titles for automatic and legacy nodes', () => {
    for (const titleAuto of [undefined, true]) {
      expect(browserNavigationData({ titleAuto, title: 'Old' }, { title: 'Page Title' }).title).toBe('Page Title')
    }
  })
})
