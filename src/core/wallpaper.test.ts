import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { wallpapersToKeep } from '../shared/wallpaper'
import { cachedImagePath, importWallpaper, pruneWallpaperCache, scanStills } from './wallpaper'

const HASH = 'a'.repeat(40)
let root: string | null = null
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = null
})

function put(rel: string, bytes: number): void {
  const p = path.join(root!, rel)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, Buffer.alloc(bytes))
}

describe('scanStills', () => {
  it('finds >1MB stills incl. .wallpapers/*, skips thumbnails/placeholders, scenic first', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'wp-'))
    put('Mac Blue.heic', 2_000_000)
    put('Sonoma.heic', 2_000_000)
    put('.wallpapers/Sonoma Horizon/Sonoma Horizon.heic', 2_000_000)
    put('.wallpapers/Sonoma Horizon/Sonoma Horizon.madesktop', 2_000_000)
    put('.thumbnails/Big.heic', 2_000_000)
    put('Tiny.heic', 1000)
    put('notes.txt', 2_000_000)
    const list = await scanStills(root)
    expect(list.map((s) => s.label)).toEqual(['Sonoma Horizon', 'Sonoma', 'Mac Blue'])
    expect(list[0].id).toBe('mac:.wallpapers/Sonoma Horizon/Sonoma Horizon.heic')
  })

  it('a missing root is an empty list', async () => {
    expect(await scanStills(path.join(tmpdir(), 'no-such-wallpaper-dir-xyz'))).toEqual([])
  })
})

describe('cachedImagePath (the read jail)', () => {
  const cache = path.resolve('/data/wallpapers')
  it('accepts only a hash-named direct child of the cache dir', () => {
    expect(cachedImagePath(path.join(cache, `${HASH}.jpg`), cache)).toBe(path.join(cache, `${HASH}.jpg`))
    expect(cachedImagePath(path.join(cache, `${HASH}-t.jpg`), cache)).not.toBeNull()
  })
  it.each([
    ['traversal', path.join(cache, '..', `${HASH}.jpg`)],
    ['nested', path.join(cache, 'x', `${HASH}.jpg`)],
    ['non-hash name', path.join(cache, 'id_rsa.jpg')],
    ['wrong extension', path.join(cache, `${HASH}.txt`)],
    ['windows-shaped', `C:\\Users\\me\\${HASH}.jpg`],
    ['empty', '']
  ])('refuses %s', (_label, p) => {
    expect(cachedImagePath(p, cache)).toBeNull()
  })
})

describe('importWallpaper', () => {
  it('refuses a file that is not a supported image', async () => {
    await expect(importWallpaper('/etc/passwd')).rejects.toThrow(/JPEG, PNG, WebP or HEIC/)
    await expect(importWallpaper(42)).rejects.toThrow()
  })
})

describe('pruneWallpaperCache', () => {
  it('removes only unreferenced full-size cache files; keeps the kept, thumbs, temps and foreign files', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'wp-cache-'))
    const keep = `${'a'.repeat(40)}.jpg`
    const stale = `${'b'.repeat(40)}.png`
    const thumb = `${'c'.repeat(40)}-t.jpg`
    const temp = `${'d'.repeat(40)}.jpg.123.1.tmp`
    for (const f of [keep, stale, thumb, temp, 'notes.txt']) put(f, 10)
    await pruneWallpaperCache([{ kind: 'image', path: path.join(root, keep) }, { kind: 'none' }], root)
    expect(readdirSync(root).sort()).toEqual([keep, thumb, temp, 'notes.txt'].sort())
  })

  it('choosing a preset keeps the most recent imported image (visual QA H6)', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'wp-cache-'))
    const recent = `${'e'.repeat(40)}.png`
    const older = `${'f'.repeat(40)}.png`
    for (const f of [recent, older]) put(f, 10)
    const next = { kind: 'preset', id: 'gradient:sunrise' }
    await pruneWallpaperCache(wallpapersToKeep({ desktopWallpaper: next, recentWallpaperImage: path.join(root, recent) }), root)
    expect(readdirSync(root)).toEqual([recent])
  })

  it('a missing cache dir is not an error', async () => {
    await expect(pruneWallpaperCache([], path.join(tmpdir(), 'no-such-wp-cache-xyz'))).resolves.toBeUndefined()
    expect(existsSync(path.join(tmpdir(), 'no-such-wp-cache-xyz'))).toBe(false)
  })
})
