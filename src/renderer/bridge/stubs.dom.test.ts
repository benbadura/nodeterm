// @vitest-environment jsdom
//
// The Server Edition's ⌘M path end to end through the REAL stub surface: a keydown dispatched on
// the browser `window` must reach an `onMarkdownToggle` subscriber, following the user's live
// `node.toggleMarkdown` binding from the settings store. (jsdom reports a non-mac platform, so the
// default `Cmd+M` resolves to Ctrl+M here.)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from '../state/settings'
import { buildStubApi } from './stubs'

const press = (init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(e)
  return e
}

beforeEach(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS } }))

describe('bridge onMarkdownToggle (browser)', () => {
  it('fires on the default chord and claims it; stops after unsubscribe', () => {
    const s = buildStubApi()
    const cb = vi.fn()
    const un = s.onMarkdownToggle(cb)
    const e = press({ key: 'm', ctrlKey: true })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
    un()
    press({ key: 'm', ctrlKey: true })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('follows a remap from the settings store', () => {
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, keybindings: { 'node.toggleMarkdown': ['Cmd+Alt+M'] } }
    })
    const s = buildStubApi()
    const cb = vi.fn()
    const un = s.onMarkdownToggle(cb)
    press({ key: 'm', ctrlKey: true })
    expect(cb).not.toHaveBeenCalled()
    press({ key: 'm', ctrlKey: true, altKey: true })
    expect(cb).toHaveBeenCalledTimes(1)
    un()
  })
})

describe('bridge onMarkdownToggle (browser) — terminal-first', () => {
  it('stands down for a focused xterm textarea, read live from document.activeElement', () => {
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, terminalShortcutPolicy: 'terminal-first' }
    })
    const ta = document.createElement('textarea')
    ta.className = 'xterm-helper-textarea'
    document.body.appendChild(ta)
    const s = buildStubApi()
    const cb = vi.fn()
    const un = s.onMarkdownToggle(cb)
    try {
      ta.focus()
      expect(document.activeElement).toBe(ta)
      // Dispatched on the focused textarea so it bubbles to window like a real keystroke.
      const e = new KeyboardEvent('keydown', {
        key: 'm',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
      ta.dispatchEvent(e)
      expect(cb).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(false) // the chord stays with the shell
      // Focus leaves the terminal: the same policy no longer stands it down.
      ta.blur()
      press({ key: 'm', ctrlKey: true })
      expect(cb).toHaveBeenCalledTimes(1)
    } finally {
      un()
      ta.remove()
    }
  })
})
