import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { isSpaceRelease, spacePanKeydown, typingTarget } from './spacePan'

const el = (tagName: string, contentEditable = false): Element =>
  ({ tagName, isContentEditable: contentEditable }) as unknown as Element

/**
 * Issue #86 asked for the Figma gesture: hold space, left-drag, pan. The tests that matter are the
 * REFUSALS — space is not a spare key on this canvas, it is a character in every terminal and every
 * note, and a space swallowed there is a wrong character in the user's text rather than a missing
 * pan. That is a worse bug than the one being fixed, so it is the one pinned hardest.
 */
describe('spacePanKeydown', () => {
  it('engages on a plain space over the canvas', () => {
    expect(spacePanKeydown({ key: ' ' }, null)).toBe('engage')
    expect(spacePanKeydown({ key: ' ' }, el('DIV'))).toBe('engage')
    expect(spacePanKeydown({ key: ' ' }, el('BUTTON'))).toBe('engage')
  })

  // The kanban board covers the canvas while it is up (the canvas stays MOUNTED underneath), so a
  // pan there moves nothing anyone can see — and the capture-phase preventDefault used to swallow
  // every space on the board: a focused board button could not be pressed with it, and the board's
  // own Space ("open the focused card") never received it.
  it('never engages while the canvas is covered by a board', () => {
    expect(spacePanKeydown({ key: ' ' }, null, true)).toBe('ignore')
    expect(spacePanKeydown({ key: ' ' }, el('BUTTON'), true)).toBe('ignore')
    expect(spacePanKeydown({ key: ' ' }, null, false)).toBe('engage')
  })

  it('NEVER takes a space that is being typed', () => {
    for (const target of [el('TEXTAREA'), el('INPUT'), el('DIV', true)]) {
      expect(spacePanKeydown({ key: ' ' }, target)).toBe('ignore')
    }
  })

  it('leaves a focused TERMINAL alone — xterm types through a hidden textarea', () => {
    // No special case for xterm anywhere in this feature; this is why none is needed.
    expect(typingTarget(el('TEXTAREA'))).toBe(true)
  })

  it('leaves the Monaco EDITOR alone — it types through an EditContext, not a textarea (#930)', () => {
    // Monaco 0.56 turns `editContext` on by default wherever the browser has the API (Electron's
    // Chromium does), and then the focused element is a plain `div.native-edit-context` with an
    // EditContext attached: not a TEXTAREA, not contentEditable. Every space typed in an editor
    // node was being taken for panning.
    const monacoInput = {
      tagName: 'DIV',
      isContentEditable: false,
      editContext: {}
    } as unknown as Element
    expect(typingTarget(monacoInput)).toBe(true)
    expect(spacePanKeydown({ key: ' ' }, monacoInput)).toBe('ignore')
  })

  it('ignores a MODIFIED space, which belongs to someone else', () => {
    // ⌘Space is the OS switcher; Ctrl/Alt+Space are other people's bindings.
    expect(spacePanKeydown({ key: ' ', metaKey: true }, null)).toBe('ignore')
    expect(spacePanKeydown({ key: ' ', ctrlKey: true }, null)).toBe('ignore')
    expect(spacePanKeydown({ key: ' ', altKey: true }, null)).toBe('ignore')
  })

  it('ignores the auto-repeat, so a held key engages once rather than sixty times a second', () => {
    expect(spacePanKeydown({ key: ' ', repeat: true }, null)).toBe('ignore')
  })

  it('ignores every other key', () => {
    for (const key of ['a', 'Enter', 'Shift', 'ArrowLeft']) {
      expect(spacePanKeydown({ key }, null)).toBe('ignore')
    }
  })
})

describe('isSpaceRelease', () => {
  it('ends the gesture on the space keyup', () => {
    expect(isSpaceRelease({ key: ' ' })).toBe(true)
    expect(isSpaceRelease({ key: 'Spacebar' })).toBe(true)
  })

  it('is modifier-BLIND, so a pan can always be released', () => {
    // Tapping ⌘ mid-pan still delivers a keyup for space. Requiring an unmodified release would
    // strand the canvas in grab mode until the user pressed space again.
    expect(isSpaceRelease({ key: ' ', metaKey: true })).toBe(true)
  })

  it('ignores other keys coming up', () => {
    expect(isSpaceRelease({ key: 'a' })).toBe(false)
  })
})

describe("React Flow's built-in space-pan (#930)", () => {
  it('is switched off, so this module is the only space-to-pan', () => {
    // React Flow's default `panActivationKeyCode` is 'Space'. Its listener cannot see an EditContext
    // target (so it swallowed spaces typed in the Monaco editor) and it forces panOnDrag on, past the
    // canvas lock.
    const source = readFileSync('src/renderer/canvas/Canvas.tsx', 'utf8')
    expect(source).toContain('panActivationKeyCode={null}')
  })

  it('the canvas hands the covered-by-a-board fact to the decision (wiring pin)', () => {
    const source = readFileSync('src/renderer/canvas/Canvas.tsx', 'utf8')
    expect(source).toContain('spacePanKeydown(e, document.activeElement, covered)')
  })
})
