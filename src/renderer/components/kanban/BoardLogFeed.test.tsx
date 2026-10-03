// @vitest-environment jsdom
//
// The card feed folds runs of like events into one "×N" row at RENDER time; expanding it shows
// every row it holds. Comments and the two audit types always render one row per entry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BoardLogEntry, BoardLogEvent } from '@shared/types'
import { BoardLogFeed } from './BoardLogPanel'

let root: Root
let host: HTMLElement
const A = { name: 'enes', color: '#0a84ff' }
const ev = (id: string, ts: number, type: BoardLogEvent['type']): BoardLogEntry => ({
  id, ts, author: A, nodeId: 'card', kind: 'event', event: { type, from: 'To Do', to: 'Done' }
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const rows = (): number => host.querySelectorAll('.board-log__event, .board-log__comment').length

describe('BoardLogFeed', () => {
  it('shows a run of like events as one ×N row that expands to every entry', () => {
    const feed = [ev('3', 3000, 'card-moved'), ev('2', 2000, 'card-moved'), ev('1', 1000, 'card-moved')]
    act(() => root.render(<BoardLogFeed feed={feed} />))
    expect(rows()).toBe(1)
    const more = host.querySelector<HTMLButtonElement>('.board-log__fold')!
    expect(more.textContent).toContain('×3')
    act(() => {
      more.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(rows()).toBe(3)
    expect(host.querySelector('.board-log__fold')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('renders every audit row on its own', () => {
    const feed = [
      ev('3', 3000, 'agent-message'),
      ev('2', 2000, 'agent-message'),
      ev('1', 1000, 'agent-read-cookies')
    ]
    act(() => root.render(<BoardLogFeed feed={feed} />))
    expect(rows()).toBe(3)
    expect(host.querySelector('.board-log__fold')).toBeNull()
  })
})
