// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MinimapDock } from './MinimapDock'
import { MINIMAP_COLLAPSED_KEY } from '../lib/minimapCollapse'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement

function mount() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <MinimapDock>
        <div id="map" />
      </MinimapDock>
    )
  )
}
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

beforeEach(() => localStorage.clear())
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('shows the map with a minimize control by default', () => {
  mount()
  expect(host.querySelector('#map')).not.toBeNull()
  expect(button('Minimize minimap')).not.toBeNull()
  expect(button('Show minimap')).toBeNull()
})

it('minimizing unmounts the map, leaves a restore button, and remembers the choice', () => {
  mount()
  act(() => button('Minimize minimap')!.click())
  // Unmounted, not hidden: the map's status subscription must stop with it.
  expect(host.querySelector('#map')).toBeNull()
  const restore = button('Show minimap')
  expect(restore).not.toBeNull()
  // fit-view must still treat the corner as occupied.
  expect(restore!.closest('[data-canvas-chrome]')).not.toBeNull()
  expect(localStorage.getItem(MINIMAP_COLLAPSED_KEY)).toBe('1')

  act(() => restore!.click())
  expect(host.querySelector('#map')).not.toBeNull()
  expect(localStorage.getItem(MINIMAP_COLLAPSED_KEY)).toBe('0')
})

it('starts minimized when the choice was remembered', () => {
  localStorage.setItem(MINIMAP_COLLAPSED_KEY, '1')
  mount()
  expect(host.querySelector('#map')).toBeNull()
  expect(button('Show minimap')).not.toBeNull()
})
