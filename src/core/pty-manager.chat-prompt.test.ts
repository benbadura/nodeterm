// `PtyManager.sendChatPrompt` — the ⌘M chat view's send. For an agent whose screen we can read
// (claude), the pane's screen is checked BEFORE anything is written: Claude Code's own dialogs fire
// no hook, and a paste into one swallowed the text while its Enter answered the dialog. The screen
// reader itself is tested in shared/agents/claude-screen.test.ts; this file pins the dispatch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

vi.mock('node-pty', () => ({ spawn: () => ({}) }))

const NODE = 'node-1'
const RULE = '─'.repeat(80)
const IDLE = [RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n')
const TRUST = [RULE, ' Accessing workspace:', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'].join('\n')

async function manager(screen: string) {
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager()
  const captureSession = vi.spyOn(mgr, 'captureSession').mockResolvedValue(screen)
  const sendText = vi.spyOn(mgr, 'sendText').mockResolvedValue(true)
  return { mgr, captureSession, sendText }
}

describe('PtyManager.sendChatPrompt', () => {
  beforeEach(() => {
    vi.resetModules()
    initPlatform(fakePlatform())
  })
  afterEach(() => {
    resetPlatformForTests()
  })

  it('sends a claude prompt when its input box is on screen', async () => {
    const { mgr, sendText } = await manager(IDLE)

    const result = await mgr.sendChatPrompt(NODE, 'hello', 'claude')

    expect(result).toBe(true)
    expect(sendText).toHaveBeenCalledWith(NODE, 'hello')
  })

  it('refuses before writing anything when a claude dialog owns the screen, and returns its text', async () => {
    const { mgr, sendText } = await manager(TRUST)

    const result = await mgr.sendChatPrompt(NODE, 'hello', 'claude')

    expect(sendText).not.toHaveBeenCalled()
    expect(result).toEqual({ blocked: 'screen', dialog: expect.stringContaining('No, exit') })
  })

  it('refuses with no dialog text when the input box is gone (a shell owns the pane)', async () => {
    const { mgr, sendText } = await manager('user@host ~ % ')

    const result = await mgr.sendChatPrompt(NODE, 'hello', 'claude')

    expect(sendText).not.toHaveBeenCalled()
    expect(result).toEqual({ blocked: 'screen', dialog: null })
  })

  it('an empty capture is not evidence of a dialog: the prompt is sent as before', async () => {
    const { mgr, sendText } = await manager('')

    const result = await mgr.sendChatPrompt(NODE, 'hello', 'claude')

    expect(result).toBe(true)
    expect(sendText).toHaveBeenCalledWith(NODE, 'hello')
  })

  it('never reads the screen of an agent without a measured reader', async () => {
    const { mgr, captureSession, sendText } = await manager(TRUST)

    const result = await mgr.sendChatPrompt(NODE, 'hello', 'codex')

    expect(captureSession).not.toHaveBeenCalled()
    expect(result).toBe(true)
    expect(sendText).toHaveBeenCalledWith(NODE, 'hello')
  })
})
