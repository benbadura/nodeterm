import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useSettings } from '../state/settings'
import { useProjectVisuals } from '../state/projectLaunchInfo'
import { mergeProjectVisuals, XTERM_VISUAL_KEYS, type XtermVisualSettings } from './terminal-config'
import { withTerminalFontSize } from './terminal-font-zoom'

/**
 * The appearance slice of Settings for ONE project's terminals, as two subscriptions.
 *
 * Every component that owns an xterm needs the same thirteen fields, and the alternative — one
 * `useSettings((s) => s.settings.x)` per field — was already a wall of near-identical lines that
 * had to be kept in sync across three components AND repeated in each effect's dependency array.
 * Adding an option meant touching six places, which is exactly how a surface gets left behind.
 *
 * `useShallow` is what makes this safe: selecting the settings OBJECT would re-render on every
 * unrelated settings edit (a new object identity each time), and a canvas full of live terminals
 * is the last thing that should re-render because a notification toggle moved. Shallow-comparing
 * the picked keys keeps the old behaviour — re-render only when an appearance value actually
 * changes — while collapsing the effect dependency to a single stable value.
 *
 * `projectId` layers that project's own `terminal.theme` / `terminal.fontFamily` over the global
 * pick (see `mergeProjectVisuals`). Omit it for a terminal that belongs to no project — the
 * settings-panel PREVIEW is the one such surface, and it must keep showing the GLOBAL settings
 * being edited rather than whichever project happens to be active behind the panel.
 *
 * The project half subscribes to `useProjectVisuals`, NOT to the launch-info cache as a whole: that
 * cache also carries launch commands, env and trust verdicts, and a terminal has no business
 * re-rendering when one of those moves. Shallow again, and over the two values only.
 *
 * SPEC DEVIATION, deliberate (Task 5): the spec said a project's appearance applies "when a terminal
 * is created", with existing terminals keeping theirs. There is no per-node appearance in this app
 * (the one exception, since #915, is the node's font size — below) —
 * every terminal renders from the live settings and re-options itself through `applyLiveOptions` —
 * so the honest implementation is live and project-scoped: changing a project's theme repaints that
 * project's terminals, including ones already open, and leaves every other project's alone.
 *
 * `fontSizeOverride` is the NODE's own font size (issue #915, `data.terminalFontSize`), layered
 * last — over the global size and whatever the project set — through `withTerminalFontSize`. It is
 * a parameter HERE rather than a second merge at each call site so the canvas node and the card
 * modal (a second view of the same session) cannot apply it differently; the settings preview
 * passes none. Typed `unknown` because it comes straight off node data: the helper validates it.
 */
export function useXtermVisualSettings(
  projectId?: string,
  fontSizeOverride?: unknown
): XtermVisualSettings {
  const base = useSettings(
    useShallow((s) => {
      const out = {} as Record<string, unknown>
      for (const k of XTERM_VISUAL_KEYS) out[k] = s.settings[k]
      return out as unknown as XtermVisualSettings
    })
  )
  const overrides = useProjectVisuals(
    useShallow((s) => {
      const v = projectId ? s.byProject[projectId] : undefined
      // Normalised (never the stored object, never `undefined`) so the shallow comparison has a
      // stable shape to compare in every case — including a project whose entry is dropped.
      return { theme: v?.theme, fontFamily: v?.fontFamily }
    })
  )
  // Identity-stable while neither half changed: this value is the dependency the terminal
  // components' live re-option effects hang off.
  const merged = useMemo(() => mergeProjectVisuals(base, overrides), [base, overrides])
  // Identity-preserving too (`withTerminalFontSize` returns `merged` itself when there is no
  // effective override), so nodes without one re-option exactly as before.
  return useMemo(() => withTerminalFontSize(merged, fontSizeOverride), [merged, fontSizeOverride])
}
