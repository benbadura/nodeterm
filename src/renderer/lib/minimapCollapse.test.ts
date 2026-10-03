import { describe, expect, it } from 'vitest'
import {
  MINIMAP_COLLAPSED_KEY,
  parseMinimapCollapsed,
  readMinimapCollapsed,
  writeMinimapCollapsed
} from './minimapCollapse'

describe('parseMinimapCollapsed', () => {
  it('is expanded by default — a missing key must not hide the minimap on existing users', () => {
    expect(parseMinimapCollapsed(null)).toBe(false)
    expect(parseMinimapCollapsed('')).toBe(false)
    expect(parseMinimapCollapsed('0')).toBe(false)
    expect(parseMinimapCollapsed('true')).toBe(false)
    expect(parseMinimapCollapsed('1')).toBe(true)
  })
})

describe('readMinimapCollapsed / writeMinimapCollapsed', () => {
  it('reads the namespaced key and writes 1/0', () => {
    const store: Record<string, string> = {}
    const get = (k: string): string | null => store[k] ?? null
    const set = (k: string, v: string): void => {
      store[k] = v
    }
    expect(readMinimapCollapsed(get)).toBe(false)
    writeMinimapCollapsed(true, set)
    expect(store[MINIMAP_COLLAPSED_KEY]).toBe('1')
    expect(readMinimapCollapsed(get)).toBe(true)
    writeMinimapCollapsed(false, set)
    expect(store[MINIMAP_COLLAPSED_KEY]).toBe('0')
    expect(readMinimapCollapsed(get)).toBe(false)
  })

  it('degrades to expanded when storage throws', () => {
    expect(
      readMinimapCollapsed(() => {
        throw new Error('blocked')
      })
    ).toBe(false)
    expect(() =>
      writeMinimapCollapsed(true, () => {
        throw new Error('quota')
      })
    ).not.toThrow()
  })
})
