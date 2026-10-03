import { describe, expect, it } from 'vitest'
import { MD_VIEW_HINT_ID, mdViewHint } from './mdViewHint'
import { HIDEABLE_HEADER_BUTTONS, isHidden } from './ui-visibility'

const base = { chip: '⌘M', open: false, chatAvailable: false, hidden: [] as string[] }

describe('mdViewHint', () => {
  it('names the markdown view on a node whose ⌘M opens the output view', () => {
    expect(mdViewHint(base)).toEqual({ chip: '⌘M', label: 'Markdown view' })
  })

  it('names the chat view when ⌘M opens the transcript (chat-capable node, known session)', () => {
    expect(mdViewHint({ ...base, chatAvailable: true })).toEqual({ chip: '⌘M', label: 'Chat view' })
  })

  it('while the view is open, names what the chord returns to', () => {
    expect(mdViewHint({ ...base, open: true })).toEqual({ chip: '⌘M', label: 'Terminal' })
    expect(mdViewHint({ ...base, open: true, chatAvailable: true })).toEqual({ chip: '⌘M', label: 'Terminal' })
  })

  it('renders the user\'s own chord verbatim (platform / override aware)', () => {
    expect(mdViewHint({ ...base, chip: 'Ctrl+Shift+M' })?.chip).toBe('Ctrl+Shift+M')
  })

  it('shows nothing when the chord is unbound — never promise a chord that does not fire', () => {
    expect(mdViewHint({ ...base, chip: '' })).toBeNull()
    expect(mdViewHint({ ...base, chip: '', open: true })).toBeNull()
  })

  it('shows nothing when the user hid it in Settings → Appearance', () => {
    expect(mdViewHint({ ...base, hidden: [MD_VIEW_HINT_ID] })).toBeNull()
  })

  it('is in the terminal-header hideable inventory, shown by default', () => {
    expect(HIDEABLE_HEADER_BUTTONS.some((r) => r.id === MD_VIEW_HINT_ID)).toBe(true)
    expect(isHidden(MD_VIEW_HINT_ID, [])).toBe(false)
    expect(isHidden(MD_VIEW_HINT_ID, [MD_VIEW_HINT_ID])).toBe(true)
  })
})
