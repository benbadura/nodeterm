// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ContextMeter } from './ContextMeter'
import { useContextWindow } from '../state/contextWindow'

it('qualifies model-name guesses but not observed session configuration', async () => {
  const el = document.createElement('div')
  const root = createRoot(el)
  const usage = { sessionId: 's', usedTokens: 16000, windowTokens: 32000, usedPercent: 50, model: 'vendor-sonnet', updatedAt: Date.now() }
  try {
    useContextWindow.getState().set({ ...usage, windowSource: 'estimate' })
    await act(async () => root.render(<ContextMeter sessionId="s" />))
    expect(el.querySelector('button')?.title).toContain('Estimated context window')
    await act(async () => { useContextWindow.getState().set({ ...usage, windowSource: 'session-env' }) })
    expect(el.querySelector('button')?.title).toMatch(/^Context window/)
  } finally { await act(async () => root.unmount()) }
})
