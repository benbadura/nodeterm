import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { renameAtomic, tempNameFor } from '../fs-atomic'
import { platform } from '../platform'

/**
 * The single 32-byte secret every per-node capability derives from. It is the root
 * of all node identity, so it is minted from crypto.randomBytes, written 0600 via
 * tmp+rename (a reader never sees a partial file), and stored in ONE of two at-rest
 * formats under two DISTINCT file names, so a data dir moved between shells can never
 * be misread as the other format:
 *
 *   - Desktop shell (can seal): node-auth-key.json — {version:1, secretKeyEnc:<base64
 *     of the sealed base64 secret>}, mirroring #167's codex-node-auth-key.json shape.
 *   - Server Edition (no keychain): node-auth-key.bin — exactly 32 raw bytes, mode 0600.
 *
 * The same secret signs the codex thread→node records #167 wrote, so on the sealed
 * path we ADOPT a pre-existing codex-node-auth-key.json before minting fresh — minting
 * anew would orphan every bound codex thread on the machine.
 */

type StoredSecret = { version: 1; secretKeyEnc: string }

let cached: Promise<Buffer> | null = null
let cachedDir = ''

/** Whether the platform can seal secrets at rest. Throws if it supplies exactly one
 *  of the two hooks — a shell must supply BOTH or NEITHER (programming error). */
function seals(): boolean {
  const p = platform()
  const hasSeal = typeof p.sealSecret === 'function'
  const hasUnseal = typeof p.unsealSecret === 'function'
  if (hasSeal !== hasUnseal) {
    throw new Error('CorePlatform must supply both sealSecret and unsealSecret, or neither')
  }
  return hasSeal
}

const sealedFile = (dir: string): string => path.join(dir, 'node-auth-key.json')
const rawFile = (dir: string): string => path.join(dir, 'node-auth-key.bin')
const legacyFile = (dir: string): string => path.join(dir, 'codex-node-auth-key.json')

/** Decode a #167-shaped sealed body via the platform's unseal hook. Identical shape to
 *  the codex key so adoption reuses this exact path. */
function decodeSealed(raw: string): Buffer {
  const p = platform()
  let stored: StoredSecret
  try {
    stored = JSON.parse(raw) as StoredSecret
  } catch {
    throw new Error('node-auth key is malformed')
  }
  if (stored?.version !== 1 || typeof stored.secretKeyEnc !== 'string') {
    throw new Error('node-auth key is malformed')
  }
  const unsealed = p.unsealSecret!(Buffer.from(stored.secretKeyEnc, 'base64'))
  const secret = Buffer.from(unsealed.toString('utf8'), 'base64')
  if (secret.byteLength !== 32) throw new Error('node-auth key is invalid')
  return secret
}

/** Write bytes atomically: unique tmp with flag 'wx', chmod 0600, rename into place,
 *  unlink the tmp in finally. A reader never observes a partial file. */
async function persistFile(file: string, data: string | Buffer): Promise<void> {
  const tmp = tempNameFor(file)
  await fs.mkdir(path.dirname(file), { recursive: true })
  try {
    await fs.writeFile(tmp, data, { mode: 0o600, flag: 'wx' })
    await renameAtomic(tmp, file)
    await fs.chmod(file, 0o600)
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

async function persistSealed(dir: string, secret: Buffer): Promise<void> {
  const p = platform()
  const secretKeyEnc = p.sealSecret!(Buffer.from(secret.toString('base64'), 'utf8')).toString('base64')
  const body: StoredSecret = { version: 1, secretKeyEnc }
  await persistFile(sealedFile(dir), `${JSON.stringify(body)}\n`)
}

/** Try to adopt #167's codex-node-auth-key.json (same secret signs codex thread→node
 *  records). Absent or unreadable → null, so the caller mints fresh rather than crashing. */
async function adoptLegacy(dir: string): Promise<Buffer | null> {
  try {
    return decodeSealed(await fs.readFile(legacyFile(dir), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Issue #1088. A desktop shell that CAN seal in principle may still be unable to seal on this
 * machine: Electron 42 on a Linux session with no Secret Service / kwallet (a bare window manager —
 * Arch + sway/i3 is the reported case) selects the `basic_text` backend, answers
 * `isEncryptionAvailable() === false`, and `encryptString` THROWS ("Encryption is not available").
 * Measured on this repo's Electron under xvfb with no session bus.
 *
 * Before this, that throw rejected the load on EVERY boot, the shell's catch put the whole instance
 * in legacy mode, no token file was ever written, and every verified-only verb (`send`, `settings`,
 * …) was refused forever — while hook-endpoint.env still advertised a token dir that would never
 * fill. So when sealing is impossible AND no sealed key exists, the desktop stores the secret
 * exactly as the Server Edition does: raw 32 bytes, 0600, `node-auth-key.bin`. On that backend
 * "sealed" would only ever have been obfuscation under a hard-coded key (docs/node-identity.md);
 * the 0600 mode is the protection that holds either way.
 *
 * What this deliberately does NOT do: replace a sealed key it merely cannot UNSEAL right now
 * (keyring locked at boot). That key signs the codex thread→node records, so rotating it would
 * orphan every bound thread — the load still rejects there, and the shell reports why.
 */
async function loadSealed(dir: string): Promise<Buffer> {
  try {
    return decodeSealed(await fs.readFile(sealedFile(dir), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // A raw key from an earlier keyring-less boot wins over minting: it is this machine's identity.
  const raw = await readRaw(dir)
  if (raw) return raw
  const secret = (await adoptLegacy(dir)) ?? randomBytes(32)
  try {
    await persistSealed(dir, secret)
  } catch (error) {
    console.warn('[node-identity] cannot seal the node-auth key (no usable OS keyring) — storing it 0600 instead', error)
    await persistFile(rawFile(dir), secret)
  }
  return secret
}

/** The raw key file, or null when there is none. Any other read failure / wrong length throws. */
async function readRaw(dir: string): Promise<Buffer | null> {
  try {
    const buf = await fs.readFile(rawFile(dir))
    if (buf.byteLength !== 32) throw new Error('node-auth key is invalid')
    return buf
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return null
  }
}

async function loadRaw(dir: string): Promise<Buffer> {
  const existing = await readRaw(dir)
  if (existing) return existing
  const secret = randomBytes(32)
  await persistFile(rawFile(dir), secret)
  return secret
}

/** Restart-stable 32-byte node-auth secret. Single-flight cached per userDataDir; a
 *  rejection clears the cache so a later call retries. */
export function loadOrCreateNodeAuthSecret(): Promise<Buffer> {
  const dir = platform().userDataDir
  if (cached && cachedDir === dir) return cached
  const pending = seals() ? loadSealed(dir) : loadRaw(dir)
  cached = pending
  cachedDir = dir
  pending.catch(() => {
    if (cached === pending) {
      cached = null
      cachedDir = ''
    }
  })
  return pending
}

export function resetNodeAuthSecretForTests(): void {
  cached = null
  cachedDir = ''
}
