import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { loadOrCreateNodeAuthSecret, resetNodeAuthSecretForTests } from './node-auth-secret'

// A trivial reversible seal for the desktop-shaped tests: byte-wise xor. It is
// enough to prove the at-rest bytes are ciphertext (never the raw base64) and
// that unseal(seal(x)) === x, without dragging in Electron's safeStorage.
const KEY = 0x5a
const xor = (b: Buffer): Buffer => Buffer.from(b.map((x) => x ^ KEY))

// Build a #167-shaped sealed file body ({version:1, secretKeyEnc: base64(seal(base64(secret)))}),
// using the same xor the sealed platform is configured with.
function sealedBody(secret: Buffer): string {
  const secretKeyEnc = xor(Buffer.from(secret.toString('base64'), 'utf8')).toString('base64')
  return JSON.stringify({ version: 1, secretKeyEnc }) + '\n'
}

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-secret-'))
  resetPlatformForTests()
  resetNodeAuthSecretForTests()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  resetPlatformForTests()
  resetNodeAuthSecretForTests()
})

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777
}

describe('node-auth secret behind CorePlatform', () => {
  it('Server Edition: mints 32 raw bytes at node-auth-key.bin mode 0600 and reloads identically', async () => {
    initPlatform(fakePlatform({ userDataDir: dir }))
    const first = await loadOrCreateNodeAuthSecret()
    expect(first.byteLength).toBe(32)

    const file = path.join(dir, 'node-auth-key.bin')
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file).byteLength).toBe(32)
    expect(mode(file)).toBe(0o600)
    expect(fs.existsSync(path.join(dir, 'node-auth-key.json'))).toBe(false)

    resetNodeAuthSecretForTests()
    const second = await loadOrCreateNodeAuthSecret()
    expect(second.equals(first)).toBe(true)
  })

  it('Desktop: seals to node-auth-key.json (ciphertext only, no raw base64) mode 0600, reloads identically', async () => {
    initPlatform(fakePlatform({ userDataDir: dir, sealSecret: xor, unsealSecret: xor }))
    const first = await loadOrCreateNodeAuthSecret()
    expect(first.byteLength).toBe(32)

    const file = path.join(dir, 'node-auth-key.json')
    expect(fs.existsSync(file)).toBe(true)
    expect(mode(file)).toBe(0o600)
    expect(fs.existsSync(path.join(dir, 'node-auth-key.bin'))).toBe(false)

    const atRest = fs.readFileSync(file, 'utf8')
    // The raw secret's base64 must not appear on disk — only the sealed form.
    expect(atRest.includes(first.toString('base64'))).toBe(false)
    // And no SIBLING file may carry it either: the sealed json is the only thing written, so a
    // plaintext fallback (the mutation Property 6 forbids) has nowhere to hide. Scan every file.
    expect(fs.readdirSync(dir)).toEqual(['node-auth-key.json'])
    for (const name of fs.readdirSync(dir)) {
      expect(fs.readFileSync(path.join(dir, name), 'utf8').includes(first.toString('base64'))).toBe(false)
    }
    const parsed = JSON.parse(atRest)
    expect(parsed.version).toBe(1)
    expect(typeof parsed.secretKeyEnc).toBe('string')

    resetNodeAuthSecretForTests()
    const second = await loadOrCreateNodeAuthSecret()
    expect(second.equals(first)).toBe(true)
  })

  it('single-flights a concurrent double-load: equal buffers, one file, no tmp left', async () => {
    initPlatform(fakePlatform({ userDataDir: dir }))
    const [a, b] = await Promise.all([loadOrCreateNodeAuthSecret(), loadOrCreateNodeAuthSecret()])
    expect(a.equals(b)).toBe(true)
    const entries = fs.readdirSync(dir)
    expect(entries).toEqual(['node-auth-key.bin'])
  })

  it('Desktop: adopts #167 codex-node-auth-key.json when present rather than minting fresh', async () => {
    const legacyPlain = randomBytes(32)
    fs.writeFileSync(path.join(dir, 'codex-node-auth-key.json'), sealedBody(legacyPlain), { mode: 0o600 })

    initPlatform(fakePlatform({ userDataDir: dir, sealSecret: xor, unsealSecret: xor }))
    const secret = await loadOrCreateNodeAuthSecret()
    expect(secret.equals(legacyPlain)).toBe(true)
    // And it is re-persisted under the new name so later loads are stable.
    expect(fs.existsSync(path.join(dir, 'node-auth-key.json'))).toBe(true)
  })

  it('rejects when the platform supplies exactly one of sealSecret / unsealSecret', () => {
    initPlatform(fakePlatform({ userDataDir: dir, sealSecret: xor }))
    expect(() => loadOrCreateNodeAuthSecret()).toThrow(/both|neither/i)
  })

  it('rejects a malformed key file whose byte length is not 32', async () => {
    fs.writeFileSync(path.join(dir, 'node-auth-key.bin'), Buffer.alloc(10), { mode: 0o600 })
    initPlatform(fakePlatform({ userDataDir: dir }))
    await expect(loadOrCreateNodeAuthSecret()).rejects.toThrow(/invalid|malformed/i)
  })

  it('Desktop: fails closed on a malformed sealed key instead of rotating ownership', async () => {
    // A present-but-corrupt node-auth-key.json must THROW, never silently mint a fresh secret: the
    // same key signs the codex thread→node ownership records, so rotating it would orphan every
    // bound thread on the machine (Property 6). The corrupt file is left exactly as found.
    const file = path.join(dir, 'node-auth-key.json')
    fs.writeFileSync(file, '{ this is not json', { mode: 0o600 })
    initPlatform(fakePlatform({ userDataDir: dir, sealSecret: xor, unsealSecret: xor }))
    await expect(loadOrCreateNodeAuthSecret()).rejects.toThrow(/malformed|invalid/i)
    // Not rotated: the bytes on disk are untouched, and no raw .bin fallback was written.
    expect(fs.readFileSync(file, 'utf8')).toBe('{ this is not json')
    expect(fs.existsSync(path.join(dir, 'node-auth-key.bin'))).toBe(false)
  })

  // Issue #1088 — Electron 42 on a Linux session with no Secret Service/kwallet: backend
  // `basic_text`, isEncryptionAvailable() false, encryptString THROWS. Measured under xvfb.
  const noKeyring = (): Buffer => {
    throw new Error('Error while encrypting the text provided to safeStorage.encryptString. Encryption is not available.')
  }
  const cannotUnseal = (): Buffer => {
    throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString. Decryption is not available.')
  }

  it('Desktop without a usable keyring: stores the secret raw 0600 instead of running legacy forever', async () => {
    initPlatform(fakePlatform({ userDataDir: dir, sealSecret: noKeyring, unsealSecret: cannotUnseal }))
    const first = await loadOrCreateNodeAuthSecret()
    expect(first.byteLength).toBe(32)
    const file = path.join(dir, 'node-auth-key.bin')
    expect(fs.readFileSync(file).equals(first)).toBe(true)
    expect(mode(file)).toBe(0o600)
    expect(fs.existsSync(path.join(dir, 'node-auth-key.json'))).toBe(false)

    // Restart-stable: the next boot (still no keyring) reads the same secret, so tokens keep verifying.
    resetNodeAuthSecretForTests()
    expect((await loadOrCreateNodeAuthSecret()).equals(first)).toBe(true)

    // And a keyring that appears later does not rotate it (the secret signs codex thread records).
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: dir, sealSecret: xor, unsealSecret: xor }))
    resetNodeAuthSecretForTests()
    expect((await loadOrCreateNodeAuthSecret()).equals(first)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'node-auth-key.json'))).toBe(false)
  })

  it('Desktop: a SEALED key that cannot be unsealed right now still rejects — never replaced by a raw one', async () => {
    const file = path.join(dir, 'node-auth-key.json')
    fs.writeFileSync(file, sealedBody(randomBytes(32)), { mode: 0o600 })
    const before = fs.readFileSync(file, 'utf8')
    initPlatform(fakePlatform({ userDataDir: dir, sealSecret: noKeyring, unsealSecret: cannotUnseal }))
    await expect(loadOrCreateNodeAuthSecret()).rejects.toThrow(/Decryption is not available/)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.existsSync(path.join(dir, 'node-auth-key.bin'))).toBe(false)
  })

  it('reject-then-retry: a rejected load clears the single-flight cache so a later healthy call succeeds', async () => {
    // The whole fail-open series leans on this: if a rejection LEFT the rejected promise cached, the
    // shell's catch would swallow it once and every subsequent boot-path retry would re-await the same
    // dead promise — identity would stay wedged off for the life of the process. Prove the cache clears.
    const file = path.join(dir, 'node-auth-key.bin')
    fs.writeFileSync(file, Buffer.alloc(10), { mode: 0o600 })
    initPlatform(fakePlatform({ userDataDir: dir }))
    await expect(loadOrCreateNodeAuthSecret()).rejects.toThrow(/invalid|malformed/i)

    // Heal the platform (remove the poisoned file) and retry — a fresh mint must now succeed.
    fs.rmSync(file)
    const secret = await loadOrCreateNodeAuthSecret()
    expect(secret.byteLength).toBe(32)
    expect(fs.existsSync(file)).toBe(true)
  })
})
