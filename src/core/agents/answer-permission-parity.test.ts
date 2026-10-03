// Both shells must answer a held permission request through the ONE core body
// (`answerHeldPermission`), passing the structured `answer` through. A handler that kept reading only
// `decision` would compile, pass every other test, and silently drop plan/question answers on that
// shell — the one-shell drift this repo has shipped before (see hook-verified-parity.test.ts).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../../..')
const handler = (file: string): string => {
  const src = readFileSync(resolve(root, file), 'utf8')
  const at = src.indexOf('IPC.agentAnswerPermission')
  expect(at, `${file} registers the handler`).toBeGreaterThan(-1)
  return src.slice(at, at + 2500)
}

describe('answerPermission handler parity', () => {
  for (const file of ['src/main/index.ts', 'src/server/index.ts']) {
    it(`${file} routes through answerHeldPermission with the structured answer`, () => {
      const body = handler(file)
      expect(body).toContain('answerHeldPermission(')
      expect(body).toContain('answer: payload.answer')
      expect(body).toContain('decision: payload.decision')
      // The optimistic flip reports the verb core decided, not the renderer's legacy field.
      expect(body).toContain('syntheticAnsweredEvent(nodeId, pendingId, res.decision)')
    })
  }
  it('the desktop reads the held request over SSH for a remote node', () => {
    // The I/O choice lives in `heldPermissionIoFor`, shared by this handler and the phone's
    // `agent.answer` (main/remote/host-chat.ts), so both answer paths reach the same host.
    expect(handler('src/main/index.ts')).toContain('heldPermissionIoFor(nodeId, pendingId)')
    const src = readFileSync(resolve(root, 'src/main/index.ts'), 'utf8')
    const at = src.indexOf('const heldPermissionIoFor =')
    expect(at).toBeGreaterThan(-1)
    expect(src.slice(at, at + 800)).toContain('readPendingRequest(sshProjectId, pendingId)')
    // …and the phone path uses the same function, not a second copy.
    expect(src).toContain('answerIo: heldPermissionIoFor')
  })
})
