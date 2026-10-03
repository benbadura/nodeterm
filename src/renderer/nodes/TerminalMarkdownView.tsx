import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconReload } from '../components/icons'
import { Tooltip } from '../components/Tooltip'
import { Spinner } from '../components/Spinner'

/**
 * The ⌘M "output" face of a terminal: its captured scrollback rendered as readable markdown.
 *
 * Deliberately free of React Flow and of any node state — it is handed a node id and a `capture`
 * function, so the kanban card modal can mount the same view over the same session (the canvas
 * node passes its session-bound `api.pty.capture`). The `.term-md__content` class is load-bearing
 * beyond styling: the document-level link-click handler keys on it.
 *
 * Lifecycle rules this component owns (each was a bug in the inline one-shot version):
 * - It captures on MOUNT, so re-entering ⌘M never shows the previous entry's stale HTML, and it
 *   shows "Capturing…" until the answer lands; ↻ re-captures in place.
 * - Every capture carries a request token: an older answer that resolves after a newer one (a
 *   refresh during a slow SSH capture) is dropped, and nothing is set after unmount.
 * - '' is its own answer ("Nothing captured…"), and a REJECTED capture is not '' — a failure
 *   rendered as an empty page would read as "this terminal printed nothing".
 * - Only the last `MD_OUTPUT_MAX_LINES` lines are rendered (announced when cut), and each fresh
 *   render scrolls to the bottom — the newest output is what the view is opened for.
 * `marked` + DOMPurify stay a lazy import: the canvas node is on the startup path, this renderer
 * runs only after someone presses ⌘M.
 */
export interface TerminalMarkdownViewProps {
  /** The terminal's persist key (node id) — what `capture` is asked for. */
  nodeId: string
  /** Full-scrollback capture of that session (`(id) => api.pty.capture(id, true)` on the canvas). */
  capture: (nodeId: string) => Promise<string>
  /** Right-hand bar text, e.g. "⌘M to exit" (the caller knows its own exit chord). */
  hint: string
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  /** `capture` = the capture (or the renderer chunk) never arrived; `render` = the text arrived and
   *  the renderer threw on it. Different facts, different sentences: telling a user their terminal
   *  could not be captured when it was captured fine sends them after the wrong problem. */
  | { kind: 'error'; stage: 'capture' | 'render' }
  | { kind: 'ready'; html: string; kept: number; dropped: number }

export function TerminalMarkdownView({ nodeId, capture, hint }: TerminalMarkdownViewProps) {
  const [view, setView] = useState<ViewState>({ kind: 'loading' })
  const [capturing, setCapturing] = useState(true)
  const contentRef = useRef<HTMLDivElement | null>(null)
  // Monotonic request token; bumped on unmount too, so a late answer matches nothing.
  const reqRef = useRef(0)
  // The latest `capture` without making it an effect dependency: a caller passing an inline
  // arrow must not re-capture on every render.
  const captureRef = useRef(capture)
  captureRef.current = capture

  const run = useCallback(() => {
    const token = ++reqRef.current
    setCapturing(true)
    // `.then(ok).catch(fail)`, not `.then(ok, fail)`: nothing thrown in the fulfilment path may
    // escape as an unhandled rejection and leave `capturing` true, ↻ disabled for good. A renderer
    // throw is caught inside (→ 'render'); the catch is the capture/import leg (→ 'capture').
    void Promise.all([captureRef.current(nodeId), import('../lib/terminalOutputMarkdown')])
      .then(([text, md]) => {
        if (token !== reqRef.current) return
        let next: ViewState
        try {
          const tail = md.tailOutputLines(text)
          next = tail.text
            ? {
                kind: 'ready',
                html: md.renderTerminalOutput(tail.text),
                // Read off the lazy module, not imported statically — a static import of the
                // constant would drag marked into the startup chunk with it.
                kept: md.MD_OUTPUT_MAX_LINES,
                dropped: tail.dropped
              }
            : { kind: 'empty' }
        } catch {
          next = { kind: 'error', stage: 'render' }
        }
        setView(next)
        setCapturing(false)
      })
      .catch(() => {
        if (token !== reqRef.current) return
        setView({ kind: 'error', stage: 'capture' })
        setCapturing(false)
      })
  }, [nodeId])

  useEffect(() => {
    run()
    return () => {
      reqRef.current++
    }
  }, [run])

  // After each fresh render, jump to the latest output. Keyed on the view object itself, so a
  // refresh that produced identical HTML still re-anchors to the bottom.
  useLayoutEffect(() => {
    const el = contentRef.current
    if (el && view.kind === 'ready') el.scrollTop = el.scrollHeight
  }, [view])

  return (
    <div className="term-md nodrag nowheel">
      <div className="term-md__bar">
        <span className="term-md__title">
          Markdown
          {capturing && view.kind !== 'loading' && (
            // A refresh keeps the old output on screen, so this bar line is the only sign one is
            // running — hence the spinner. The status role sits on the text; the spinner is mute.
            <span className="term-md__status" role="status" aria-live="polite">
              {' · '}
              <Spinner /> Capturing…
            </span>
          )}
          {view.kind === 'ready' && view.dropped > 0 && (
            <span className="term-md__status">
              {' '}
              · Last {view.kept.toLocaleString('en-US')} lines ({view.dropped.toLocaleString('en-US')} older not
              shown)
            </span>
          )}
        </span>
        <span className="term-md__actions">
          <Tooltip label="Refresh — capture the terminal again">
            <button
              type="button"
              className="term-md__refresh"
              aria-label="Refresh"
              disabled={capturing}
              onClick={run}
            >
              <IconReload />
            </button>
          </Tooltip>
          <span className="term-md__hint">{hint}</span>
        </span>
      </div>
      {view.kind === 'ready' ? (
        <div ref={contentRef} className="term-md__content" dangerouslySetInnerHTML={{ __html: view.html }} />
      ) : (
        <div className="term-md__content term-md__content--placeholder">
          {view.kind === 'loading' ? (
            <span className="term-md__capturing" role="status" aria-live="polite">
              <Spinner />
              Capturing…
            </span>
          ) : view.kind === 'empty' ? (
            'Nothing captured from this terminal.'
          ) : view.stage === 'render' ? (
            'Could not render this terminal’s output.'
          ) : (
            'Could not capture this terminal’s output.'
          )}
        </div>
      )}
    </div>
  )
}
