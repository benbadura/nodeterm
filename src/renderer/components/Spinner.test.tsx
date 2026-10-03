// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { Spinner } from './Spinner'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Spinner', () => {
  it('with a label, is its own polite status region named by that label', () => {
    act(() => root.render(<Spinner label="Loading conversation" />))
    const el = host.querySelector('.nt-spinner') as HTMLElement
    expect(el.getAttribute('role')).toBe('status')
    expect(el.getAttribute('aria-live')).toBe('polite')
    expect(el.getAttribute('aria-label')).toBe('Loading conversation')
    expect(el.textContent).toBe('')
  })

  it('without a label, is decorative — the visible text beside it is what gets announced', () => {
    act(() => root.render(<Spinner />))
    const el = host.querySelector('.nt-spinner') as HTMLElement
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.hasAttribute('role')).toBe(false)
  })
})
