import { useLayoutEffect } from 'react'
import { MiniMap, ReactFlowProvider, useStoreApi, type MiniMapProps } from '@xyflow/react'

type FlowStore = ReturnType<typeof useStoreApi>

/** After a transform-only (pan/zoom) update, one full projection follows once the move settles —
 * covers any internals change that happened to ride the same store update. */
export const MINIMAP_FULL_SYNC_DEBOUNCE_MS = 150

/** MiniMap has no node filter: CSS-hidden keep-alive guests otherwise paint rectangles AND
 * enlarge its bounds. Give only the map a filtered store, keeping the canvas's mounted guests
 * untouched. `hidden: true` on the real nodes would unmount their webviews and lose page state.
 * Camera interaction still uses the original panZoom instance; this is not a second camera.
 */
export function VisibleMiniMap(props: MiniMapProps) {
  const source = useStoreApi()
  return (
    <ReactFlowProvider>
      <MiniMapProjection source={source} />
      <MiniMap {...props} />
    </ReactFlowProvider>
  )
}

/** Exported for tests only: the projected store is not reachable through the rendered map. */
export function MiniMapProjection({ source }: { source: FlowStore }) {
  const target = useStoreApi()
  useLayoutEffect(() => {
    const visible = (n: { hidden?: boolean; data: Record<string, unknown> }) =>
      !n.hidden && n.data.ghost !== true
    // Everything the map reads except the node collections: cheap scalars/references, so the
    // fast path can copy them all and a camera update that also resizes the pane stays exact.
    const camera = (s: ReturnType<FlowStore['getState']>) => ({
      width: s.width,
      height: s.height,
      transform: s.transform,
      panZoom: s.panZoom,
      translateExtent: s.translateExtent,
      rfId: s.rfId,
      ariaLabelConfig: s.ariaLabelConfig,
      userSelectionActive: s.userSelectionActive
    })
    let prev = source.getState()
    const full = () => {
      const s = source.getState()
      prev = s
      // Internal nodes carry absolute group coordinates and measured sizes. Rebuilding them
      // from serialized/project nodes would lose both and lag live drag/resize/removal updates.
      target.setState({
        nodes: s.nodes.filter(visible),
        nodeLookup: new Map([...s.nodeLookup].filter(([, n]) => visible(n))),
        ...camera(s)
      })
    }
    let trailing: ReturnType<typeof setTimeout> | null = null
    // Pan/zoom frames change ONLY `transform`; rebuilding the filtered node collections on each
    // one re-rendered every minimap rectangle and forced ~20 layouts/s while panning. Identity
    // checks alone cannot detect a measurement update: xyflow mutates `nodeLookup` IN PLACE and
    // then calls set({}), so the fast path is taken only when `transform` itself changed (and the
    // node collections did not), and a trailing full sync always follows.
    const sync = () => {
      const s = source.getState()
      const fast =
        s.transform !== prev.transform && s.nodes === prev.nodes && s.nodeLookup === prev.nodeLookup
      if (!fast) {
        if (trailing) clearTimeout(trailing)
        trailing = null
        full()
        return
      }
      prev = s
      target.setState(camera(s))
      if (trailing) clearTimeout(trailing)
      trailing = setTimeout(() => {
        trailing = null
        full()
      }, MINIMAP_FULL_SYNC_DEBOUNCE_MS)
    }
    full()
    const unsub = source.subscribe(sync)
    return () => {
      unsub()
      if (trailing) clearTimeout(trailing)
    }
  }, [source, target])
  return null
}
