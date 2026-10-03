// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from './settings'
import { useBoardWallpaperStyle, useWallpaperBackgroundFor } from './wallpaper'

// A board opens long after the canvas loaded the wallpaper; its first frame must already carry the
// picture, or the board flashes its plain background (black) for a frame on every open.
function Probe({ seen }: { seen: (string | undefined)[] }) {
  seen.push(useBoardWallpaperStyle()?.backgroundImage as string | undefined)
  return null
}
function Tile({ path }: { path: string }) {
  useWallpaperBackgroundFor({ kind: 'image', path })
  return null
}

describe('useBoardWallpaperStyle', () => {
  const roots: Root[] = []
  const mountEl = (el: JSX.Element): void => {
    const root = createRoot(document.createElement('div'))
    roots.push(root)
    act(() => root.render(el))
  }
  const mount = (seen: (string | undefined)[]): void => mountEl(<Probe seen={seen} />)
  afterEach(() => {
    act(() => roots.splice(0).forEach((r) => r.unmount()))
    vi.unstubAllGlobals()
  })

  it('a hook mounting after the load paints the wallpaper on its first frame', async () => {
    const load = vi.fn(async () => 'data:image/jpeg;base64,AAAA')
    vi.stubGlobal('nodeTerminal', { wallpaper: { load } })
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, appTheme: 'liquid-glass', desktopWallpaper: { kind: 'image', path: 'a.jpg' } }
    })
    const canvas: (string | undefined)[] = []
    mount(canvas) // the canvas: first mount, has to wait for the load
    await act(async () => {})
    expect(canvas.at(-1)).toBe('url("data:image/jpeg;base64,AAAA")')

    const board: (string | undefined)[] = []
    mount(board) // the board, opened later
    expect(board[0]).toBe('url("data:image/jpeg;base64,AAAA")')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("a second consumer (Settings' 'Your image' tile) does not evict the canvas still", async () => {
    const load = vi.fn(async (w: { path: string }) => `data:image/png;base64,${w.path}`)
    vi.stubGlobal('nodeTerminal', { wallpaper: { load } })
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, appTheme: 'liquid-glass', desktopWallpaper: { kind: 'image', path: 'c.jpg' } }
    })
    mount([])
    await act(async () => {})
    mountEl(<Tile path="d.jpg" />) // Settings mounts every section, the tile included
    await act(async () => {})
    const board: (string | undefined)[] = []
    mount(board)
    expect(board[0]).toBe('url("data:image/png;base64,c.jpg")')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('eviction takes the least recently USED image, not the first loaded (code review 6 #8)', async () => {
    const load = vi.fn(async (w: { path: string }) => `data:image/png;base64,${w.path}`)
    vi.stubGlobal('nodeTerminal', { wallpaper: { load } })
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, appTheme: 'liquid-glass', desktopWallpaper: { kind: 'image', path: 'e.jpg' } }
    })
    mount([]) // the canvas still, first in
    await act(async () => {})
    mountEl(<Tile path="f.jpg" />)
    await act(async () => {})
    mount([]) // the canvas still is used again: now the most recent
    mountEl(<Tile path="g.jpg" />) // a third image evicts f, not e
    await act(async () => {})
    const board: (string | undefined)[] = []
    mount(board)
    expect(board[0]).toBe('url("data:image/png;base64,e.jpg")')
    expect(load).toHaveBeenCalledTimes(3)
  })
})
