// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  decideMarkdownLinkClick,
  installMarkdownLinkGuard,
  openExternalQuietly,
  RENDERED_MARKDOWN_CONTAINERS
} from './markdownLinks'

describe('decideMarkdownLinkClick', () => {
  it('opens http/https/mailto externally', () => {
    expect(decideMarkdownLinkClick('https://github.com/x')).toEqual({
      action: 'external',
      url: 'https://github.com/x'
    })
    expect(decideMarkdownLinkClick('http://a.b/')).toEqual({ action: 'external', url: 'http://a.b/' })
    expect(decideMarkdownLinkClick('mailto:a@b.c')).toEqual({ action: 'external', url: 'mailto:a@b.c' })
    expect(decideMarkdownLinkClick('  HTTPS://A.B/x  ')).toEqual({ action: 'external', url: 'https://a.b/x' })
  })

  it('ignores same-document fragments and empty hrefs', () => {
    expect(decideMarkdownLinkClick('#section')).toEqual({ action: 'ignore' })
    expect(decideMarkdownLinkClick('#')).toEqual({ action: 'ignore' })
    expect(decideMarkdownLinkClick('')).toEqual({ action: 'ignore' })
  })

  it('treats relative paths, file: and other schemes as local (never navigated)', () => {
    expect(decideMarkdownLinkClick('src/core/pty-manager.ts:4100')).toEqual({ action: 'local' })
    expect(decideMarkdownLinkClick('./README.md')).toEqual({ action: 'local' })
    expect(decideMarkdownLinkClick('/etc/hosts')).toEqual({ action: 'local' })
    expect(decideMarkdownLinkClick('//evil.example/x')).toEqual({ action: 'local' })
    expect(decideMarkdownLinkClick('file:///etc/passwd')).toEqual({ action: 'local' })
    expect(decideMarkdownLinkClick('vscode://file/x')).toEqual({ action: 'local' })
    expect(decideMarkdownLinkClick('javascript:alert(1)')).toEqual({ action: 'local' })
  })
})

describe('installMarkdownLinkGuard', () => {
  let uninstall: (() => void) | undefined
  afterEach(() => {
    uninstall?.()
    uninstall = undefined
    document.body.innerHTML = ''
  })

  function setup(html: string) {
    document.body.innerHTML = html
    const openExternal = vi.fn()
    const notifyLocal = vi.fn()
    uninstall = installMarkdownLinkGuard(document, { openExternal, notifyLocal })
    return { openExternal, notifyLocal }
  }

  function click(el: Element, init: MouseEventInit = {}): MouseEvent {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
    el.dispatchEvent(ev)
    return ev
  }

  it('prevents navigation for a relative link inside rendered markdown and tells the user', () => {
    const { openExternal, notifyLocal } = setup(
      '<div class="term-md__content"><p><a href="src/core/pty-manager.ts:4100">pty</a></p></div>'
    )
    const ev = click(document.querySelector('a')!)
    expect(ev.defaultPrevented).toBe(true)
    expect(notifyLocal).toHaveBeenCalledTimes(1)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('routes an https link through openExternal in every container', () => {
    for (const sel of RENDERED_MARKDOWN_CONTAINERS) {
      const cls = sel.slice(1)
      const { openExternal } = setup(`<div class="${cls}"><a href="https://a.b/x"><code>x</code></a></div>`)
      // Click lands on a CHILD of the anchor — closest() must still find it.
      const ev = click(document.querySelector('code')!)
      expect(ev.defaultPrevented, sel).toBe(true)
      expect(openExternal, sel).toHaveBeenCalledWith('https://a.b/x')
      uninstall?.()
      uninstall = undefined
    }
  })

  it('swallows a fragment link without doing anything', () => {
    const { openExternal, notifyLocal } = setup(
      '<div class="term-chat__text"><a href="#heading">jump</a></div>'
    )
    const ev = click(document.querySelector('a')!)
    expect(ev.defaultPrevented).toBe(true)
    expect(openExternal).not.toHaveBeenCalled()
    expect(notifyLocal).not.toHaveBeenCalled()
  })

  it('handles modifier clicks too (nothing else owns them on rendered markdown)', () => {
    const { openExternal } = setup('<div class="sticky-node__md"><a href="https://a.b/">x</a></div>')
    const ev = click(document.querySelector('a')!, { metaKey: true })
    expect(ev.defaultPrevented).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://a.b/')
  })

  it('leaves anchors outside rendered markdown alone', () => {
    const { openExternal, notifyLocal } = setup('<div class="toolbar"><a href="relative">x</a></div>')
    const ev = click(document.querySelector('a')!)
    expect(ev.defaultPrevented).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
    expect(notifyLocal).not.toHaveBeenCalled()
  })

  it('skips an event someone already handled, and non-primary buttons', () => {
    const { openExternal } = setup('<div class="term-md__content"><a href="https://a.b/">x</a></div>')
    const a = document.querySelector('a')!
    a.addEventListener('click', (e) => e.preventDefault(), { once: true })
    click(a)
    click(a, { button: 1 })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('handles a middle click (auxclick) on a relative link instead of opening a stray tab', () => {
    const { openExternal, notifyLocal } = setup(
      '<div class="term-md__content"><a href="src/a.ts:3">a</a></div>'
    )
    const a = document.querySelector('a')!
    const ev = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    a.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(notifyLocal).toHaveBeenCalledTimes(1)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens a web link on middle click, and leaves a right-button auxclick alone', () => {
    const { openExternal } = setup('<div class="term-chat__text"><a href="https://a.b/">x</a></div>')
    const a = document.querySelector('a')!
    const mid = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    a.dispatchEvent(mid)
    expect(openExternal).toHaveBeenCalledWith('https://a.b/')
    const right = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 })
    a.dispatchEvent(right)
    expect(right.defaultPrevented).toBe(false)
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('uninstalls cleanly', () => {
    const { openExternal } = setup('<div class="term-md__content"><a href="https://a.b/">x</a></div>')
    uninstall!()
    uninstall = undefined
    const ev = click(document.querySelector('a')!)
    expect(ev.defaultPrevented).toBe(false)
    const aux = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    document.querySelector('a')!.dispatchEvent(aux)
    expect(aux.defaultPrevented).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })
})

/** Components whose sink takes its class from the caller — each is pinned by a usage test. */
const DYNAMIC_CLASS_SINKS = new Set([path.join('components', 'NoteMarkdown.tsx')])
/** Non-markdown HTML sinks, each with the reason it needs no link guard. Empty today. */
const NON_MARKDOWN_SINKS: Record<string, string> = {}

/** `file:line` of every dangerouslySetInnerHTML whose OWN element lacks a listed container class. */
function sinkOffenders(files: { name: string; src: string }[]): string[] {
  const listed = RENDERED_MARKDOWN_CONTAINERS.map((sel) => sel.slice(1))
  const out: string[] = []
  for (const { name, src } of files) {
    if (name in NON_MARKDOWN_SINKS) continue
    for (const m of src.matchAll(/dangerouslySetInnerHTML/g)) {
      const at = m.index ?? 0
      const line = src.slice(0, at).split('\n').length
      // The opening tag this attribute belongs to: the last `<Tag` before it.
      const lt = src.slice(0, at).search(/<[A-Za-z][\w.]*[^<]*$/)
      const tag = lt < 0 ? '' : src.slice(lt, at)
      const cls = /className=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/.exec(tag)
      const staticCls = cls?.[1] ?? cls?.[2]
      const ok =
        staticCls !== undefined
          ? staticCls.split(/\s+/).some((c) => listed.includes(c))
          : cls?.[3] !== undefined && DYNAMIC_CLASS_SINKS.has(name)
      if (!ok) out.push(`${name}:${line}`)
    }
  }
  return out
}

describe('RENDERED_MARKDOWN_CONTAINERS contract', () => {
  // The list is a contract with the components that render markdown into these classes. A rename
  // there without a rename here would silently re-open the canvas-wipe bug, so pin that every
  // class is still emitted by some component source file.
  const RENDERER = path.join(__dirname, '..')
  function sources(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) sources(full, out)
      else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) out.push(full)
    }
    return out
  }
  const all = sources(RENDERER).map((f) => fs.readFileSync(f, 'utf8'))

  it('names only class selectors that a component still renders', () => {
    expect(RENDERED_MARKDOWN_CONTAINERS.length).toBeGreaterThan(0)
    for (const sel of RENDERED_MARKDOWN_CONTAINERS) {
      expect(sel.startsWith('.'), sel).toBe(true)
      const cls = sel.slice(1)
      const used = all.some((src) => new RegExp(`className=["'{][^"'}]*\\b${cls}\\b`).test(src))
      expect(used, `${cls} is not rendered by any component`).toBe(true)
    }
  })

  it('puts a listed class on the SAME element as every HTML sink in the renderer', () => {
    // Every `dangerouslySetInnerHTML` in src/renderer today is a markdown sink, so the rule is
    // stated over ALL of them rather than over files that happen to call renderMarkdown: a sink
    // fed through a prop (a new view receiving pre-rendered html) names no renderer and would slip
    // past a file-level heuristic. A future NON-markdown sink joins NON_MARKDOWN_SINKS with a reason.
    const files = sources(RENDERER).map((f) => ({
      name: path.relative(RENDERER, f),
      src: fs.readFileSync(f, 'utf8')
    }))
    expect(files.some((f) => /dangerouslySetInnerHTML/.test(f.src))).toBe(true)
    expect(sinkOffenders(files)).toEqual([])
  })

  it('the sink check catches a second sink under an unlisted class (mutation)', () => {
    const ok = '<div className="term-md__content" dangerouslySetInnerHTML={{ __html: a }} />'
    const bad = '<div\n  className="term-md__other"\n  dangerouslySetInnerHTML={{ __html: b }}\n/>'
    expect(sinkOffenders([{ name: 'X.tsx', src: ok }])).toEqual([])
    expect(sinkOffenders([{ name: 'X.tsx', src: `${ok}\n${bad}` }])).toEqual(['X.tsx:4'])
    // The class must sit on the sink itself, not on a wrapper around it.
    const wrapped =
      '<div className="term-md__content"><p dangerouslySetInnerHTML={{ __html: c }} /></div>'
    expect(sinkOffenders([{ name: 'Y.tsx', src: wrapped }])).toEqual(['Y.tsx:1'])
    // A dynamic class is refused outside the named pass-through component.
    const dyn = '<div className={cls} dangerouslySetInnerHTML={{ __html: d }} />'
    expect(sinkOffenders([{ name: 'components/Z.tsx', src: dyn }])).toEqual(['components/Z.tsx:1'])
  })

  it('every NoteMarkdown usage renders into a listed container', () => {
    const usages = all.flatMap((src) => [...src.matchAll(/<NoteMarkdown\b[^>]*>/g)].map((m) => m[0]))
    expect(usages.length).toBeGreaterThan(0)
    for (const u of usages) {
      const cls = /className="([^"]+)"/.exec(u)?.[1] ?? ''
      expect(
        RENDERED_MARKDOWN_CONTAINERS.some((sel) => cls.split(/\s+/).includes(sel.slice(1))),
        u
      ).toBe(true)
    }
  })
})

describe('openExternalQuietly', () => {
  // The bridge contract types openExternal as `void`, which still admits an implementation that
  // returns a promise — and a rejected one, dropped by a `void` at the call site, surfaces as an
  // unhandled rejection on every failed link click.
  it('attaches a rejection handler to a promise-returning bridge', async () => {
    // Asserted on the promise itself: whether the runner reports an unhandled rejection is its
    // own business (vitest's did not reach a process listener here), so watch the handler land.
    const p = Promise.reject(new Error('E_UNSUPPORTED'))
    const then = vi.spyOn(p, 'then')
    try {
      // A plain function, NOT vi.fn: a vitest mock subscribes to a returned promise itself (to
      // record its settled result), which would hand this test the very handler it looks for.
      const seen: string[] = []
      const open = (url: string) => (seen.push(url), p)
      openExternalQuietly(open, 'https://example.com/')
      expect(seen).toEqual(['https://example.com/'])
      await new Promise((r) => setTimeout(r, 0))
      expect(then.mock.calls.some((c) => typeof c[1] === 'function')).toBe(true)
    } finally {
      p.catch(() => {}) // never leak the rejection out of a RED run
    }
  })

  it('accepts a bridge that returns nothing (desktop) and one that throws synchronously', () => {
    const open = vi.fn(() => undefined)
    expect(() => openExternalQuietly(open, 'https://a.test/')).not.toThrow()
    expect(open).toHaveBeenCalledTimes(1)
    expect(() =>
      openExternalQuietly(() => {
        throw new Error('bridge gone')
      }, 'https://a.test/')
    ).not.toThrow()
  })

  it('is what boot.tsx wires the guard to (no bare `void …openExternal(url)` left)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../boot.tsx'), 'utf8')
    expect(src).toMatch(/openExternal: \(url\) => openExternalQuietly\(\(u\) => window\.nodeTerminal\.shell\.openExternal\(u\), url\)/)
    expect(src).not.toMatch(/void window\.nodeTerminal\.shell\.openExternal/)
  })
})
