// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { GitHubPullChecksResult } from '@shared/github-pull-status'
import { PullChecks } from './GitHubIssueSummaryModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HEAD = 'a'.repeat(40)
const ok: GitHubPullChecksResult = {
  status: 'ok', headRefOid: HEAD, truncated: false,
  checks: [{ name: 'quality', state: 'passed', url: 'https://github.com/x/1' }, { name: 'windows', state: 'failed' }]
}

function render(result: GitHubPullChecksResult | 'loading' | null, expectedHead?: string): HTMLElement {
  const host = document.createElement('div')
  act(() => createRoot(host).render(<PullChecks result={result} expectedHead={expectedHead} onOpen={vi.fn()} />))
  return host
}

describe('PullChecks', () => {
  it('lists the checks read at the head the status line shows', () => {
    const host = render(ok, HEAD)
    expect(host.textContent).toContain('quality')
    expect(host.textContent).toContain('windows')
  })

  it('never shows checks from another commit under the current head', () => {
    const host = render(ok, 'b'.repeat(40))
    expect(host.textContent).not.toContain('quality')
    expect(host.textContent).toContain('branch moved')
  })

  it('shows nothing when the token may not read checks, and says so in words when there are none', () => {
    expect(render({ status: 'hidden' }, HEAD).textContent).toBe('')
    expect(render({ status: 'no-checks' }, HEAD).textContent).toContain('No checks')
    expect(render({ status: 'no-checks' }, HEAD).textContent).not.toContain('✓')
  })
})
