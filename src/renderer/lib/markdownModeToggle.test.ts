import { describe, it, expect } from 'vitest'
import { nextMdMode } from './markdownModeToggle'

const term = (id: string, mdMode?: boolean) => ({ id, type: 'terminal', data: { mdMode } })
const other = (id: string) => ({ id, type: 'sticky', data: {} })

describe('nextMdMode', () => {
  it('turns the view ON for every target when ANY targeted terminal has it off', () => {
    // The bug this replaces: a per-node flip inverted a mixed selection (on→off, off→on).
    const nodes = [term('a', true), term('b', false), term('c')]
    expect(nextMdMode(nodes, ['a', 'b', 'c'])).toBe(true)
  })

  it('turns it OFF for all only when every targeted terminal already has it on', () => {
    const nodes = [term('a', true), term('b', true)]
    expect(nextMdMode(nodes, ['a', 'b'])).toBe(false)
  })

  it('a single node still toggles (the non-selection case is unchanged)', () => {
    expect(nextMdMode([term('a', false)], ['a'])).toBe(true)
    expect(nextMdMode([term('a', true)], ['a'])).toBe(false)
    expect(nextMdMode([term('a')], ['a'])).toBe(true)
  })

  it('ignores non-terminal and untargeted nodes when deciding', () => {
    // An untargeted terminal that is off, and a targeted sticky, must not flip the verdict.
    const nodes = [term('a', true), term('b', false), other('s')]
    expect(nextMdMode(nodes, ['a', 's'])).toBe(false)
  })

  it('null when no targeted terminal exists (nothing to decide)', () => {
    expect(nextMdMode([other('s'), term('a', false)], ['s'])).toBeNull()
    expect(nextMdMode([], ['x'])).toBeNull()
  })
})
