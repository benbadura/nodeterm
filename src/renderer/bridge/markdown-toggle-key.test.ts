import { describe, it, expect, vi } from 'vitest'
import {
  markdownToggleKeyVerdict,
  createMarkdownToggleSource,
  type MarkdownToggleKeyEvent,
  type MarkdownToggleSourceDeps
} from './markdown-toggle-key'
import type { ContextElement } from '../lib/keyContext'

const ev = (p: Partial<MarkdownToggleKeyEvent> = {}): MarkdownToggleKeyEvent => ({
  metaKey: false,
  ctrlKey: true,
  shiftKey: false,
  altKey: false,
  key: 'm',
  repeat: false,
  defaultPrevented: false,
  ...p
})
const base = {
  bindings: ['Cmd+M'] as readonly string[],
  isMac: false,
  policy: 'app-first' as const,
  terminalFocused: false
}

describe('markdownToggleKeyVerdict', () => {
  it('toggles on the effective binding (Cmd → Ctrl off-mac)', () => {
    expect(markdownToggleKeyVerdict(ev(), base)).toBe('toggle')
  })

  it('matches exactly — extra modifiers are a different chord', () => {
    expect(markdownToggleKeyVerdict(ev({ shiftKey: true }), base)).toBeNull()
    expect(markdownToggleKeyVerdict(ev({ ctrlKey: false }), base)).toBeNull()
    expect(markdownToggleKeyVerdict(ev({ key: 'n' }), base)).toBeNull()
  })

  it('follows a remap and reads [] (disabled) as never', () => {
    expect(markdownToggleKeyVerdict(ev({ altKey: true }), { ...base, bindings: ['Cmd+Alt+M'] })).toBe(
      'toggle'
    )
    expect(markdownToggleKeyVerdict(ev(), { ...base, bindings: ['Cmd+Alt+M'] })).toBeNull()
    expect(markdownToggleKeyVerdict(ev(), { ...base, bindings: [] })).toBeNull()
  })

  it('uses meta for Cmd on mac', () => {
    const mac = { ...base, isMac: true }
    expect(markdownToggleKeyVerdict(ev({ ctrlKey: false, metaKey: true }), mac)).toBe('toggle')
    expect(markdownToggleKeyVerdict(ev(), mac)).toBeNull()
  })

  it('stands down under terminal-first while a terminal is focused — and ONLY then', () => {
    expect(
      markdownToggleKeyVerdict(ev(), { ...base, policy: 'terminal-first', terminalFocused: true })
    ).toBeNull()
    expect(
      markdownToggleKeyVerdict(ev(), { ...base, policy: 'terminal-first', terminalFocused: false })
    ).toBe('toggle')
    // app-first keeps claiming a focused terminal's chord, exactly like the desktop intercept.
    expect(markdownToggleKeyVerdict(ev(), { ...base, terminalFocused: true })).toBe('toggle')
  })

  it('a held chord is swallowed but never re-toggles', () => {
    expect(markdownToggleKeyVerdict(ev({ repeat: true }), base)).toBe('swallow')
  })

  it('an event a child handler already claimed is left alone', () => {
    expect(markdownToggleKeyVerdict(ev({ defaultPrevented: true }), base)).toBeNull()
  })
})

/** A minimal EventTarget stand-in: records the one listener the source installs. */
function fakeTarget() {
  const listeners = new Set<(e: KeyboardEvent) => void>()
  return {
    listeners,
    addEventListener: vi.fn((type: string, l: (e: KeyboardEvent) => void) => {
      if (type === 'keydown') listeners.add(l)
    }),
    removeEventListener: vi.fn((type: string, l: (e: KeyboardEvent) => void) => {
      if (type === 'keydown') listeners.delete(l)
    }),
    press(p: Partial<MarkdownToggleKeyEvent> = {}) {
      const e = { ...ev(p), preventDefault: vi.fn() }
      for (const l of [...listeners]) l(e as unknown as KeyboardEvent)
      return e
    }
  }
}

function deps(
  target: ReturnType<typeof fakeTarget>,
  over: Partial<MarkdownToggleSourceDeps> = {}
): MarkdownToggleSourceDeps {
  return {
    target,
    bindings: () => ['Cmd+M'],
    isMac: () => false,
    policy: () => 'app-first',
    activeElement: () => null,
    ...over
  }
}

describe('createMarkdownToggleSource', () => {
  it('installs nothing until someone subscribes (buildStubApi has no side effect)', () => {
    const t = fakeTarget()
    createMarkdownToggleSource(deps(t))
    expect(t.addEventListener).not.toHaveBeenCalled()
  })

  it('fans ONE window listener out to every subscriber, and preventDefaults the claim', () => {
    const t = fakeTarget()
    const on = createMarkdownToggleSource(deps(t))
    const a = vi.fn()
    const b = vi.fn()
    on(a)
    on(b)
    expect(t.listeners.size).toBe(1)
    const e = t.press()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(e.preventDefault).toHaveBeenCalled()
  })

  it('an unmatched key is neither prevented nor forwarded', () => {
    const t = fakeTarget()
    const on = createMarkdownToggleSource(deps(t))
    const a = vi.fn()
    on(a)
    const e = t.press({ key: 'x' })
    expect(a).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('a repeat is prevented but not forwarded', () => {
    const t = fakeTarget()
    const on = createMarkdownToggleSource(deps(t))
    const a = vi.fn()
    on(a)
    const e = t.press({ repeat: true })
    expect(a).not.toHaveBeenCalled()
    expect(e.preventDefault).toHaveBeenCalled()
  })

  it('reads terminal focus from the live DOM (xterm helper textarea) against the live policy', () => {
    const t = fakeTarget()
    let policy: 'app-first' | 'terminal-first' = 'terminal-first'
    let focused: ContextElement | null = {
      tagName: 'TEXTAREA',
      classList: { contains: (c: string) => c === 'xterm-helper-textarea' }
    }
    const on = createMarkdownToggleSource(
      deps(t, { policy: () => policy, activeElement: () => focused })
    )
    const a = vi.fn()
    on(a)
    const e = t.press()
    expect(a).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled() // the chord stays with the shell
    focused = { tagName: 'DIV' }
    t.press()
    expect(a).toHaveBeenCalledTimes(1)
    policy = 'app-first'
    focused = {
      tagName: 'TEXTAREA',
      classList: { contains: (c: string) => c === 'xterm-helper-textarea' }
    }
    t.press()
    expect(a).toHaveBeenCalledTimes(2)
  })

  it('reads bindings per keystroke, so a remap applies without resubscribing', () => {
    const t = fakeTarget()
    let bindings: readonly string[] = ['Cmd+M']
    const on = createMarkdownToggleSource(deps(t, { bindings: () => bindings }))
    const a = vi.fn()
    on(a)
    bindings = []
    t.press()
    expect(a).not.toHaveBeenCalled()
  })

  it('unsubscribe detaches that listener; the last one removes the window listener', () => {
    const t = fakeTarget()
    const on = createMarkdownToggleSource(deps(t))
    const a = vi.fn()
    const b = vi.fn()
    const unA = on(a)
    const unB = on(b)
    unA()
    unA() // idempotent
    t.press()
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    expect(t.listeners.size).toBe(1)
    unB()
    expect(t.listeners.size).toBe(0)
    // Re-subscribing re-installs.
    on(a)
    expect(t.listeners.size).toBe(1)
  })
})
