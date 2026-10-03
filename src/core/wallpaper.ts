import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { IPC } from '../shared/ipc'
import {
  normalizeWallpaper,
  wallpapersToKeep,
  type DesktopWallpaper,
  type WallpaperStill
} from '../shared/wallpaper'
import { renameAtomic, tempNameFor } from './fs-atomic'
import { platform } from './platform'

/**
 * Wallpaper files for the canvas background (Liquid Glass appearance). Core, so both shells serve
 * it: on the Server Edition (Linux) the stills list is simply empty and gradients need no files.
 *
 * Every file the renderer can get bytes for lives in ONE directory, `<userData>/wallpapers/`, under
 * a hash name this module minted. The renderer never names a path to read: a still is named by its
 * `mac:` id and re-resolved against a fresh scan, and an imported image's path must be a direct
 * child of the cache dir with a hash-shaped name (`cachedImagePath`). So a hand-edited
 * settings.json cannot aim `load` at anything else, and there is no traversal to reject because
 * no caller-supplied segment is ever joined.
 *
 * `import` is the one exception: it takes a caller-supplied source path (the file picker's answer)
 * and copies any JPEG/PNG/WebP/HEIC-named regular file into the cache, whose bytes `load` then
 * returns. That is no wider than what the same caller already has (`fs:read` on both shells), but
 * it means the jail above governs `load`, not what can ENTER the cache.
 */

const run = promisify(execFile)

export const SYSTEM_WALLPAPER_DIR = '/System/Library/Desktop Pictures'
const SIPS = '/usr/bin/sips'
/** Real stills are several MB; the 356px `.madesktop` placeholders and thumbnails are not. */
const MIN_STILL_BYTES = 1_000_000
const STILL_EXT = /\.(heic|jpe?g|png)$/i
const IMPORT_EXT = /\.(heic|jpe?g|png|webp)$/i
/** Shown first, in this order: the scenic ones. */
const SCENIC_FIRST = ['Sonoma Horizon', 'Sonoma']
const FULL_PX = 3840
const THUMB_PX = 320
/** Refuse to ship anything bigger over IPC as a data: URL. */
const MAX_LOAD_BYTES = 25 * 1024 * 1024
const CACHED_NAME = /^[0-9a-f]{40}(-t)?\.(jpg|jpeg|png|webp)$/

export interface ScannedStill {
  id: string
  label: string
  path: string
}

export function wallpaperCacheDir(): string {
  return path.join(platform().userDataDir, 'wallpapers')
}

/**
 * The stock macOS stills under `root`, scenic first. Recurses into `.wallpapers/<name>/`, skips
 * `.thumbnails` and anything under 1 MB (which is what drops the `.madesktop` placeholders' tiny
 * siblings). A missing root is an empty list, which is the answer everywhere but macOS.
 */
export async function scanStills(root = SYSTEM_WALLPAPER_DIR, depth = 3): Promise<ScannedStill[]> {
  const found: ScannedStill[] = []
  const walk = async (dir: string, left: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== '.thumbnails' && left > 0) await walk(p, left - 1)
      } else if (e.isFile() && STILL_EXT.test(e.name)) {
        try {
          if ((await stat(p)).size < MIN_STILL_BYTES) continue
        } catch {
          continue
        }
        const rel = path.relative(root, p).split(path.sep).join('/')
        found.push({ id: `mac:${rel}`, label: e.name.replace(STILL_EXT, ''), path: p })
      }
    }
  }
  await walk(root, depth)
  const seen = new Set<string>()
  const rank = (label: string): number => {
    const i = SCENIC_FIRST.indexOf(label)
    return i === -1 ? SCENIC_FIRST.length : i
  }
  return found
    .sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label))
    .filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true)))
}

/** A cached file's name: stable per source file version and output size. */
async function cacheKey(src: string, variant: string): Promise<string> {
  const st = await stat(src)
  return createHash('sha1').update(`${src}\x00${st.mtimeMs}\x00${st.size}\x00${variant}`).digest('hex')
}

/** In-flight conversions, so two callers asking for the same file share one `sips`. */
const inflight = new Map<string, Promise<string>>()

/** Publish `produce(tmp)` at `target` through a unique temp, unless it is already there. */
function publishOnce(target: string, produce: (tmp: string) => Promise<void>): Promise<string> {
  const pending = inflight.get(target)
  if (pending) return pending
  const job = (async () => {
    try {
      await stat(target)
      return target
    } catch {
      // not cached yet
    }
    await mkdir(path.dirname(target), { recursive: true })
    const tmp = tempNameFor(target)
    try {
      await produce(tmp)
      await renameAtomic(tmp, target)
    } catch (err) {
      await unlink(tmp).catch(() => {})
      throw err
    }
    return target
  })().finally(() => inflight.delete(target))
  inflight.set(target, job)
  return job
}

/** The long edge of an image in px, per `sips`; null when it cannot say. */
async function longEdge(src: string): Promise<number | null> {
  try {
    const { stdout } = await run(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', src], {
      timeout: 30_000
    })
    const dims = [...stdout.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1]))
    return dims.length === 2 ? Math.max(dims[0], dims[1]) : null
  } catch {
    return null
  }
}

/**
 * HEIC/JPEG/PNG/WebP → JPEG no larger than `px` on its long edge, via macOS's built-in `sips`.
 * `-Z` alone would also UPSCALE (measured: a 320px image comes out 3840px wide), so it is passed
 * only when the image is actually larger; an unreadable size is treated as larger.
 */
function convertWithSips(src: string, px: number, suffix: string): Promise<string> {
  return cacheKey(src, `sips${px}`).then((key) =>
    publishOnce(path.join(wallpaperCacheDir(), `${key}${suffix}.jpg`), async (tmp) => {
      const edge = await longEdge(src)
      const resize = edge === null || edge > px ? ['-Z', String(px)] : []
      await run(SIPS, ['-s', 'format', 'jpeg', ...resize, src, '--out', tmp], { timeout: 60_000 })
    })
  )
}

let stillScan: Promise<ScannedStill[]> | null = null
function stills(): Promise<ScannedStill[]> {
  if (process.platform !== 'darwin') return Promise.resolve([])
  // One scan per app run: the system stills only change with an OS update.
  stillScan ??= scanStills().catch(() => [])
  return stillScan
}

/**
 * The size check and the read go through ONE open descriptor, so the file measured is the file
 * read: a stat-then-readFile pair could be handed a different (larger) file between the two.
 */
async function toDataUrl(file: string): Promise<string | null> {
  let fh
  try {
    fh = await open(file, 'r')
    const st = await fh.stat()
    if (!st.isFile() || st.size > MAX_LOAD_BYTES) return null
    const ext = path.extname(file).slice(1).toLowerCase()
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${(await fh.readFile()).toString('base64')}`
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * The cache file an `image` wallpaper names, or null when the value names anything else. Only a
 * DIRECT child of the cache dir with a hash-shaped name qualifies — that is the whole jail.
 */
export function cachedImagePath(p: string, cacheDir = wallpaperCacheDir()): string | null {
  if (typeof p !== 'string' || p.length === 0) return null
  const resolved = path.resolve(p)
  if (path.dirname(resolved) !== path.resolve(cacheDir)) return null
  if (!CACHED_NAME.test(path.basename(resolved))) return null
  return resolved
}

export async function listStills(): Promise<WallpaperStill[]> {
  const list = await stills()
  const out: WallpaperStill[] = []
  // Sequential on purpose: a fresh cache runs one `sips` per still, and a dozen at once is a burst
  // of CPU for a grid of 320px thumbnails. Cached, each is a stat plus a small read.
  for (const s of list) {
    const thumb = await convertWithSips(s.path, THUMB_PX, '-t')
      .then(toDataUrl)
      .catch(() => null)
    out.push({ id: s.id, label: s.label, thumb })
  }
  return out
}

export async function loadWallpaper(value: unknown): Promise<string | null> {
  const w = normalizeWallpaper(value)
  if (w.kind === 'image') {
    const file = cachedImagePath(w.path)
    return file ? toDataUrl(file) : null
  }
  if (w.kind === 'preset' && w.id.startsWith('mac:')) {
    const still = (await stills()).find((s) => s.id === w.id)
    if (!still) return null
    return convertWithSips(still.path, FULL_PX, '')
      .then(toDataUrl)
      .catch(() => null)
  }
  return null
}

/**
 * Put a picked image into the cache and return the value to store. The cached copy is what keeps
 * the wallpaper when the original moves.
 *
 * The file is copied untouched when the page can show it as-is. On macOS `sips` converts to a
 * JPEG ≤ 3840px only when it must: HEIC (Chromium cannot decode it), or an image over 3840px or
 * over `load`'s 25 MB cap — a 60 MB camera PNG copied as-is would otherwise be refused at load,
 * which reads as a wallpaper that silently never appears. Re-encoding everything would flatten a
 * PNG/WebP's alpha and recompress a JPEG for nothing. Elsewhere there is no converter, so HEIC and
 * an over-cap image are refused HERE, where the picker can show the reason.
 */
export async function importWallpaper(sourcePath: unknown): Promise<DesktopWallpaper> {
  if (typeof sourcePath !== 'string' || !IMPORT_EXT.test(sourcePath)) {
    throw new Error('Choose a JPEG, PNG, WebP or HEIC image.')
  }
  const src = path.resolve(sourcePath)
  const keepNow = currentKeep()
  const mac = process.platform === 'darwin'
  const heic = /\.heic$/i.test(src)
  const srcStat = await stat(src)
  // A FIFO or device named `x.png` would hang copyFile/sips and wedge publishOnce for the run.
  if (!srcStat.isFile()) throw new Error('Choose a JPEG, PNG, WebP or HEIC image.')
  const tooBig = srcStat.size > MAX_LOAD_BYTES
  let result: DesktopWallpaper
  if (mac && (heic || tooBig || ((await longEdge(src)) ?? Infinity) > FULL_PX)) {
    result = { kind: 'image', path: await convertWithSips(src, FULL_PX, '') }
  } else {
    if (heic) throw new Error('HEIC images can only be converted on macOS.')
    if (tooBig) {
      throw new Error(`That image is larger than ${MAX_LOAD_BYTES / 1024 / 1024} MB. Choose a smaller one.`)
    }
    const ext = path.extname(src).toLowerCase().replace('.jpeg', '.jpg')
    const target = path.join(wallpaperCacheDir(), `${await cacheKey(src, 'copy')}${ext}`)
    await publishOnce(target, (tmp) => copyFile(src, tmp))
    result = { kind: 'image', path: target }
  }
  // The setting is written by the renderer after this returns, so keep the new file AND everything
  // the saved settings still name (the wallpaper on screen and the "Your image" tile's recent import):
  // if that save never lands, nothing the settings point at may be gone. The settings hook prunes
  // the old ones once the choice is saved.
  void pruneWallpaperCache([...keepNow, result])
  return result
}

/** The cache file a wallpaper value is drawn from, or null for none/gradients/unknown stills. */
async function fileFor(value: unknown, dir: string): Promise<string | null> {
  const w = normalizeWallpaper(value)
  if (w.kind === 'image') return cachedImagePath(w.path, dir)
  if (w.kind === 'preset' && w.id.startsWith('mac:')) {
    const still = (await stills()).find((s) => s.id === w.id)
    if (!still) return null
    const key = await cacheKey(still.path, `sips${FULL_PX}`).catch(() => null)
    return key ? path.join(dir, `${key}.jpg`) : null
  }
  return null
}

/**
 * Delete cached wallpapers nothing refers to any more. Only full-size files this module minted
 * (hash-named, no `-t`) are candidates: foreign files and temps are never touched, and still
 * thumbnails are kept (ponytail: ~20 KB each, one per system still; a stale one after an OS update
 * lingers until the cache dir is cleared). A conversion still in flight is never removed.
 *
 * Temps are deliberately left alone: `sweepStaleTempFiles` refuses any pid-bearing temp
 * (fs-atomic.ts — a pid cannot prove its writer is dead across instances), which is every temp
 * this module writes, and each writer already removes its own temp on failure.
 */
export async function pruneWallpaperCache(keep: unknown[], dir = wallpaperCacheDir()): Promise<void> {
  try {
    const keepFiles = new Set(
      (await Promise.all(keep.map((v) => fileFor(v, dir)))).filter((f): f is string => !!f)
    )
    for (const name of await readdir(dir)) {
      if (!CACHED_NAME.test(name) || name.includes('-t.')) continue
      const file = path.join(dir, name)
      if (keepFiles.has(file) || inflight.has(file)) continue
      await unlink(file).catch(() => {})
    }
  } catch {
    // best effort: a missing cache dir or an unreadable entry is nothing to clean
  }
}

let currentKeep: () => unknown[] = () => []

/**
 * Wire onto the platform's RPC surface (Electron ipcMain / server WS-RPC alike). The settings
 * accessors let the cache follow the choice: a changed `desktopWallpaper` prunes what the old one
 * left behind. There is deliberately no prune at boot: `SettingsStore.init` answers an unreadable
 * settings.json with the defaults, and pruning against that would delete the wallpaper the user
 * actually chose — a failed read is not evidence the choice went away. Only a SAVED change prunes.
 */
export function registerWallpaperIpc(settings: {
  get: () => { desktopWallpaper?: unknown; recentWallpaperImage?: unknown }
  onChange: (cb: (s: { desktopWallpaper?: unknown; recentWallpaperImage?: unknown }) => void) => unknown
}): void {
  currentKeep = () => wallpapersToKeep(settings.get())
  // The user's most recent import is kept too (`wallpapersToKeep`): choosing a preset must not
  // delete the image the "Your image" tile still offers.
  const key = (s: { desktopWallpaper?: unknown; recentWallpaperImage?: unknown }): string =>
    JSON.stringify(wallpapersToKeep(s))
  let last = key(settings.get())
  settings.onChange((s) => {
    const next = key(s)
    if (next === last) return
    last = next
    void pruneWallpaperCache(wallpapersToKeep(s))
  })
  platform().handle(IPC.wallpaperListStills, () => listStills())
  platform().handle(IPC.wallpaperLoad, (value: unknown) => loadWallpaper(value))
  platform().handle(IPC.wallpaperImport, (sourcePath: unknown) => importWallpaper(sourcePath))
}
