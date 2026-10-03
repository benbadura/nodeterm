import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { canvasOwnsMarkdownChord } from './markdownChord'

describe('canvasOwnsMarkdownChord', () => {
  it('a hovered node takes the chord when no board is up', () => {
    expect(canvasOwnsMarkdownChord(true, false)).toBe(true)
  })

  it('a node that is not hovered never does', () => {
    expect(canvasOwnsMarkdownChord(false, false)).toBe(false)
    expect(canvasOwnsMarkdownChord(false, true)).toBe(false)
  })

  it('a (possibly stale) hovered node under a board refuses — the card modal owns the chord there', () => {
    expect(canvasOwnsMarkdownChord(true, true)).toBe(false)
  })

  it('is what the canvas node subscription asks (one-line wiring pin)', () => {
    const src = readFileSync(resolve(__dirname, '../nodes/TerminalNode.tsx'), 'utf8').replace(/\r\n/g, '\n')
    expect(src).toMatch(
      /onMarkdownToggle\(\(\) => \{\s*if \(!canvasOwnsMarkdownChord\(hoveredRef\.current, isGlobalKanbanOpen\(\) \|\| isKanbanOpen\(/
    )
  })

  it('the editor node asks the same question (a stale-hovered editor under the board refuses too)', () => {
    // The editor's preview flip was gated on hover alone, so a press meant for the card modal also
    // flipped the hidden preview of whichever editor was under the pointer when the board opened.
    const src = readFileSync(resolve(__dirname, '../nodes/EditorNode.tsx'), 'utf8').replace(/\r\n/g, '\n')
    expect(src).toMatch(
      /onMarkdownToggle\(\(\) => \{\s*if \(canvasOwnsMarkdownChord\(hoveredRef\.current, isGlobalKanbanOpen\(\) \|\| isKanbanOpen\(/
    )
  })
})
