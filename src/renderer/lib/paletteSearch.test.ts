import { describe, it, expect } from 'vitest'
import { paletteScore, rankPaletteCommands } from './paletteSearch'

const action = (label: string, hint?: string, section?: string) => ({ label, hint, section })

describe('rankPaletteCommands', () => {
  it('finds a node titled mid-string even behind more than `limit` scattered action hits', () => {
    // 60 actions whose hints subsequence-match "seo" (s…e…o), declared BEFORE the node row.
    const actions = Array.from({ length: 60 }, (_, i) =>
      action(`Spawn a team ${i}`, 'orchestrate parallelize delegate agents conductor')
    )
    const node = action('Go to Ottasilver SEO değerlendirmesi', undefined, 'Opened terminals')
    const out = rankPaletteCommands([...actions, node], 'SEO', 50)
    expect(out[0]).toBe(node)
    expect(out).toHaveLength(50)
  })

  it('ranks a word-start label hit above a mid-word one, and label above hint', () => {
    const mid = action('Go to reseo')
    const hintOnly = action('Something', 'seo')
    const start = action('Go to SEO audit')
    expect(rankPaletteCommands([hintOnly, mid, start], 'seo', 50)).toEqual([start, mid, hintOnly])
  })

  it('keeps a section together, ordered by its best row', () => {
    const a1 = action('View seo one', undefined, 'View')
    const n1 = action('Go to x', 'seo', 'Opened terminals')
    const a2 = action('Seo two', undefined, 'View')
    const out = rankPaletteCommands([a1, n1, a2], 'seo', 50)
    expect(out.map((c) => c.section)).toEqual(['View', 'View', 'Opened terminals'])
  })

  it('empty query keeps declaration order', () => {
    const a = action('b')
    const b = action('a')
    expect(rankPaletteCommands([a, b], '  ', 50)).toEqual([a, b])
  })

  it('still matches subsequences and content, but below substrings', () => {
    expect(paletteScore(action('New Terminal'), 'ntr')).toBe(3)
    expect(paletteScore({ label: 'Go to x', content: 'npm run build' }, 'run b')).toBe(5)
    expect(paletteScore(action('Go to x'), 'zz')).toBeNull()
  })
})
