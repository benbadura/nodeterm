// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { MdViewHintButton } from './MdViewHintButton'
import { NodeLabels } from './kanban/NodeLabels'
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

describe('MdViewHintButton', () => {
  it('shows the chord and the label, carries its tooltip, and is not a drag handle', () => {
    act(() =>
      root.render(<MdViewHintButton hint={{ chip: '⌘M', label: 'Markdown view' }} tooltip="Open markdown view (⌘M)" onToggle={() => {}} />)
    )
    const btn = host.querySelector('button.term-node__mdhint') as HTMLButtonElement
    expect(btn.classList.contains('nodrag')).toBe(true)
    expect(btn.querySelector('.term-node__mdhint-chip')?.textContent).toBe('⌘M')
    expect(btn.textContent).toBe('⌘M Markdown view')
    expect(btn.title).toBe('Open markdown view (⌘M)')
  })

  it('clicking toggles the view', () => {
    const onToggle = vi.fn()
    act(() => root.render(<MdViewHintButton hint={{ chip: '⌘M', label: 'Terminal' }} tooltip="t" onToggle={onToggle} />))
    act(() => (host.querySelector('button') as HTMLButtonElement).click())
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})

describe('NodeLabels trailing slot', () => {
  it('renders the real hint button at the END of the label row, outside the chips\' wrapping group; a click toggles', () => {
    const onToggle = vi.fn()
    act(() =>
      root.render(
        <NodeLabels
          nodeId="n1"
          trailing={<MdViewHintButton hint={{ chip: '⌘M', label: 'Markdown view' }} tooltip="t" onToggle={onToggle} />}
        />
      )
    )
    const row = host.querySelector('.term-node__labelrow') as HTMLElement
    const main = row.querySelector(':scope > .term-node__labelmain') as HTMLElement
    const trail = row.lastElementChild as HTMLElement
    expect(main.querySelector('.term-node__labeladd')).toBeTruthy()
    expect(trail.classList.contains('term-node__labeltrail')).toBe(true)
    expect(main.contains(trail)).toBe(false)
    const btn = trail.querySelector('button.term-node__mdhint') as HTMLButtonElement
    expect(btn.textContent).toBe('⌘M Markdown view')
    act(() => btn.click())
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('renders no trailing slot when none is given (other callers unchanged)', () => {
    act(() => root.render(<NodeLabels nodeId="n1" />))
    expect(host.querySelector('.term-node__labeltrail')).toBeNull()
    expect(host.querySelector('.term-node__labelmain .term-node__labeladd')).toBeTruthy()
  })
})

describe('TerminalNode wiring', () => {
  const src = readFileSync(join(__dirname, '../nodes/TerminalNode.tsx'), 'utf8').replace(/\r\n/g, '\n')
  it('builds useChat from chatAvailable — the one value the hint label is also fed', () => {
    expect(src).toContain('const useChat = mdMode && chatAvailable')
  })
})

// The hint must NEVER add a line to the label row: a taller row shrinks the terminal body, which
// refits xterm and SIGWINCHes tmux — on every ⌘M toggle at a wrap boundary.
describe('label row: the trailing slot cannot wrap or grow the row', () => {
  const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (sel: string): string => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = css.match(new RegExp(`\\n${esc}\\s*{([^}]*)}`))
    expect(m, `rule not found: ${sel}`).toBeTruthy()
    return m![1]
  }
  const decl = (body: string, prop: string): string | undefined =>
    body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`))?.[1].trim()

  it('the row itself never wraps and has no gap (the chips group carries the old gap and wrapping)', () => {
    const row = rule('.term-node__labelrow')
    expect(decl(row, 'flex-wrap')).toBe('nowrap')
    expect(decl(row, 'gap')).toBe('0')
    const main = rule('.term-node__labelmain')
    expect(decl(main, 'display')).toBe('flex')
    expect(decl(main, 'flex-wrap')).toBe('wrap')
    expect(decl(main, 'gap')).toBe('4px')
    // Basis = its content, never grows: it wraps against the row's width exactly as the row did.
    expect(decl(main, 'flex')).toBe('0 1 auto')
    expect(decl(main, 'min-width')).toBe('0')
  })

  it('the trailing slot has a ZERO basis: it only ever takes space the chips left over, and clips', () => {
    const trail = rule('.term-node__labeltrail')
    expect(decl(trail, 'flex')).toBe('1 1 0')
    expect(decl(trail, 'min-width')).toBe('0')
    expect(decl(trail, 'overflow')).toBe('hidden')
    expect(decl(trail, 'margin-left')).toBeUndefined() // no margin: it would narrow the chips\' room
  })

  it('the hint shrinks by ellipsis on one line', () => {
    const hint = rule('.term-node__mdhint')
    expect(decl(hint, 'white-space')).toBe('nowrap')
    expect(decl(hint, 'overflow')).toBe('hidden')
    expect(decl(hint, 'text-overflow')).toBe('ellipsis')
    expect(decl(hint, 'min-width')).toBe('0')
  })

  it('the hint\'s box is exactly "+ Label"\'s — same font size, vertical padding, border width and font', () => {
    const add = rule('.term-node__labeladd')
    const hint = rule('.term-node__mdhint')
    expect(decl(hint, 'font-size')).toBe(decl(add, 'font-size'))
    expect(decl(hint, 'padding')?.split(/\s+/)[0]).toBe(decl(add, 'padding')?.split(/\s+/)[0])
    expect(decl(hint, 'border')?.split(/\s+/)[0]).toBe(decl(add, 'border')?.split(/\s+/)[0])
    // A different font family inside (a monospace chord) brings its own, taller line box.
    expect(css).not.toMatch(/\n\.term-node__mdhint-chip\s*{[^}]*font-family/)
  })
})
