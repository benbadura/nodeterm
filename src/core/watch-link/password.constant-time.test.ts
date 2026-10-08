// The Control password check compares the derived key with the stored one in CONSTANT TIME. No
// behavioural test can tell `timingSafeEqual` from `Buffer.equals` (both answer the same), so this
// file watches the call itself: every check that gets as far as a derived key goes through
// `timingSafeEqual`, with the derived key and the stored hash, and answers exactly what it answered.
// Its own file because `vi.mock` is per file and every other test here wants the real module.
import { describe, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({ calls: [] as Array<{ a: Buffer; b: Buffer; answer: boolean }> }))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView): boolean => {
      const answer = actual.timingSafeEqual(a, b)
      seen.calls.push({ a: Buffer.from(a as Uint8Array), b: Buffer.from(b as Uint8Array), answer })
      return answer
    }
  }
})

import { SCRYPT, hashControlPassword, verifyControlPassword } from './password'

describe('control password check: constant time', () => {
  it('compares the derived key with the stored hash through timingSafeEqual, right and wrong alike', async () => {
    const h = await hashControlPassword('correct horse')
    const stored = Buffer.from(h.hash, 'base64')
    for (const [pw, want] of [['correct horse', true], ['correct hors', false]] as const) {
      seen.calls.length = 0
      expect(await verifyControlPassword(pw, h)).toBe(want)
      expect(seen.calls).toHaveLength(1)
      const [c] = seen.calls
      expect(c.a).toHaveLength(SCRYPT.keylen)
      expect(c.b.equals(stored)).toBe(true)
      expect(c.answer).toBe(want)
    }
  })

  it('a malformed stored hash is refused before any key is derived or compared', async () => {
    seen.calls.length = 0
    expect(await verifyControlPassword('x'.repeat(8), { salt: '!!', hash: 'short' })).toBe(false)
    expect(seen.calls).toHaveLength(0)
  })
})
