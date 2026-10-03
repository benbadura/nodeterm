import { describe, expect, it } from 'vitest'
import { cleanEcho } from '@shared/command-delivery'
import {
  GEMINI_RETIRED_PHRASE,
  GEMINI_RETIRED_TAIL_CHARS,
  geminiRetiredIn,
  watchesGeminiRetirement
} from './gemini-retired'

// The refusal as a 2026-09 Gemini CLI draws it: inside a bordered box, wrapped at the pane width,
// each row repainted with cursor/colour escapes. Transcribed from a user's screenshot; the escape
// sequences are the kind Ink emits (erase line, SGR colour, cursor up).
const BOXED = [
  '\x1b[2K\x1b[1G\x1b[38;2;255;135;175m│  Failed to sign in. Message: This client is no longer supported for Gemini   │',
  '\x1b[2K\x1b[1G│  Code Assist for individuals. To continue using Gemini, please migrate to the  │',
  '\x1b[2K\x1b[1G│  Antigravity suite of products: https://antigravity.google\x1b[39m                 │',
  '\x1b[1A'
].join('\r\n')

describe('geminiRetiredIn', () => {
  it('matches the refusal even when the TUI wraps it inside a bordered box', () => {
    expect(geminiRetiredIn(cleanEcho(BOXED))).toBe(true)
  })

  it('matches the bare sentence', () => {
    expect(geminiRetiredIn(`Message: This client is ${GEMINI_RETIRED_PHRASE}.`)).toBe(true)
  })

  it('does not match an ordinary sign-in screen', () => {
    const signIn = cleanEcho(
      '│ ? Get started │\r\n│ How would you like to authenticate for this project? │\r\n│ ● 1. Sign in with Google │'
    )
    expect(geminiRetiredIn(signIn)).toBe(false)
  })

  it('does not match a different sign-in failure', () => {
    expect(geminiRetiredIn('Failed to sign in. Message: Request had invalid authentication credentials.')).toBe(false)
  })

  it('does not match half the phrase (a chunk boundary is the watcher’s job, not a match)', () => {
    expect(geminiRetiredIn('This client is no longer supported for Gemini')).toBe(false)
  })

  it('still finds the refusal at the end of a full rolling buffer', () => {
    const noise = 'x'.repeat(GEMINI_RETIRED_TAIL_CHARS)
    const tail = (noise + cleanEcho(BOXED)).slice(-GEMINI_RETIRED_TAIL_CHARS)
    expect(geminiRetiredIn(tail)).toBe(true)
  })
})

describe('watchesGeminiRetirement', () => {
  it('watches the gemini harness only', () => {
    expect(watchesGeminiRetirement('gemini')).toBe(true)
    for (const other of ['claude', 'codex', 'grok', 'copilot', 'opencode', 'antigravity', undefined]) {
      expect(watchesGeminiRetirement(other)).toBe(false)
    }
  })
})
