// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'

it('does not restore an old denominator from persistent browser state', async () => {
  localStorage.setItem('nodeterm.contextWindow', JSON.stringify({ old: { sessionId: 'old', windowTokens: 200000 }, claude: { sessionId: 'claude', windowSource: 'session-env', windowTokens: 32000 }, own: { sessionId: 'own', windowSource: 'transcript', windowTokens: 64000 } }))
  vi.resetModules()
  const { useContextWindow } = await import('./contextWindow')
  expect(useContextWindow.getState().bySessionId).toEqual({ own: { sessionId: 'own', windowSource: 'transcript', windowTokens: 64000 } })
  localStorage.clear()
})
