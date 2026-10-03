import { describe, it, expect, vi } from 'vitest'
import type { CommandId } from '@shared/keybindings'
import { dispatchGlobalKeydown, type GlobalKeydownDeps, type GlobalKeyEvent } from './globalKeybindings'
import { XTERM_INPUT_CLASS, type ContextElement } from './keyContext'

const ev = (over: Partial<GlobalKeyEvent>): GlobalKeyEvent => ({
  metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: '',
  defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true },
  ...over
})
const noGesture = () => false
const noGestures = {
  keyedDictation: noGesture, zoom: noGesture, projectJump: noGesture, copy: noGesture
}
/** xterm's hidden helper textarea — what `activeElement` reports whenever a terminal owns
 *  the keyboard, i.e. the only element shape that makes `ctx.terminal` true. */
const xtermEl = (): ContextElement => ({
  tagName: 'TEXTAREA', classList: { contains: (n: string) => n === XTERM_INPUT_CLASS }
})
const deps = (over: Partial<GlobalKeydownDeps> = {}): GlobalKeydownDeps => ({
  activeElement: () => null,
  kanbanOpen: () => false,
  overrides: () => ({}),
  isMac: true,
  terminalFirst: () => false,
  handlers: {},
  gestures: { ...noGestures },
  ...over
})

describe('dispatchGlobalKeydown', () => {
  it('bails on defaultPrevented without touching anything', () => {
    const dictation = vi.fn()
    const d = deps({ gestures: { keyedDictation: dictation, zoom: noGesture, projectJump: noGesture, copy: noGesture } })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: 'k', defaultPrevented: true }), d)).toBe(false)
    expect(dictation).not.toHaveBeenCalled()
  })
  it('runs a claimed registry handler and preventDefaults', () => {
    const e = ev({ metaKey: true, key: 'k' })
    const palette = vi.fn(() => true)
    expect(dispatchGlobalKeydown(e, deps({ handlers: { 'app.commandPalette': palette } }))).toBe(true)
    expect(e.defaultPrevented).toBe(true)
  })
  it('a declining handler leaves the key alone (falls through to the platform)', () => {
    const e = ev({ metaKey: true, key: 'k' })
    expect(dispatchGlobalKeydown(e, deps({ handlers: { 'app.commandPalette': () => false } }))).toBe(false)
    expect(e.defaultPrevented).toBe(false)
  })
  it('a resolved command with no registered handler is not claimed', () => {
    const e = ev({ metaKey: true, key: 'w' })  // node.close: main-intercepted on desktop, browser-owned in SE
    expect(dispatchGlobalKeydown(e, deps())).toBe(false)
    expect(e.defaultPrevented).toBe(false)
  })
  it('keyed dictation wins over a colliding registry default, but not while typing or in terminal', () => {
    const dictation = vi.fn((e: GlobalKeyEvent) => { e.preventDefault(); return true })
    const term = vi.fn(() => true)
    const g = { keyedDictation: dictation, zoom: noGesture, projectJump: noGesture, copy: noGesture }
    const d = deps({ gestures: g, handlers: { 'node.newTerminal': term } })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: 't' }), d)).toBe(true)
    expect(term).not.toHaveBeenCalled()
    const typing = deps({ gestures: g, activeElement: () => ({ tagName: 'INPUT' }) })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: 't' }), typing)).toBe(false)
    const terminal = deps({ gestures: g, activeElement: xtermEl })
    dispatchGlobalKeydown(ev({ metaKey: true, key: 't' }), terminal)
    expect(dictation).toHaveBeenCalledTimes(1)
  })
  it('typing blocks canvas AND app commands (the announced D-typing guard fix)', () => {
    const palette = vi.fn(() => true)
    const undo = vi.fn(() => true)
    const typing = deps({
      activeElement: () => ({ tagName: 'DIV', isContentEditable: true }),
      handlers: { 'app.commandPalette': palette, 'canvas.undo': undo }
    })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: 'z' }), typing)).toBe(false)
    expect(undo).not.toHaveBeenCalled()
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: 'k' }), typing)).toBe(false)
    expect(palette).not.toHaveBeenCalled()
    // NOTE: app-scope commands lack allowWhileTyping in the registry, so typing blocks them
    // too — that IS the announced D-typing delta (today Cmd+K fires while renaming a node).
  })
  it('kanban keeps app commands live and canvas commands inert', () => {
    const toggle = vi.fn(() => true)
    const undo = vi.fn(() => true)
    const d = deps({ kanbanOpen: () => true, handlers: { 'view.kanbanToggle': toggle, 'canvas.undo': undo } })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, shiftKey: true, key: 'b' }), d)).toBe(true)
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: 'z' }), d)).toBe(false)
    expect(undo).not.toHaveBeenCalled()
  })
  // The claim protocol's second half: a RESOLVED chord is spent, whoever declined it. The two
  // tests above only prove it is not claimed — with claiming gestures wired in, a fall-through
  // into them would reinterpret the same chord as a zoom/jump/copy.
  it('a resolved command never reaches a gesture, declined or unhandled', () => {
    const claimAll = vi.fn(() => true)
    const g = { keyedDictation: noGesture, zoom: claimAll, projectJump: claimAll, copy: claimAll }
    const declined = ev({ metaKey: true, key: 'k' })
    expect(dispatchGlobalKeydown(declined, deps({ gestures: g, handlers: { 'app.commandPalette': () => false } }))).toBe(false)
    const unhandled = ev({ metaKey: true, key: 'w' })
    expect(dispatchGlobalKeydown(unhandled, deps({ gestures: g }))).toBe(false)
    expect(claimAll).not.toHaveBeenCalled()
  })
  it('gestures run after a registry miss, in zoom → projectJump → copy order', () => {
    const order: string[] = []
    const g = {
      keyedDictation: noGesture,
      zoom: () => { order.push('zoom'); return false },
      projectJump: () => { order.push('jump'); return false },
      copy: () => { order.push('copy'); return false }
    }
    expect(dispatchGlobalKeydown(ev({ key: '!' , shiftKey: true }), deps({ gestures: g }))).toBe(false)
    expect(order).toEqual(['zoom', 'jump', 'copy'])
  })
  it('the kanban board blocks the keyed-dictation gesture entirely', () => {
    // The gate is `!typing && !terminal && !kanbanOpen`. Dropping the kanban half leaves a
    // dictation overlay firing over the board with nothing on screen that asked for it — and
    // the board is exactly where the canvas-only-shortcut discipline says gestures go quiet.
    const dictation = vi.fn(() => true)
    const g = { keyedDictation: dictation, zoom: noGesture, projectJump: noGesture, copy: noGesture }
    const d = deps({ kanbanOpen: () => true, gestures: g })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, altKey: true, key: 'd' }), d)).toBe(false)
    expect(dictation).not.toHaveBeenCalled()
  })
  it('a claiming trailing gesture short-circuits: the later ones never run', () => {
    // The `if (...) return true` chain, not a run-them-all fan-out. Turning any of the three
    // into an unconditional call would let one chord be interpreted twice (zoom AND jump).
    const zoom = vi.fn(() => true)
    const projectJump = vi.fn(() => true)
    const copy = vi.fn(() => true)
    const g = { keyedDictation: noGesture, zoom, projectJump, copy }
    expect(dispatchGlobalKeydown(ev({ shiftKey: true, key: '!' }), deps({ gestures: g }))).toBe(true)
    expect(zoom).toHaveBeenCalledTimes(1)
    expect(projectJump).not.toHaveBeenCalled()
    expect(copy).not.toHaveBeenCalled()
  })
  it('overrides reroute dispatch', () => {
    const fit = vi.fn(() => true)
    const d = deps({
      overrides: () => ({ 'app.commandPalette': [], 'canvas.fitAll': ['Cmd+K'] }),
      handlers: { 'canvas.fitAll': fit }
    })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: 'k' }), d)).toBe(true)
    expect(fit).toHaveBeenCalled()
  })
  it('terminal-first: trailing gestures are not offered while a terminal has focus', () => {
    // The registry half of terminal-first lives in the resolver; the gestures never went
    // through it, so without this gate Cmd+0 would still zoom the canvas out from under a
    // user who reserved every chord for the shell.
    const zoom = vi.fn(() => true)
    const d = deps({
      terminalFirst: () => true,
      activeElement: xtermEl,
      gestures: { ...noGestures, zoom }
    })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: '0' }), d)).toBe(false)
    expect(zoom).not.toHaveBeenCalled()
  })
  it('app-first: a terminal-context claim reports a capture exactly at claim time', () => {
    const captured: string[] = []
    const d = deps({
      activeElement: xtermEl,
      handlers: { 'app.commandPalette': () => true },
      onTerminalCapture: (id) => captured.push(id)
    })
    dispatchGlobalKeydown(ev({ metaKey: true, key: 'k' }), d)
    expect(captured).toEqual(['app.commandPalette'])
  })
  it('no capture report outside terminal focus, on decline, or under terminal-first', () => {
    const captured: string[] = []
    const base = { onTerminalCapture: (id: CommandId) => captured.push(id) }
    // Plain app focus: nothing was taken from a terminal.
    dispatchGlobalKeydown(ev({ metaKey: true, key: 'k' }),
      deps({ ...base, handlers: { 'app.commandPalette': () => true } }))
    // Declined: the chord fell through to the PTY, so nothing was captured.
    dispatchGlobalKeydown(ev({ metaKey: true, key: 'k' }),
      deps({ ...base, activeElement: xtermEl, handlers: { 'app.commandPalette': () => false } }))
    // A TERMINAL-scope claim under terminal-first is the terminal's own key — legitimate
    // ownership, not a capture.
    dispatchGlobalKeydown(ev({ metaKey: true, key: 'f' }),
      deps({ ...base, activeElement: xtermEl, terminalFirst: () => true,
             handlers: { 'terminal.find': () => true } }))
    expect(captured).toEqual([])
  })
  it('a terminal-scope claim under APP-first is ownership too, not a capture', () => {
    // The scope check is the load-bearing half: gating only on `!terminalFirst` would report
    // Cmd+F ("Find in terminal") as a chord app-first stole from the terminal.
    const captured: string[] = []
    const d = deps({
      activeElement: xtermEl,
      handlers: { 'terminal.find': () => true },
      onTerminalCapture: (id: CommandId) => captured.push(id)
    })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: 'f' }), d)).toBe(true)
    expect(captured).toEqual([])
  })
})

// The board's bare keys ride the same one dispatcher. What makes a bare `j` safe is the resolver's
// refusals, so they are pinned here at the level a real keydown goes through.
describe('dispatchGlobalKeydown — board keys', () => {
  const textarea = (): ContextElement => ({ tagName: 'TEXTAREA', classList: { contains: () => false } })

  it('a bare j on an open board reaches board.nextCard and is claimed', () => {
    const next = vi.fn(() => true)
    const e = ev({ key: 'j' })
    expect(dispatchGlobalKeydown(e, deps({ kanbanOpen: () => true, handlers: { 'board.nextCard': next } }))).toBe(true)
    expect(next).toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(true)
  })

  it('never on the canvas, never in the comment box, never in the modal terminal', () => {
    const next = vi.fn(() => true)
    const handlers = { 'board.nextCard': next }
    expect(dispatchGlobalKeydown(ev({ key: 'j' }), deps({ handlers }))).toBe(false)
    expect(dispatchGlobalKeydown(ev({ key: 'j' }), deps({ kanbanOpen: () => true, activeElement: textarea, handlers }))).toBe(false)
    expect(dispatchGlobalKeydown(ev({ key: 'j' }), deps({ kanbanOpen: () => true, activeElement: xtermEl, handlers }))).toBe(false)
    expect(next).not.toHaveBeenCalled()
  })

  it('a board that declines (nothing to move to) leaves the key to the platform', () => {
    const e = ev({ key: ' ' })
    expect(dispatchGlobalKeydown(e, deps({ kanbanOpen: () => true, handlers: { 'board.openCard': () => false } }))).toBe(false)
    expect(e.defaultPrevented).toBe(false)
  })
})
