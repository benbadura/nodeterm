import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { isLiquidGlass } from '../lib/appTheme'
import { gradientCss, normalizeWallpaper, type DesktopWallpaper } from '@shared/wallpaper'
import { useSettings } from './settings'

/**
 * The canvas background for the current `desktopWallpaper` setting, as a CSS `background-image`
 * value, or null for none (the canvas then draws exactly as before).
 *
 * `background-image` only, never folded into a `background` shorthand next to `var(--canvas-bg)`:
 * Chromium drops any value that holds a var() once it passes ~2 MB, and a still's data: URL is
 * about 3 MB, so the shorthand silently resolved to nothing and the canvas stayed black.
 *
 * A gradient preset is CSS and resolves synchronously. A still or an imported image is a data:
 * URL from core (`wallpaper.load`), cached here by value so a re-render or a round trip through
 * Settings never re-reads a multi-MB file. A load that fails resolves to null — degrade to the
 * plain canvas, never to a stale picture.
 *
 * `resolved` holds the settled value synchronously, so a hook mounting after the load (every board
 * open) paints the wallpaper on its FIRST frame instead of one black frame while the promise settles.
 */
const loaded = new Map<string, Promise<string | null>>()
const resolved = new Map<string, string>()

function cacheKey(w: DesktopWallpaper): string {
  return JSON.stringify(w)
}

function load(w: DesktopWallpaper): Promise<string | null> {
  const key = cacheKey(w)
  let p = loaded.get(key)
  if (p) {
    // A hit is a USE: move it to the back so eviction takes the least recently used, not the
    // first inserted (code review 6 #8 — re-reading the canvas still did not protect it).
    loaded.delete(key)
    loaded.set(key, p)
  } else {
    // ponytail: keep the two most recently used images (Map order = recency): the canvas's own
    // wallpaper and the Settings "Your image" tile are both live consumers, and a cache of one let
    // opening Settings evict the canvas still (the board's next first frame went black and re-read
    // 3 MB, code review 5 #3). A picker session that flips through ten stills still pins at most two.
    if (loaded.size >= 2) {
      const oldest = loaded.keys().next().value as string
      loaded.delete(oldest)
      resolved.delete(oldest)
    }
    p = window.nodeTerminal.wallpaper
      .load(w)
      .then((url) => (url ? `url("${url}")` : null))
      .catch(() => null)
    loaded.set(key, p)
    // A miss is not remembered, so the NEXT selection of this wallpaper asks core again instead of
    // getting the cached null for the rest of the app run. Nothing retries on its own.
    void p.then((bg) => {
      if (loaded.get(key) !== p) return
      if (bg === null) loaded.delete(key)
      else resolved.set(key, bg)
    })
  }
  return p
}

export function useWallpaperBackground(): string | null {
  return useWallpaperBackgroundFor(useSettings((s) => s.settings.desktopWallpaper))
}

/** The same background for any wallpaper value (the Settings "Your image" tile shows the imported
 *  picture this way). `null`/absent = none. */
export function useWallpaperBackgroundFor(raw: unknown): string | null {
  const w = normalizeWallpaper(raw)
  const key = cacheKey(w)
  // null = no wallpaper, a string = a gradient, undefined = a file that has to be loaded.
  const sync = w.kind === 'none' ? null : w.kind === 'preset' ? gradientCss(w.id) : undefined
  const [async, setAsync] = useState<{ key: string; bg: string | null } | null>(null)
  useEffect(() => {
    if (sync !== undefined) return
    let live = true
    void load(w).then((bg) => {
      if (live) setAsync({ key, bg })
    })
    return () => {
      live = false
    }
    // `key` carries `w`'s identity; `w` itself is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sync])
  if (sync !== undefined) return sync
  return async?.key === key ? async.bg : (resolved.get(key) ?? null)
}

/** The wallpaper layers for a `background-image` value: a separate small longhand for the colour —
 *  folding it into the image's value is what hit Chromium's ~2 MB var() limit (see above). */
export function wallpaperLayers(bg: string): React.CSSProperties {
  return {
    backgroundColor: 'var(--canvas-bg)',
    backgroundImage: bg,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat'
  }
}

/**
 * The kanban board's background under Liquid Glass: the SAME wallpaper as the canvas, fixed to the
 * viewport so it lines up with `.canvas-root`'s pixel for pixel. The board stays opaque (the canvas
 * under it is covered, and the covered-canvas animation gate stays valid). Other looks: undefined,
 * the board's own background as before.
 */
export function useBoardWallpaperStyle(): React.CSSProperties | undefined {
  const glass = isLiquidGlass(useSettings((s) => s.settings.appTheme))
  const bg = useWallpaperBackground()
  return useMemo(
    () => (glass && bg ? { ...wallpaperLayers(bg), backgroundAttachment: 'fixed' } : undefined),
    [glass, bg]
  )
}
