import { describe, expect, it } from 'vitest'
import {
  COMPOSER_EFFORT_MIN_WIDTH,
  COMPOSER_MODEL_MIN_WIDTH,
  appendToComposer,
  composerLabels,
  composerPickerCommand,
  composerToolbarLayout,
  effortLabel
} from './chatComposer'

describe('composerToolbarLayout', () => {
  it('shows both labels when the width is unknown (no layout box measured yet)', () => {
    expect(composerToolbarLayout(null)).toEqual({ model: true, effort: true })
  })

  it('drops the effort label first, then the model label, as the composer narrows', () => {
    expect(composerToolbarLayout(COMPOSER_EFFORT_MIN_WIDTH)).toEqual({ model: true, effort: true })
    expect(composerToolbarLayout(COMPOSER_EFFORT_MIN_WIDTH - 1)).toEqual({ model: true, effort: false })
    expect(composerToolbarLayout(COMPOSER_MODEL_MIN_WIDTH)).toEqual({ model: true, effort: false })
    expect(composerToolbarLayout(COMPOSER_MODEL_MIN_WIDTH - 1)).toEqual({ model: false, effort: false })
  })

  it('never shows effort without room for the model (effort threshold is the higher one)', () => {
    expect(COMPOSER_EFFORT_MIN_WIDTH).toBeGreaterThan(COMPOSER_MODEL_MIN_WIDTH)
  })
})

describe('effortLabel', () => {
  it('labels the levels Claude Code 2.1.283 records, in its own spelling', () => {
    expect(effortLabel('low')).toBe('Low')
    expect(effortLabel('medium')).toBe('Medium')
    expect(effortLabel('high')).toBe('High')
    expect(effortLabel('xhigh')).toBe('xHigh')
    expect(effortLabel('max')).toBe('Max')
  })

  it('says nothing for an absent or unrecognised value — a guess must degrade to nothing', () => {
    expect(effortLabel(undefined)).toBeNull()
    expect(effortLabel(null)).toBeNull()
    expect(effortLabel('')).toBeNull()
    expect(effortLabel('turbo')).toBeNull()
    expect(effortLabel('constructor')).toBeNull()
  })
})

describe('composerPickerCommand', () => {
  it("opens claude's own pickers", () => {
    expect(composerPickerCommand('claude', 'model')).toBe('/model')
    expect(composerPickerCommand('claude', 'effort')).toBe('/effort')
  })

  it('has no command for an agent whose picker was never measured (grok)', () => {
    expect(composerPickerCommand('grok', 'model')).toBeNull()
    expect(composerPickerCommand('grok', 'effort')).toBeNull()
  })
})

describe('composerLabels', () => {
  it('shows the model and effort of a claude session', () => {
    expect(composerLabels({ agentId: 'claude', model: 'claude-fable-5-1', effort: 'medium', width: 600 })).toEqual({
      model: 'Fable 5.1',
      effort: 'Medium'
    })
  })

  it('hides the model label when the model is unknown, and effort with it', () => {
    expect(composerLabels({ agentId: 'claude', model: null, effort: 'high', width: 600 })).toEqual({
      model: null,
      effort: null
    })
  })

  it('hides labels the width has no room for', () => {
    expect(composerLabels({ agentId: 'claude', model: 'claude-opus-5', effort: 'high', width: COMPOSER_MODEL_MIN_WIDTH })).toEqual({
      model: 'Opus 5',
      effort: null
    })
    expect(composerLabels({ agentId: 'claude', model: 'claude-opus-5', effort: 'high', width: 10 })).toEqual({
      model: null,
      effort: null
    })
  })

  it('shows no label for an agent with no picker to open (a label that does nothing on click)', () => {
    expect(composerLabels({ agentId: 'grok', model: 'grok-4.6', effort: undefined, width: 600 })).toEqual({
      model: null,
      effort: null
    })
  })
})

describe('appendToComposer', () => {
  it('inserts into an empty composer as-is', () => {
    expect(appendToComposer('', 'hello')).toBe('hello')
  })

  it('separates from existing text with one space', () => {
    expect(appendToComposer('look at', '/tmp/a.png ')).toBe('look at /tmp/a.png ')
  })

  it('does not double a separator the text already ends with', () => {
    expect(appendToComposer('look at ', 'x')).toBe('look at x')
    expect(appendToComposer('line\n', 'x')).toBe('line\nx')
  })

  it('ignores an empty insert', () => {
    expect(appendToComposer('keep', '')).toBe('keep')
    expect(appendToComposer('keep', '   ')).toBe('keep')
  })
})
