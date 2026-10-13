import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NodeTimestamps } from './NodeTimestamps'

describe('NodeTimestamps', () => {
  it('shows creation and last activity with machine-readable dates and exact-date tooltips', () => {
    const createdAt = Date.parse('2026-10-09T08:15:00Z')
    const lastActivityAt = Date.parse('2026-10-10T14:30:00Z')
    const html = renderToStaticMarkup(<NodeTimestamps id="test" data={{ createdAt, lastActivityAt }} />)
    expect(html).toContain('Created:')
    expect(html).toContain('Last active:')
    expect(html).toContain('dateTime="2026-10-09T08:15:00.000Z"')
    expect(html).toContain('dateTime="2026-10-10T14:30:00.000Z"')
    expect(html).toContain('title="Created:')
  })

  it('renders missing/invalid dates safely and hides background webview ghosts', () => {
    const html = renderToStaticMarkup(<NodeTimestamps id="legacy" data={{ createdAt: NaN, lastActivityAt: Infinity }} />)
    expect(html).toContain('Created: —')
    expect(html).toContain('Last active: —')
    expect(html).not.toContain('<time')
    expect(renderToStaticMarkup(<NodeTimestamps id="legacy" data={{ ghost: true }} />)).toBe('')
  })
})
