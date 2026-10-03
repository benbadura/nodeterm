// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ConfirmDialog choice', () => {
  let root: Root
  let host: HTMLElement
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('shows every option from the start, with the current value selected', async () => {
    const onChange = vi.fn()
    await act(async () => {
      root.render(
        <ConfirmDialog
          message="Close #7?"
          confirmLabel="Close issue"
          choice={{
            label: 'Close as',
            options: [{ value: 'completed', label: 'Completed' }, { value: 'not_planned', label: 'Not planned' }],
            value: 'completed',
            onChange
          }}
          onConfirm={() => undefined}
          onCancel={() => undefined}
        />
      )
    })
    const radios = [...document.body.querySelectorAll<HTMLInputElement>('.confirm input[type="radio"]')]
    expect(radios.map((radio) => radio.value)).toEqual(['completed', 'not_planned'])
    expect(radios.map((radio) => radio.checked)).toEqual([true, false])
    expect(document.body.querySelector('.confirm [role="radiogroup"]')?.getAttribute('aria-label')).toBe('Close as')
    await act(async () => { radios[1].click() })
    expect(onChange).toHaveBeenCalledWith('not_planned')
  })
})
