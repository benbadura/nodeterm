import { describe, expect, it } from 'vitest'
import { readControlEvent, readTypingNames, isWatchEndReason, TYPING_NAMES_MAX } from './protocol'

describe('control protocol readers', () => {
  it('accepts only known states and reasons', () => {
    expect(readControlEvent({ state: 'controlling' })).toEqual({ state: 'controlling' })
    expect(readControlEvent({ state: 'available', reason: 'wrong' })).toEqual({ state: 'available', reason: 'wrong' })
    expect(readControlEvent({ state: 'god' })).toBeNull()
    expect(readControlEvent({ state: 'off', reason: 'nope' })).toEqual({ state: 'off' })
    expect(readControlEvent(null)).toBeNull()
  })
  it('sanitizes and bounds typing names', () => {
    const many = Array.from({ length: 30 }, (_, i) => `n${i}`)
    expect(readTypingNames({ names: many })).toHaveLength(TYPING_NAMES_MAX)
    expect(readTypingNames({ names: ['a\u202eb', 'a\u202eb', 7, '  '] })).toEqual(['ab'])
    expect(readTypingNames('x')).toEqual([])
  })
  it('knows the new end reason', () => {
    expect(isWatchEndReason('attempts')).toBe(true)
  })
})
