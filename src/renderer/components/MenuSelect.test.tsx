// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MenuSelect, nextEnabled, type MenuSelectOption } from './MenuSelect'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS: MenuSelectOption<string>[] = [
  { value: 'a', label: 'Alpha', hint: 'first' },
  { value: 'b', label: 'Beta', disabled: true, hint: 'not here' },
  { value: 'c', label: 'Gamma' }
]

let host: HTMLDivElement
let root: Root
let onChange: ReturnType<typeof vi.fn<(v: string) => void>>
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  onChange = vi.fn()
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

function Harness(p: { disabled?: boolean }): React.JSX.Element {
  const [value, setValue] = useState('a')
  return (
    <MenuSelect
      label="Pick"
      value={value}
      options={OPTIONS}
      disabled={p.disabled}
      onChange={(v) => {
        onChange(v)
        setValue(v)
      }}
    />
  )
}
const mount = (disabled = false): void => act(() => root.render(<Harness disabled={disabled} />))
const triggerEl = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('.menu-select__trigger')!
const menu = (): HTMLElement | null => document.querySelector('.menu-select__menu')
const key = (el: Element, k: string): void =>
  act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
const click = (el: Element): void => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const focusedLabel = (): string | null | undefined =>
  (document.activeElement as HTMLElement | null)?.querySelector('.menu-select__label')?.textContent

describe('nextEnabled', () => {
  it('skips disabled options and wraps both ways', () => {
    expect(nextEnabled(OPTIONS, 0, 1)).toBe(2)
    expect(nextEnabled(OPTIONS, 2, 1)).toBe(0)
    expect(nextEnabled(OPTIONS, 0, -1)).toBe(2)
    expect(nextEnabled(OPTIONS, -1, 1)).toBe(0)
  })
  it('stays put when nothing else can be picked', () => {
    expect(nextEnabled([{ value: 1, label: 'x' }], 0, 1)).toBe(0)
  })
})

describe('MenuSelect', () => {
  it('shows the current choice, and names the row and the choice to a screen reader', () => {
    mount()
    expect(triggerEl().textContent).toBe('Alpha')
    expect(triggerEl().getAttribute('aria-label')).toBe('Pick: Alpha')
    expect(triggerEl().getAttribute('aria-expanded')).toBe('false')
    expect(menu()).toBeNull()
  })

  it('a click opens it on the current choice; picking one closes it and gives focus back', () => {
    mount()
    click(triggerEl())
    expect(triggerEl().getAttribute('aria-expanded')).toBe('true')
    expect(focusedLabel()).toBe('Alpha')
    const gamma = [...document.querySelectorAll('.menu-select__item')][2]
    click(gamma)
    expect(onChange).toHaveBeenCalledWith('c')
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(triggerEl())
    expect(triggerEl().textContent).toBe('Gamma')
  })

  it('the arrows move over the options that can be picked; a disabled one is never focused or picked', () => {
    mount()
    key(triggerEl(), 'ArrowDown')
    expect(menu()).not.toBeNull()
    expect(focusedLabel()).toBe('Alpha')
    key(document.activeElement!, 'ArrowDown')
    expect(focusedLabel()).toBe('Gamma')
    key(document.activeElement!, 'ArrowDown')
    expect(focusedLabel()).toBe('Alpha')
    key(document.activeElement!, 'End')
    expect(focusedLabel()).toBe('Gamma')
    key(document.activeElement!, 'Home')
    expect(focusedLabel()).toBe('Alpha')
    click([...document.querySelectorAll('.menu-select__item')][1])
    expect(onChange).not.toHaveBeenCalled()
    expect(menu()).not.toBeNull()
  })

  it('Escape and Tab close it and give focus back; Escape does not reach the window', () => {
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    try {
      mount()
      click(triggerEl())
      key(document.activeElement!, 'Escape')
      expect(menu()).toBeNull()
      expect(document.activeElement).toBe(triggerEl())
      expect(onWindowKey).not.toHaveBeenCalled()
      click(triggerEl())
      key(document.activeElement!, 'Tab')
      expect(menu()).toBeNull()
      expect(document.activeElement).toBe(triggerEl())
    } finally {
      window.removeEventListener('keydown', onWindowKey)
    }
  })

  it('a press outside closes it without picking', () => {
    mount()
    click(triggerEl())
    act(() => void document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(menu()).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a disabled select does not open, and one disabled while open closes', () => {
    mount(true)
    expect(triggerEl().disabled).toBe(true)
    key(triggerEl(), 'ArrowDown')
    expect(menu()).toBeNull()
    mount(false)
    click(triggerEl())
    expect(menu()).not.toBeNull()
    mount(true)
    expect(menu()).toBeNull()
  })

  it('a disabled option keeps its hint readable (the reason it cannot be picked)', () => {
    mount()
    click(triggerEl())
    const beta = [...document.querySelectorAll('.menu-select__item')][1]
    expect(beta.getAttribute('aria-disabled')).toBe('true')
    expect(beta.querySelector('.menu-select__hint')!.textContent).toBe('not here')
  })
})
