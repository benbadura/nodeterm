import { useCallback, useState, type ReactNode } from 'react'
import { Tooltip } from '../components/Tooltip'
import { IconMinimap, IconMinus } from '../components/icons'
import { readMinimapCollapsed, writeMinimapCollapsed } from '../lib/minimapCollapse'

/**
 * The bottom-right minimap with a minimize control: hovering the map reveals a small "−" in its
 * top-left corner, and a minimized map leaves a single restore button in its place. The choice is
 * personal and remembered per machine (`lib/minimapCollapse`).
 *
 * The map is passed as `children` and simply NOT rendered while minimized, so its agent-status
 * subscription and store projection stop with it instead of repainting an invisible map.
 *
 * Both states live inside <ReactFlow> (the map needs its store); neither uses a library Panel for
 * the wrapper — the dock positions itself and turns the map's own Panel into an in-flow child
 * (styles.css `.minimap-dock`), so the hover area is exactly the map. The restore button opts into
 * fit-view's obstacle list via `data-canvas-chrome`; the expanded map is already on it (`.minimap`).
 */
export function MinimapDock({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(readMinimapCollapsed)
  const setAndRemember = useCallback((next: boolean) => {
    setCollapsed(next)
    writeMinimapCollapsed(next)
  }, [])

  if (collapsed) {
    return (
      <div className="minimap-restore nodrag nopan" data-canvas-chrome>
        <Tooltip label="Show minimap" placement="top">
          <button type="button" aria-label="Show minimap" onClick={() => setAndRemember(false)}>
            <IconMinimap />
          </button>
        </Tooltip>
      </div>
    )
  }
  return (
    <div className="minimap-dock">
      {children}
      <Tooltip label="Minimize minimap" placement="top">
        <button
          type="button"
          className="minimap-dock__minimize nodrag nopan"
          aria-label="Minimize minimap"
          onClick={() => setAndRemember(true)}
        >
          <IconMinus />
        </button>
      </Tooltip>
    </div>
  )
}
