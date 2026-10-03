// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { marked } from 'marked'
import { MD_OUTPUT_MAX_LINES, renderTerminalOutput, stripTerminalControls, tailOutputLines } from './terminalOutputMarkdown'
import { renderMarkdown } from './markdown'

/** Visible text of the rendered HTML, the way a user reads it. */
function textOf(html: string): string {
  const el = document.createElement('div')
  el.innerHTML = html
  return el.textContent ?? ''
}

describe('renderTerminalOutput', () => {
  it('keeps consecutive output lines apart (ls -l must not become one line)', () => {
    const out = 'total 8\n-rw-r--r-- 1 u u 10 a.txt\n-rw-r--r-- 1 u u 20 b.txt'
    const html = renderTerminalOutput(out)
    expect(html.match(/<br>/g)?.length).toBe(2)
    expect(textOf(html)).toContain('a.txt')
  })

  it('shows raw-HTML-looking output as text instead of parsing and stripping it', () => {
    const html = renderTerminalOutput('$ echo <stdin>\n<stdin>')
    expect(textOf(html)).toMatch(/^\$ echo <stdin>\n?<stdin>\n?$/)
    expect(html).toContain('&lt;stdin&gt;')
  })

  it('shows a block of raw HTML as text, lines kept', () => {
    const html = renderTerminalOutput('<div class="x">\nhello\n</div>')
    expect(html).not.toMatch(/<div class="x">/)
    expect(textOf(html)).toContain('<div class="x">')
    expect(textOf(html)).toContain('</div>')
  })

  it('never lets an escaped tag execute — script and handlers are text, not markup', () => {
    const html = renderTerminalOutput('<img src=x onerror=alert(1)> <script>alert(1)</script>')
    const el = document.createElement('div')
    el.innerHTML = html
    expect(el.querySelector('img, script')).toBeNull()
    expect(el.textContent).toContain('<script>')
  })

  it('does not double-escape inside code spans and fenced blocks', () => {
    const html = renderTerminalOutput('run `a <b> c`\n\n```\nx < y && <tag>\n```')
    expect(textOf(html)).toContain('a <b> c')
    expect(textOf(html)).toContain('x < y && <tag>')
    expect(html).not.toContain('&amp;lt;')
  })

  it('trims the trailing blank lines and trailing spaces capture-pane pads with', () => {
    const html = renderTerminalOutput('$ ls   \nfile  \n\n\n   \n\n')
    expect(html).toBe(renderTerminalOutput('$ ls\nfile'))
    expect(html.trimEnd().endsWith('file</p>')).toBe(true)
  })

  it('still sanitizes (markdown links with javascript: urls lose their href)', () => {
    const html = renderTerminalOutput('[x](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('renders a CRLF capture exactly like its LF twin (padding before the \\r included)', () => {
    // Characterization, not a regression pin: JS's /m `$` already treats \r as a line terminator
    // and marked normalizes \r\n, so this held before the explicit \r strip — it guards both.
    expect(renderTerminalOutput('```\r\na  \r\nb\t\r\n```\r\nx \r\ny\r\n\r\n')).toBe(
      renderTerminalOutput('```\na\nb\n```\nx\ny')
    )
  })

  it('drops the colour codes an SSH capture (capture-pane -e) carries', () => {
    // Shaped like the reported screen: 256-colour SGR around file names, bold labels, a reset.
    const raw = '\x1b[1mDosyalar\x1b[0m: \x1b[38;5;153mview/web/css/items.css\x1b[39m done\n\x1b[38;5;244m────\x1b[39m'
    const html = renderTerminalOutput(raw)
    expect(html).toContain('Dosyalar')
    expect(html).toContain('view/web/css/items.css')
    expect(html).not.toMatch(/\[[0-9;]*m/)
    expect(html).not.toContain('\x1b')
  })

  it('drops OSC sequences (hyperlinks, titles) and keeps their visible text', () => {
    const raw = 'see \x1b]8;;https://example.com\x1b\\the docs\x1b]8;;\x1b\\ and \x1b]0;title\x07done'
    expect(stripTerminalControls(raw)).toBe('see the docs and done')
  })

  it('keeps tabs, newlines and a CRLF capture\'s carriage returns', () => {
    expect(stripTerminalControls('a\tb\r\nc\x07\x00d')).toBe('a\tb\r\ncd')
  })

  it('stays linear on a long run of unterminated escapes', () => {
    const raw = '\x1b['.repeat(200_000) + 'x'
    const t = performance.now()
    stripTerminalControls(raw)
    expect(performance.now() - t).toBeLessThan(1000)
  })

  it('tailOutputLines counts lines after the codes are gone', () => {
    const { text, dropped } = tailOutputLines('\x1b[31ma\x1b[0m\nb\nc', 2)
    expect(text).toBe('b\nc')
    expect(dropped).toBe(1)
  })

  it('renders empty input as empty', () => {
    expect(renderTerminalOutput('')).toBe('')
    expect(renderTerminalOutput('\n\n  \n')).toBe('')
  })

  it('does not mutate the shared marked config the other callers use', () => {
    renderTerminalOutput('a\nb <x>')
    expect(marked.defaults.breaks).toBe(false)
    expect(renderMarkdown('a\nb')).toBe('<p>a\nb</p>\n')
    expect(renderMarkdown('<b>x</b>')).toBe('<p><b>x</b></p>\n')
  })
})

describe('tailOutputLines', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

  it('is 5000 lines', () => {
    expect(MD_OUTPUT_MAX_LINES).toBe(5000)
  })

  it('keeps output at or under the cap whole', () => {
    expect(tailOutputLines(lines(3), 3)).toEqual({ text: lines(3), dropped: 0 })
  })

  it('keeps only the LAST max lines and reports how many were dropped', () => {
    const r = tailOutputLines(lines(10), 4)
    expect(r.dropped).toBe(6)
    expect(r.text).toBe('line 7\nline 8\nline 9\nline 10')
  })

  it('does not let capture-pane trailing padding eat the budget', () => {
    const r = tailOutputLines(`${lines(4)}\n\n\n   \n\n`, 4)
    expect(r).toEqual({ text: lines(4), dropped: 0 })
  })

  it('defaults to MD_OUTPUT_MAX_LINES and handles CRLF + empty input', () => {
    expect(tailOutputLines(lines(MD_OUTPUT_MAX_LINES + 2)).dropped).toBe(2)
    expect(tailOutputLines('a\r\nb\r\nc', 2)).toEqual({ text: 'b\nc', dropped: 1 })
    expect(tailOutputLines('')).toEqual({ text: '', dropped: 0 })
  })
})
