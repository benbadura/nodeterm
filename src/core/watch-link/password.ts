// The Control link password: scrypt (N = 2^15, r = 8, p = 1, a 16-byte random salt, a 32-byte key),
// stored as {salt, hash} only. The plaintext is never kept, logged or echoed: it lives only for the
// call that hashes or checks it, which is why there is no "show again" (Change password sets a new one).
//
// The password is compared in its NFC form: two input paths can produce different Unicode forms of
// the same letters (composed é, or e plus a combining accent), and both must unlock.
//
// `verifyControlPassword` answers false, never throws: a malformed stored hash (a hand-edited file) or
// a non-string password (a viewer's cast is untrusted input) is a refused unlock, not an error. The
// comparison of the derived keys is constant-time.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

export interface ControlPasswordHash {
  /** base64 */
  salt: string
  /** base64 */
  hash: string
}
// maxmem: scrypt needs 128 * N * r bytes = 32 MiB here, which is exactly Node's default ceiling and
// over it once its own bookkeeping is counted, so the ceiling is raised.
export const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, saltBytes: 16, maxmem: 64 * 1024 * 1024 } as const

function derive(pw: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      pw.normalize('NFC'),
      salt,
      SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem },
      (err, key) => (err ? reject(err) : resolve(key))
    )
  )
}

export async function hashControlPassword(pw: string): Promise<ControlPasswordHash> {
  const salt = randomBytes(SCRYPT.saltBytes)
  return { salt: salt.toString('base64'), hash: (await derive(pw, salt)).toString('base64') }
}

export async function verifyControlPassword(pw: string, h: ControlPasswordHash): Promise<boolean> {
  try {
    if (typeof pw !== 'string') return false
    const salt = Buffer.from(h.salt, 'base64')
    const want = Buffer.from(h.hash, 'base64')
    if (salt.length !== SCRYPT.saltBytes || want.length !== SCRYPT.keylen) return false
    return timingSafeEqual(await derive(pw, salt), want)
  } catch {
    return false
  }
}
