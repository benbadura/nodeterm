import { useSyncExternalStore } from 'react'
import type { GlassA11y } from './glassContrast'

// The two system settings Liquid Glass must yield to (HIG liquid-glass.md, accessibility):
// Reduce Transparency and Increase Contrast. Electron and the browser both expose them as media
// queries, so one subscription serves every surface.
const REDUCE = '(prefers-reduced-transparency: reduce)'
const MORE = '(prefers-contrast: more)'

const query = (q: string): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q) : null

let snapshot: GlassA11y = read()
function read(): GlassA11y {
  return { reduceTransparency: !!query(REDUCE)?.matches, moreContrast: !!query(MORE)?.matches }
}

function subscribe(onChange: () => void): () => void {
  const lists = [query(REDUCE), query(MORE)].filter((l): l is MediaQueryList => !!l)
  const handler = (): void => {
    snapshot = read()
    onChange()
  }
  for (const l of lists) l.addEventListener('change', handler)
  return () => {
    for (const l of lists) l.removeEventListener('change', handler)
  }
}

export function useGlassA11y(): GlassA11y {
  return useSyncExternalStore(subscribe, () => snapshot)
}
