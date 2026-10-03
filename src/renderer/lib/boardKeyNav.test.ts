import { describe, expect, it, vi } from 'vitest'
import { columnStep, keyOwnedByControl, stepCard } from './boardKeyNav'
import { registerBoardKeys, runBoardKey } from './boardKeys'

const COLS = [['u1'], [], ['a1', 'a2', 'a3'], ['b1']]
const ORDER = COLS.flat()

describe('stepCard — board order is column by column, top to bottom', () => {
  it('moves to the neighbour', () => {
    expect(stepCard(ORDER, 'u1', 1)).toBe('a1')
    expect(stepCard(ORDER, 'a3', 1)).toBe('b1')
    expect(stepCard(ORDER, 'a1', -1)).toBe('u1')
  })

  it('stops at the ends (null = nothing to move to)', () => {
    expect(stepCard(ORDER, 'b1', 1)).toBeNull()
    expect(stepCard(ORDER, 'u1', -1)).toBeNull()
  })

  it('a card that is no longer on the board has no neighbour', () => {
    expect(stepCard(ORDER, 'gone', 1)).toBeNull()
  })
})

describe('columnStep', () => {
  it('jumps to the same row of the nearest NON-EMPTY column, clamped to its length', () => {
    expect(columnStep(COLS, 'a3', 1)).toBe('b1')
    expect(columnStep(COLS, 'a2', -1)).toBe('u1') // skips the empty column
    expect(columnStep(COLS, 'u1', 1)).toBe('a1')
  })

  it('is null at the edge of the board', () => {
    expect(columnStep(COLS, 'b1', 1)).toBeNull()
    expect(columnStep(COLS, 'u1', -1)).toBeNull()
    expect(columnStep(COLS, 'gone', 1)).toBeNull()
  })
})

const el = (tagName: string, attrs: Record<string, string> = {}): Element =>
  ({
    tagName,
    getAttribute: (k: string) => attrs[k] ?? null,
    closest: (sel: string) => (sel === '[data-kanban-card]' && attrs['data-kanban-card'] ? el(tagName, attrs) : null)
  }) as unknown as Element

describe('keyOwnedByControl — the board never takes a key the focused control uses', () => {
  it('a focused button keeps Space (native activation) but not J/K/arrows', () => {
    expect(keyOwnedByControl(el('BUTTON'), 'open')).toBe(true)
    expect(keyOwnedByControl(el('BUTTON'), 'next')).toBe(false)
    expect(keyOwnedByControl(el('A'), 'open')).toBe(true)
  })

  it('a <select> owns every key (arrows change it, letters type-ahead)', () => {
    for (const a of ['open', 'next', 'prev', 'left', 'right'] as const) {
      expect(keyOwnedByControl(el('SELECT'), a)).toBe(true)
    }
  })

  it('an ARIA composite widget owns every key', () => {
    expect(keyOwnedByControl(el('DIV', { role: 'listbox' }), 'next')).toBe(true)
    expect(keyOwnedByControl(el('DIV', { role: 'slider' }), 'left')).toBe(true)
  })

  it('a BUTTON inside a card still owns Space — pressing it must not open the card', () => {
    const insideCard = {
      tagName: 'BUTTON',
      getAttribute: () => null,
      closest: (sel: string) => (sel === '[data-kanban-card]' ? el('DIV', { 'data-kanban-card': 'a1' }) : null)
    } as unknown as Element
    expect(keyOwnedByControl(insideCard, 'open')).toBe(true)
    expect(keyOwnedByControl(insideCard, 'next')).toBe(false)
  })

  it('a card, the body, or nothing owns no key', () => {
    expect(keyOwnedByControl(el('DIV', { 'data-kanban-card': 'a1' }), 'open')).toBe(false)
    expect(keyOwnedByControl(el('BODY'), 'open')).toBe(false)
    expect(keyOwnedByControl(null, 'next')).toBe(false)
  })
})

describe('boardKeys — the seam between the window dispatcher and the mounted board', () => {
  it('declines (falls through to the platform) when no board is registered', () => {
    expect(runBoardKey('next')).toBe(false)
  })

  it('hands the action to the registered board and returns its claim', () => {
    const handler = vi.fn(() => true)
    const off = registerBoardKeys(handler)
    expect(runBoardKey('open')).toBe(true)
    expect(handler).toHaveBeenCalledWith('open')
    off()
    expect(runBoardKey('open')).toBe(false)
  })

  it('an OLD registration’s cleanup never clears a newer one', () => {
    const first = registerBoardKeys(() => true)
    const second = vi.fn(() => true)
    registerBoardKeys(second)
    first()
    expect(runBoardKey('next')).toBe(true)
    expect(second).toHaveBeenCalled()
  })
})
