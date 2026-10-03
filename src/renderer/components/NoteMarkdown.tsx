import { useEffect, useState } from 'react'

/**
 * Rendered-markdown view of a sticky note body, shared by the canvas StickyNode and the kanban
 * card modal. The markdown lib (marked + DOMPurify) is lazy-loaded the way TerminalNode's Cmd+M
 * overlay does it, so notes keep it out of the boot bundle. Rendered with `breaks`: sticky text
 * predates markdown, and a plain list of lines must not collapse into one paragraph.
 *
 * Anchor clicks are handled by the delegated rendered-markdown link guard
 * (lib/markdownLinks.ts) — `sticky-node__md`, the class every caller passes, is in its container
 * list. Never navigate the app window from here.
 */
export function NoteMarkdown({ text, className }: { text: string; className?: string }) {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    import('../lib/markdown')
      .then((md) => {
        if (alive) setHtml(md.renderMarkdown(text, { breaks: true }))
      })
      // A failed chunk load (offline dev server, torn update) keeps the raw-text fallback below —
      // an unhandled rejection here would surface as a global error for a cosmetic miss.
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [text])
  // Until the chunk lands, show the raw text (it IS most of the markdown) instead of a blank.
  if (html === null) {
    return <div className={className} style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
  }
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
}
