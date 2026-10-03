import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import { execFileSync } from 'child_process'
import path from 'path'
import {
  alertSoundsDir,
  clearAlertSound,
  readAlertSound,
  saveAlertSound,
  sniffAlertSound
} from './alert-sounds'
import { ALERT_SOUND_MAX_BYTES } from '../shared/alert-sound'

const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(24)])
const MP3_ID3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(29)])
const MP3_SYNC = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x44]), Buffer.alloc(28)])
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(28)])
const FLAC = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(28)])
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(20)])
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(28)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)])

const b64 = (b: Buffer): string => b.toString('base64')

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-alert-sounds-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('sniffAlertSound', () => {
  it('accepts each allow-listed format by its magic bytes', () => {
    expect(sniffAlertSound(WAV, 'wav')).toBe(true)
    expect(sniffAlertSound(MP3_ID3, 'mp3')).toBe(true)
    expect(sniffAlertSound(MP3_SYNC, 'mp3')).toBe(true)
    expect(sniffAlertSound(OGG, 'ogg')).toBe(true)
    expect(sniffAlertSound(OGG, 'opus')).toBe(true)
    expect(sniffAlertSound(FLAC, 'flac')).toBe(true)
    expect(sniffAlertSound(M4A, 'm4a')).toBe(true)
    expect(sniffAlertSound(WEBM, 'webm')).toBe(true)
  })

  it('refuses bytes that do not match the extension (a renamed image, a mislabelled format)', () => {
    expect(sniffAlertSound(PNG, 'mp3')).toBe(false)
    expect(sniffAlertSound(PNG, 'wav')).toBe(false)
    expect(sniffAlertSound(OGG, 'wav')).toBe(false)
    expect(sniffAlertSound(Buffer.alloc(2), 'mp3')).toBe(false)
  })
})

describe('saveAlertSound', () => {
  it('writes the bytes under a FIXED, format-independent per-kind name in <userData>/sounds, never the picked name', async () => {
    const res = await saveAlertSound(dir, 'done', 'My Ding.WAV', b64(WAV))
    expect(res).toEqual({ ok: true, name: 'My Ding.WAV' })
    const files = await fs.readdir(alertSoundsDir(dir))
    expect(files).toEqual(['done.sound'])
    expect(await fs.readFile(path.join(alertSoundsDir(dir), 'done.sound'))).toEqual(WAV)
  })

  it('reduces a path-shaped name to its base name — traversal never steers the write', async () => {
    const res = await saveAlertSound(dir, 'needsYou', '../../etc/evil.mp3', b64(MP3_ID3))
    expect(res).toEqual({ ok: true, name: 'evil.mp3' })
    expect(await fs.readdir(alertSoundsDir(dir))).toEqual(['needsYou.sound'])
    expect(await fs.readdir(dir)).toEqual(['sounds'])
  })

  it('replaces a previous pick of another format for the same kind, and leaves the other kind alone', async () => {
    await saveAlertSound(dir, 'done', 'a.wav', b64(WAV))
    await saveAlertSound(dir, 'needsYou', 'b.ogg', b64(OGG))
    await saveAlertSound(dir, 'done', 'c.mp3', b64(MP3_SYNC))
    expect((await fs.readdir(alertSoundsDir(dir))).sort()).toEqual(['done.sound', 'needsYou.sound'])
  })

  it('refuses an unknown kind, a non-audio extension, mismatched bytes, empty and oversized files', async () => {
    const bad = [
      await saveAlertSound(dir, 'evil' as never, 'a.wav', b64(WAV)),
      await saveAlertSound(dir, 'done', 'a.exe', b64(WAV)),
      await saveAlertSound(dir, 'done', 'noext', b64(WAV)),
      await saveAlertSound(dir, 'done', 'image.mp3', b64(PNG)),
      await saveAlertSound(dir, 'done', 'empty.wav', ''),
      await saveAlertSound(dir, 'done', 'huge.wav', b64(Buffer.concat([WAV, Buffer.alloc(ALERT_SOUND_MAX_BYTES)]))),
      await saveAlertSound(dir, 'done', 'x.wav', 42 as never)
    ]
    for (const r of bad) {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/\S/)
    }
    // Nothing was written for any refusal.
    expect(await fs.readdir(alertSoundsDir(dir)).catch(() => [])).toEqual([])
  })

  it('refuses a hostile oversized base64 string before decoding it', async () => {
    const r = await saveAlertSound(dir, 'done', 'a.wav', 'A'.repeat(Math.ceil(ALERT_SOUND_MAX_BYTES * 1.4) + 8))
    expect(r.ok).toBe(false)
  })

  it('never throws — an unwritable data dir is an { ok: false }', async () => {
    const file = path.join(dir, 'not-a-dir')
    await fs.writeFile(file, 'x')
    const r = await saveAlertSound(file, 'done', 'a.wav', b64(WAV))
    expect(r.ok).toBe(false)
  })
})

describe('concurrent mutations of one kind (Server Edition: several tabs, one data dir)', () => {
  it('two concurrent saves of DIFFERENT formats leave exactly one readable sound, never none', async () => {
    for (let i = 0; i < 20; i++) {
      const [a, b] = await Promise.all([
        saveAlertSound(dir, 'done', 'a.mp3', b64(MP3_ID3)),
        saveAlertSound(dir, 'done', 'b.wav', b64(WAV))
      ])
      expect(a.ok && b.ok).toBe(true)
      const got = await readAlertSound(dir, 'done')
      expect([b64(MP3_ID3), b64(WAV)]).toContain(got)
      expect((await fs.readdir(alertSoundsDir(dir))).filter((f) => f.startsWith('done'))).toHaveLength(1)
    }
  })

  it('a save racing a clear ends in one coherent state: the new sound, or none', async () => {
    for (let i = 0; i < 20; i++) {
      await saveAlertSound(dir, 'done', 'old.flac', b64(FLAC))
      await Promise.all([saveAlertSound(dir, 'done', 'new.ogg', b64(OGG)), clearAlertSound(dir, 'done')])
      const got = await readAlertSound(dir, 'done')
      expect([null, b64(OGG)]).toContain(got)
    }
  })
})

describe('readAlertSound', () => {
  it('returns the stored bytes as base64 for a kind', async () => {
    await saveAlertSound(dir, 'done', 'a.flac', b64(FLAC))
    expect(await readAlertSound(dir, 'done')).toBe(b64(FLAC))
  })

  it('answers null for no custom sound, an unknown kind, or a traversal-shaped kind', async () => {
    await saveAlertSound(dir, 'done', 'a.wav', b64(WAV))
    expect(await readAlertSound(dir, 'needsYou')).toBeNull()
    expect(await readAlertSound(dir, 'nope' as never)).toBeNull()
    expect(await readAlertSound(dir, '../done' as never)).toBeNull()
    expect(await readAlertSound(path.join(dir, 'missing'), 'done')).toBeNull()
  })

  it('refuses to follow a symlink planted at the fixed name', async () => {
    const secret = path.join(dir, 'secret.txt')
    await fs.writeFile(secret, 'ID3 top secret')
    await fs.mkdir(alertSoundsDir(dir), { recursive: true })
    await fs.symlink(secret, path.join(alertSoundsDir(dir), 'done.sound'))
    expect(await readAlertSound(dir, 'done')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('refuses a FIFO planted at the fixed name without hanging', async () => {
    await fs.mkdir(alertSoundsDir(dir), { recursive: true })
    execFileSync('mkfifo', [path.join(alertSoundsDir(dir), 'done.sound')])
    expect(await readAlertSound(dir, 'done')).toBeNull()
  }, 5000)

  it('refuses a stored file over the size cap (hand-placed into the data dir)', async () => {
    await fs.mkdir(alertSoundsDir(dir), { recursive: true })
    await fs.writeFile(path.join(alertSoundsDir(dir), 'done.sound'), Buffer.concat([WAV, Buffer.alloc(ALERT_SOUND_MAX_BYTES)]))
    expect(await readAlertSound(dir, 'done')).toBeNull()
  })
})

describe('clearAlertSound', () => {
  it('deletes every stored variant for the kind and nothing else', async () => {
    await saveAlertSound(dir, 'done', 'a.wav', b64(WAV))
    await saveAlertSound(dir, 'needsYou', 'b.wav', b64(WAV))
    expect(await clearAlertSound(dir, 'done')).toBe(true)
    expect(await fs.readdir(alertSoundsDir(dir))).toEqual(['needsYou.sound'])
    expect(await readAlertSound(dir, 'done')).toBeNull()
  })

  it('is a successful no-op when nothing is stored, and refuses an unknown kind', async () => {
    expect(await clearAlertSound(dir, 'done')).toBe(true)
    expect(await clearAlertSound(dir, 'nope' as never)).toBe(false)
  })
})
