import { Spinner } from '../components/Spinner'
import { chipFor } from '../lib/keybindingOverrides'

/**
 * The ⌘M panel's "loading" status row — ONE component for both the lazy-chunk fallback below and
 * ChatPanel's own initial "Loading conversation…" row, so the handover from one to the other
 * renders identical DOM. Two rows there (lane-local spinners) swapped one ring for another
 * mid-load, one of them kept rotating under reduced motion, and the role=status region was
 * REMOUNTED — which a screen reader announces a second time. It lives here, in the startup chunk,
 * because the fallback must not import the lazy ChatPanel.
 */
export function ChatLoadingStatus({ text }: { text: string }) {
  return (
    <div className="term-chat__status" role="status" aria-live="polite">
      <Spinner />
      {text}
    </div>
  )
}

/**
 * What the ⌘M face shows while the lazy `ChatPanel` chunk (it carries the markdown renderer) is
 * still loading — the `<Suspense>` fallback at EVERY one of its mount sites: the canvas terminal
 * node, the kanban card modal and the closed-transcript dialog (which passes its own title and
 * "Esc to close" hint, exactly as it does to ChatPanel).
 *
 * It used to be `fallback={null}`, which rendered nothing: the terminal stayed visible under a
 * face that had "opened", then the panel popped in over it — read as a blank or broken ⌘M. This
 * is the panel's own shell instead: the same `.term-chat` container (absolutely positioned over
 * the whole terminal, same z-index, same background — so it covers the terminal exactly where the
 * panel will, with no flash of the xterm underneath), the same bar, and a centred spinner with
 * "Loading conversation…" in the message area.
 *
 * Deliberately free of any transcript logic and of ChatPanel's props: it must stay tiny, because
 * it lives in the STARTUP chunk with the node that imports it — the whole point of the split.
 */
export function ChatPanelFallback({ title, hint }: { title?: string; hint?: string }) {
  // Same bar text ChatPanel renders by default, so the swap is not a visible jump.
  const mdChip = chipFor('node.toggleMarkdown')
  return (
    <div className="term-chat nodrag nowheel">
      <div className="term-chat__bar">
        <span>{title ?? 'Chat'}</span>
        <span className="term-chat__bar-end">
          <span className="term-chat__hint">{hint ?? (mdChip ? `${mdChip} to exit` : 'Exit')}</span>
        </span>
      </div>
      <div className="term-chat__msgs">
        <ChatLoadingStatus text="Loading conversation…" />
      </div>
    </div>
  )
}
