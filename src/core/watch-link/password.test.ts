import { describe, expect, it } from 'vitest'
import { hashControlPassword, verifyControlPassword, SCRYPT } from './password'

describe('control password hash', () => {
  it('verifies the right password and refuses a wrong one', async () => {
    const h = await hashControlPassword('correct horse')
    expect(Buffer.from(h.salt, 'base64')).toHaveLength(SCRYPT.saltBytes)
    expect(Buffer.from(h.hash, 'base64')).toHaveLength(SCRYPT.keylen)
    expect(await verifyControlPassword('correct horse', h)).toBe(true)
    expect(await verifyControlPassword('correct hors', h)).toBe(false)
  })
  it('salts: the same password hashes differently twice', async () => {
    const [a, b] = await Promise.all([hashControlPassword('x'.repeat(8)), hashControlPassword('x'.repeat(8))])
    expect(a.salt).not.toBe(b.salt)
    expect(a.hash).not.toBe(b.hash)
  })
  it('answers false, never throws, for a malformed stored hash or a non-string', async () => {
    expect(await verifyControlPassword('x'.repeat(8), { salt: '!!', hash: 'short' })).toBe(false)
    expect(await verifyControlPassword(7 as never, await hashControlPassword('x'.repeat(8)))).toBe(false)
    expect(await verifyControlPassword('x'.repeat(8), null as never)).toBe(false)
    expect(await verifyControlPassword('x'.repeat(8), { salt: 7, hash: [] } as never)).toBe(false)
  })
  it('compares the NFC form: a composed and a decomposed spelling of one password are the same password', async () => {
    const composed = 'caf\u00e9-p\u00e4ss' // é and ä as single code points
    const decomposed = 'cafe\u0301-pa\u0308ss' // the same letters as base + combining mark
    expect(composed).not.toBe(decomposed)
    expect(await verifyControlPassword(decomposed, await hashControlPassword(composed))).toBe(true)
  })
})
