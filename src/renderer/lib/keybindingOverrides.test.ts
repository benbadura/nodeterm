import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { matchesShortcut, type ShortcutKeyEvent } from '@shared/shortcut'
import { terminalKeyAction } from '../terminal/terminal-config'
import { useSettings } from '../state/settings'
import {
  activeKeybindingOverrides, effectiveBindings, commandKeys, commandTooltip, chipFor,
  setKeybindingOverride, commandKeysFor, dictationBinding,
  terminalShortcutPolicy, terminalChordBubbles, noteTerminalCapture
} from './keybindingOverrides'

const setKb = (kb: unknown) =>
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keybindings: kb as never } })

beforeEach(() => setKb(undefined))

describe('activeKeybindingOverrides', () => {
  it('absent key means no overrides, silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(activeKeybindingOverrides()).toEqual({})
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
  it('sanitizes and memoizes by reference, warning once per change', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setKb({ 'node.newTerminal': ['Cmd+Shift+Y'], 'bogus.command': ['Cmd+X'] })
    const first = activeKeybindingOverrides()
    expect(first).toEqual({ 'node.newTerminal': ['Cmd+Shift+Y'] })
    expect(activeKeybindingOverrides()).toBe(first)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('effectiveBindings / commandKeys / commandTooltip', () => {
  it('defaults flow through when no override exists', () => {
    expect(effectiveBindings('app.commandPalette')).toEqual(['Cmd+K'])
  })
  it('an override replaces the default everywhere', () => {
    setKb({ 'panel.sessions': ['Cmd+Alt+L'] })
    expect(commandKeys('panel.sessions', true)).toEqual(['⌘', '⌥', 'L'])
    expect(commandTooltip('Sessions', 'panel.sessions', true)).toBe('Sessions (⌘⌥L)')
  })
  it('matches the legacy hintLabel formatting on both platforms for the defaults', () => {
    expect(commandTooltip('Sessions', 'panel.sessions', true)).toBe('Sessions (⌘⇧L)')
    expect(commandTooltip('Sessions', 'panel.sessions', false)).toBe('Sessions (Ctrl+Shift+L)')
  })
  it('resolves the defaults with the SAME platform it formats with', () => {
    // terminal.copySelection is the one command whose defaults differ per platform, so it is
    // the only case that can catch a commandKeys that resolves with isMacPlatform() (true in
    // node) while formatting for the caller's platform.
    expect(commandKeys('terminal.copySelection', true)).toEqual(['⌘', 'C'])
    expect(commandKeys('terminal.copySelection', false)).toEqual(['Ctrl', 'Shift', 'C'])
  })
  it('unbound commands render without a chord suffix', () => {
    expect(commandTooltip('Fit all', 'canvas.fitAll', true)).toBe('Fit all')
    expect(commandKeys('canvas.fitAll', true)).toEqual([])
  })
})

// The exact composition SourceControlPanel's commit textarea now runs on keydown. It replaced a
// lax `(e.metaKey || e.ctrlKey) && e.key === 'Enter'`, so the D-strict losses below are pinned
// here rather than asserted in prose: matching is EXACT on all four modifiers.
describe('the commit textarea matcher (scm.commit)', () => {
  const key = (over: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent =>
    ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: 'Enter', ...over })
  const commits = (e: ShortcutKeyEvent, isMac: boolean) =>
    effectiveBindings('scm.commit').some((s) => matchesShortcut(e, s, isMac))

  it('commits on the platform chord', () => {
    expect(commits(key({ metaKey: true }), true)).toBe(true)
    expect(commits(key({ ctrlKey: true }), false)).toBe(true)
  })
  it('no longer commits on the OTHER platform primary (the named D-strict losses)', () => {
    expect(commits(key({ ctrlKey: true }), true)).toBe(false) // mac Ctrl+Enter
    expect(commits(key({ metaKey: true }), false)).toBe(false) // non-mac Meta+Enter
  })
  it('no longer commits with an extra modifier held on top', () => {
    expect(commits(key({ metaKey: true, shiftKey: true }), true)).toBe(false)
    expect(commits(key({ metaKey: true, altKey: true }), true)).toBe(false)
  })
  it('follows a remap, so the key agrees with the placeholder chip', () => {
    setKb({ 'scm.commit': ['Cmd+Shift+Enter'] })
    expect(commits(key({ metaKey: true }), true)).toBe(false)
    expect(commits(key({ metaKey: true, shiftKey: true }), true)).toBe(true)
    expect(chipFor('scm.commit', true)).toBe('⌘⇧Enter')
  })
  it('is inert when unbound — the placeholder drops its chord for the same reason', () => {
    setKb({ 'scm.commit': [] })
    expect(commits(key({ metaKey: true }), true)).toBe(false)
    expect(chipFor('scm.commit', true)).toBe('')
  })
  it('plain Enter never commits (it types a newline)', () => {
    expect(commits(key(), true)).toBe(false)
  })
})

describe('chipFor', () => {
  it('renders the bare chord the way each platform spells it', () => {
    expect(chipFor('app.commandPalette', true)).toBe('⌘K')
    expect(chipFor('app.commandPalette', false)).toBe('Ctrl+K')
  })
  it('follows a remap', () => {
    setKb({ 'app.commandPalette': ['Cmd+Shift+P'] })
    expect(chipFor('app.commandPalette', true)).toBe('⌘⇧P')
  })
  it('is empty for an unbound command, so callers can fall back', () => {
    expect(chipFor('canvas.fitAll', true)).toBe('')
  })
})

describe('setKeybindingOverride', () => {
  it('set, disable, and reset shape the map correctly', () => {
    setKeybindingOverride('node.newTerminal', ['Cmd+Shift+T'])
    expect(useSettings.getState().settings.keybindings).toEqual({
      'node.newTerminal': ['Cmd+Shift+T']
    })
    setKeybindingOverride('canvas.undo', [])
    expect(useSettings.getState().settings.keybindings?.['canvas.undo']).toEqual([])
    setKeybindingOverride('node.newTerminal', null)
    expect('node.newTerminal' in (useSettings.getState().settings.keybindings ?? {})).toBe(false)
  })
  it('mirrors speech.dictation into speech.shortcut, and reset restores the default mirror', () => {
    setKeybindingOverride('speech.dictation', ['Cmd+Alt+D'])
    expect(useSettings.getState().settings.speech.shortcut).toBe('Cmd+Alt+D')
    setKeybindingOverride('speech.dictation', null)
    expect(useSettings.getState().settings.speech.shortcut).toBe(DEFAULT_SETTINGS.speech.shortcut)
  })
})

// NODE ENV, deliberately: this file runs without jsdom (see the note on noteTerminalCapture), so
// only the SETTINGS side is asserted here — WHETHER a notice is raised (the policy gate, the
// once-ever ledger), never what it looks like.
//
// The other side is `components/ShortcutCaptureBanner.test.tsx` (jsdom): it dispatches
// 'nodeterm:shortcut-captured' ITSELF and asserts what the banner does with it — copy, replacement,
// the 12s clock, dismissal, and the two silent cases (unknown id, unbound command). Be precise
// about the seam: nothing presses `noteTerminalCapture`'s own `window.dispatchEvent` line, which is
// `typeof window` guarded and cannot run here. The two files meet at the event NAME and its
// `detail.commandId` shape, and that agreement is by convention, not by a test.
describe('terminalShortcutPolicy / noteTerminalCapture', () => {
  const seen = () => useSettings.getState().settings.seenShortcutCaptureNotices
  const setSettings = (patch: Record<string, unknown>) =>
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, ...patch } as never })

  it('normalizes the setting', () => {
    expect(terminalShortcutPolicy()).toBe('app-first')
    setSettings({ terminalShortcutPolicy: 'terminal-first' })
    expect(terminalShortcutPolicy()).toBe('terminal-first')
  })
  it('a hand-edited garbage policy reads as app-first, not as the raw value', () => {
    // settings.json is hand-editable, so the compile-time type is not a runtime guarantee —
    // and the unknown value must degrade to today's behavior, never to terminal-first.
    setSettings({ terminalShortcutPolicy: 'shell-first' })
    expect(terminalShortcutPolicy()).toBe('app-first')
  })
  it('notes a capture once, persists the id, and is silent under terminal-first', () => {
    noteTerminalCapture('app.commandPalette')
    noteTerminalCapture('app.commandPalette')
    expect(seen()).toEqual(['app.commandPalette'])
    setSettings({
      terminalShortcutPolicy: 'terminal-first',
      seenShortcutCaptureNotices: ['app.commandPalette']
    })
    noteTerminalCapture('canvas.undo')
    expect(seen()).toEqual(['app.commandPalette'])
  })
  it('appends to the ids already seen rather than replacing them', () => {
    setSettings({ seenShortcutCaptureNotices: ['app.settings'] })
    noteTerminalCapture('app.commandPalette')
    expect(seen()).toEqual(['app.settings', 'app.commandPalette'])
  })
  it('a hand-edited seenShortcutCaptureNotices of the wrong shape reads as empty', () => {
    // `.includes` on a string would answer TRUE for any substring of it, silently swallowing
    // the first notice; on a non-array it would throw inside a keydown handler.
    setSettings({ seenShortcutCaptureNotices: 'garbage' })
    noteTerminalCapture('app.commandPalette')
    expect(seen()).toEqual(['app.commandPalette'])
  })
  it('drops non-string entries from a hand-edited list instead of carrying them forward', () => {
    setSettings({ seenShortcutCaptureNotices: ['app.settings', 7, null] })
    noteTerminalCapture('app.commandPalette')
    expect(seen()).toEqual(['app.settings', 'app.commandPalette'])
  })
  it('does not throw with no window (the guard node-env dispatch depends on)', () => {
    expect(typeof window).toBe('undefined')
    expect(() => noteTerminalCapture('app.commandPalette')).not.toThrow()
  })
})

describe('commandKeysFor / dictationBinding', () => {
  it('lists every effective binding', () => {
    expect(commandKeysFor('canvas.deleteSelection', true)).toEqual([['Delete'], ['Backspace']])
    expect(commandKeysFor('canvas.fitAll', true)).toEqual([])
  })
  it('dictationBinding follows the override and reports disabled as empty', () => {
    expect(dictationBinding()).toBe('Cmd+Alt')
    setKeybindingOverride('speech.dictation', ['Cmd+Alt+D'])
    expect(dictationBinding()).toBe('Cmd+Alt+D')
    setKeybindingOverride('speech.dictation', [])
    expect(dictationBinding()).toBe('')
  })
})

describe('terminalChordBubbles', () => {
  // Platform-independent by construction: every case pins an explicit literal-Ctrl override, so
  // the assertions do not depend on which platform the test host reports.
  const bubbleEv = (p: Partial<ShortcutKeyEvent>): ShortcutKeyEvent => ({
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    key: 'ArrowLeft',
    ...p
  })

  it('true for an allowInTerminal canvas command the dispatcher would claim', () => {
    setKb({ 'node.focusLeft': ['Ctrl+Shift+ArrowLeft'] })
    expect(
      terminalChordBubbles(bubbleEv({ ctrlKey: true, shiftKey: true, key: 'ArrowLeft' }), false)
    ).toBe(true)
  })

  it('false under terminal-first — the chord stays with the shell', () => {
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        keybindings: { 'node.focusLeft': ['Ctrl+Shift+ArrowLeft'] } as never,
        terminalShortcutPolicy: 'terminal-first'
      }
    })
    expect(
      terminalChordBubbles(bubbleEv({ ctrlKey: true, shiftKey: true, key: 'ArrowLeft' }), false)
    ).toBe(false)
  })

  it('false over the kanban board for a canvas-scope command', () => {
    setKb({ 'node.focusLeft': ['Ctrl+Shift+ArrowLeft'] })
    expect(
      terminalChordBubbles(bubbleEv({ ctrlKey: true, shiftKey: true, key: 'ArrowLeft' }), true)
    ).toBe(false)
  })

  it('false for a terminal-scope command — its local listener owns the chord', () => {
    setKb({ 'terminal.find': ['Ctrl+Shift+F1'] })
    expect(
      terminalChordBubbles(bubbleEv({ ctrlKey: true, shiftKey: true, key: 'F1' }), false)
    ).toBe(false)
  })

  it('keeps Ctrl+W in xterm when main stands down for a focused terminal', () => {
    setKb({ 'node.close': ['Ctrl+W'] })
    const event = {
      ...bubbleEv({ ctrlKey: true, key: 'w' }),
      type: 'keydown',
      code: 'KeyW'
    }
    const bubbles = terminalChordBubbles(event, false)

    expect(bubbles).toBe(false)
    expect(terminalKeyAction(event, false, false, bubbles)).toBe('pass')
  })

  it('bubbles the markdown toggle out of a focused terminal (its window listener owns it)', () => {
    // The Server Edition's `onMarkdownToggle` is a window keydown listener; if xterm kept the
    // chord it would write \r and cancel the event, and ⌘M would be dead in every focused
    // terminal. On desktop main claims it above the page, so this never runs there under
    // app-first, and under terminal-first the resolver refuses it (next case).
    setKb({ 'node.toggleMarkdown': ['Ctrl+M'] })
    const event = { ...bubbleEv({ ctrlKey: true, key: 'm' }), type: 'keydown', code: 'KeyM' }
    const bubbles = terminalChordBubbles(event, false)
    expect(bubbles).toBe(true)
    expect(terminalKeyAction(event, false, false, bubbles)).toBe('bubble')
    // Over the board too: the card modal's terminal is a markdown-toggle target as well.
    expect(terminalChordBubbles(event, true)).toBe(true)
  })

  it('keeps the markdown toggle in xterm under terminal-first', () => {
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        keybindings: { 'node.toggleMarkdown': ['Ctrl+M'] } as never,
        terminalShortcutPolicy: 'terminal-first'
      }
    })
    expect(terminalChordBubbles(bubbleEv({ ctrlKey: true, key: 'm' }), false)).toBe(false)
  })

  it('false for a chord nothing resolves', () => {
    setKb(undefined)
    expect(
      terminalChordBubbles(bubbleEv({ ctrlKey: true, shiftKey: true, key: 'F12' }), false)
    ).toBe(false)
  })
})
