// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IOS_APP_STORE_URL } from '@renderer/lib/links'
import { MobileLaunchCard } from './MobileLaunchCard'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let openExternal: ReturnType<typeof vi.fn>

beforeEach(() => {
  openExternal = vi.fn()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { shell: { openExternal } }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('MobileLaunchCard', () => {
  it('names the store generically and offers exactly the published store buttons', () => {
    act(() => root.render(<MobileLaunchCard onClose={() => {}} />))
    const text = document.body.textContent ?? ''
    expect(text).toContain('nodeterm mobile is now on the App Store')
    expect(text).not.toContain('iOS app')
    expect(text).not.toContain('Google Play') // not published yet
    const buttons = [...document.body.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(buttons).toEqual(['Get it on the App Store', 'Close'])
    act(() => {
      ;[...document.body.querySelectorAll('button')][0].click()
    })
    expect(openExternal).toHaveBeenCalledWith(IOS_APP_STORE_URL)
  })
})
