import { describe, expect, it } from 'vitest'
import { generateControlPassword, controlPasswordProblem, CONTROL_PASSWORD_ALPHABET, CONTROL_PASSWORD_LENGTH } from './watch-link-password'

describe('control password', () => {
  it('generates 16 symbols from the 32-symbol alphabet, uniformly (byte & 31)', () => {
    const pw = generateControlPassword((n) => Uint8Array.from({ length: n }, (_, i) => i * 37))
    expect(pw).toHaveLength(CONTROL_PASSWORD_LENGTH)
    expect([...pw].every((c) => CONTROL_PASSWORD_ALPHABET.includes(c))).toBe(true)
    expect(CONTROL_PASSWORD_ALPHABET).toHaveLength(32)
    expect(/[ilou]/.test(CONTROL_PASSWORD_ALPHABET)).toBe(false)
  })
  it('validates typed passwords', () => {
    expect(controlPasswordProblem('1234567')).toBe('short')
    expect(controlPasswordProblem('12345678')).toBeNull()
    expect(controlPasswordProblem('🙂'.repeat(8))).toBeNull()        // code points, not UTF-16 units
    expect(controlPasswordProblem('x'.repeat(129))).toBe('long')
    expect(controlPasswordProblem('abcdefg\n')).toBe('control')
    expect(controlPasswordProblem(12345678)).toBe('type')
  })
})
