// Codex joins the ⌘M chat view (CHAT_CAPABLE) through its OWN reader (core/codex-chat.ts), and the
// pair invariant grok established holds for it too: rendering a codex conversation ourselves says
// nothing about claude's resolver being able to find it.
import { afterEach, describe, expect, it } from 'vitest'
import { canChat, readsClaudeShapedTranscript, setCustomAgentBaseResolver } from './config'

afterEach(() => setCustomAgentBaseResolver(null))

describe('codex chat capability', () => {
  it('is CHAT_CAPABLE and NOT readable by claude\'s resolver', () => {
    expect(canChat('codex')).toBe(true)
    // A codex thread id never resolves under ~/.claude/projects, so claude's cwd fallback would
    // answer with the newest CLAUDE session in the directory — a stranger's conversation.
    expect(readsClaudeShapedTranscript('codex')).toBe(false)
  })

  it('a custom agent on the codex harness inherits the chat view', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:cx' ? 'codex' : undefined))
    expect(canChat('custom:cx')).toBe(true)
    expect(readsClaudeShapedTranscript('custom:cx')).toBe(false)
  })
})
