// Pure decisions behind the ⌘M chat composer's toolbar (ChatPanel): which labels fit, what they
// say, and which of the agent's own pickers a click opens. No React, no store — see ChatPanel.tsx
// for the glue and chatComposer.test.ts for the pins.
import { capabilityAgentId } from '@shared/agents/config'
import { formatModelLabel } from './usageFormat'

/**
 * Below these composer widths a label is dropped — effort first, then the model — so a narrow node
 * keeps the controls that DO something (+ and the mic) instead of wrapping the toolbar. Measured
 * against the toolbar's own row: "+" and the mic are ~28px each, "Fable 5.1" ~70px, "xHigh" ~45px.
 */
export const COMPOSER_MODEL_MIN_WIDTH = 220
export const COMPOSER_EFFORT_MIN_WIDTH = 300

/** Which labels the toolbar has room for. `null` = not measured yet (jsdom, a first paint before
 *  the ResizeObserver reported): show everything rather than flash an empty toolbar. */
export function composerToolbarLayout(width: number | null): { model: boolean; effort: boolean } {
  if (width === null) return { model: true, effort: true }
  return { model: width >= COMPOSER_MODEL_MIN_WIDTH, effort: width >= COMPOSER_EFFORT_MIN_WIDTH }
}

/**
 * The effort levels Claude Code records on each assistant transcript record (`"effort":"…"`), in
 * the CLI's own display spelling. Measured against the installed 2.1.283 bundle: its level list is
 * `["low","medium","high","xhigh","max"]`, and its picker prints xhigh as "xHigh" and the others
 * capitalised. A CLOSED table on purpose: an unknown value is a CLI we have not measured, and a
 * wrong label presented as a fact is worse than none (it also closes the prototype-key hole a
 * bare `value in table` lookup would open).
 */
const EFFORT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'xHigh',
  max: 'Max'
})

export function effortLabel(effort: string | null | undefined): string | null {
  if (!effort || !Object.prototype.hasOwnProperty.call(EFFORT_LABELS, effort)) return null
  return EFFORT_LABELS[effort]
}

export type ComposerPicker = 'model' | 'effort'

/**
 * The slash command that opens the agent's OWN picker in its pane. Typed through `pty.sendText`
 * (paste + Enter), so the session is never restarted — the user picks in the TUI. Measured for
 * claude only (2.1.283: `/model` and `/effort` are both `local-jsx` pickers when given no
 * argument); a custom agent built on claude inherits it through `capabilityAgentId`. Any other
 * agent gets no command, and therefore no label: a label that does nothing on click is a lie.
 */
const PICKER_COMMANDS: Readonly<Record<string, Readonly<Record<ComposerPicker, string>>>> = Object.freeze({
  claude: Object.freeze({ model: '/model', effort: '/effort' })
})

export function composerPickerCommand(agentId: string, picker: ComposerPicker): string | null {
  const base = capabilityAgentId(agentId)
  if (!Object.prototype.hasOwnProperty.call(PICKER_COMMANDS, base)) return null
  return PICKER_COMMANDS[base][picker]
}

/**
 * What the toolbar's right side says. The model label is hidden while the model is unknown (the
 * same `ContextWindowUsage.model` the header ContextMeter shows — no second reader), and effort is
 * hidden with it: an effort with no model beside it reads as the model's name.
 */
export function composerLabels({
  agentId,
  model,
  effort,
  width
}: {
  agentId: string
  model: string | null | undefined
  effort: string | null | undefined
  width: number | null
}): { model: string | null; effort: string | null } {
  const fits = composerToolbarLayout(width)
  const modelText = fits.model && composerPickerCommand(agentId, 'model') ? formatModelLabel(model ?? null) : null
  const effortText =
    modelText && fits.effort && composerPickerCommand(agentId, 'effort') ? effortLabel(effort) : null
  return { model: modelText, effort: effortText }
}

/**
 * Text arriving from outside the keyboard (dictation, attached file paths) is APPENDED to what the
 * user already typed, never replacing it, separated by a single space unless the draft already
 * ends in whitespace. An empty insert changes nothing.
 */
export function appendToComposer(current: string, insert: string): string {
  if (!insert.trim()) return current
  if (!current || /\s$/.test(current)) return current + insert
  return `${current} ${insert}`
}
