import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { showCanvasDots } from './canvasDots'

describe('showCanvasDots', () => {
  it('ships on', () => {
    expect(DEFAULT_SETTINGS.canvasDots).toBe(true)
    expect(showCanvasDots(DEFAULT_SETTINGS.canvasDots)).toBe(true)
  })
  it('only a literal false hides the dots; anything hand-edited keeps them', () => {
    expect(showCanvasDots(false)).toBe(false)
    for (const v of [true, undefined, null, 0, 'false', {}]) expect(showCanvasDots(v)).toBe(true)
  })
})
