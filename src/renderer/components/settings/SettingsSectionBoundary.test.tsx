// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsSectionBoundary } from './SettingsSectionBoundary'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Broken(): React.JSX.Element {
  throw new ReferenceError("Cannot access 'repository' before initialization")
}

describe('SettingsSectionBoundary (#1090)', () => {
  afterEach(() => vi.restoreAllMocks())

  const render = (visible: boolean): { host: HTMLElement; unmount: () => void } => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => {
      root.render(
        <>
          <SettingsSectionBoundary title="GitHub Issues" visible={visible}>
            <Broken />
          </SettingsSectionBoundary>
          <SettingsSectionBoundary title="Terminal" visible={!visible}>
            <p>terminal settings</p>
          </SettingsSectionBoundary>
        </>
      )
    })
    return { host, unmount: () => act(() => root.unmount()) }
  }

  it('keeps the other sections rendered when one section throws', () => {
    const { host, unmount } = render(false)
    expect(host.textContent).toContain('terminal settings')
    // Not the section being viewed: its failure shows nowhere.
    expect(host.textContent).not.toContain('could not be displayed')
    unmount()
  })

  it('says the viewed section failed instead of rendering nothing', () => {
    const { host, unmount } = render(true)
    expect(host.textContent).toContain('GitHub Issues')
    expect(host.textContent).toContain('This section could not be displayed')
    expect(host.textContent).toContain("Cannot access 'repository' before initialization")
    unmount()
  })
})
