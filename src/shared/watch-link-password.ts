// A Control link's password, OWNER side: the generator and the validator the create dialog and the
// core service share (docs/live-links.md). Not in src/shared/watch-link/ on purpose: the viewer page
// never makes or judges a password, it only carries one inside the E2E tunnel (`PASSWORD_MAX`).
// The plaintext is never stored; core keeps a scrypt hash only (src/core/watch-link/password.ts).
import { PASSWORD_MAX } from './watch-link/protocol'

/** The shortest password a person may type, in code points. The longest is the unlock cast's own cap,
 *  `PASSWORD_MAX` (128), so a password the owner set can always be sent by a viewer. */
export const CONTROL_PASSWORD_MIN = 8
/** What Generate makes: 16 symbols of 5 bits each, 80 bits. */
export const CONTROL_PASSWORD_LENGTH = 16
/** Crockford's base32 in lower case: no i, l, o or u, so nothing reads as another symbol. */
export const CONTROL_PASSWORD_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/** `randomBytes` is the caller's CSPRNG (`crypto.getRandomValues` in the renderer). 32 symbols divide
 *  256, so `byte & 31` picks every symbol with the same probability. */
export function generateControlPassword(randomBytes: (n: number) => Uint8Array): string {
  const b = randomBytes(CONTROL_PASSWORD_LENGTH)
  let out = ''
  for (let i = 0; i < CONTROL_PASSWORD_LENGTH; i++) out += CONTROL_PASSWORD_ALPHABET[b[i] & 31]
  return out
}

export type ControlPasswordProblem = 'type' | 'short' | 'long' | 'control'
/** Why a typed password is refused, or null when it is acceptable. Lengths count code points, so an
 *  emoji is one character, as a person counts it. C0/C1 controls (a pasted line break) are refused:
 *  the viewer types the password into a one-line field and could never send one back. */
export function controlPasswordProblem(pw: unknown): ControlPasswordProblem | null {
  if (typeof pw !== 'string') return 'type'
  // A code point is at most two UTF-16 units: past this many units it is too long whatever it holds,
  // and an IPC caller's megabyte string is never split into an array of code points.
  if (pw.length > PASSWORD_MAX * 2) return 'long'
  const n = Array.from(pw).length
  if (n < CONTROL_PASSWORD_MIN) return 'short'
  if (n > PASSWORD_MAX) return 'long'
  if (/[\u0000-\u001f\u007f-\u009f]/.test(pw)) return 'control'
  return null
}
