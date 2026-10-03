import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * SOURCE-LEVEL pins for which SSH-project list each desktop consumer reads. `sshProjectIds()` is
 * the IDENTITY list ("this project is someone else's machine", connected or not), and
 * `pollableSshProjectIds()` leaves out a project handed to a hosted team, whose file and sessions
 * the server core on its host now owns. Both are `string[]`, so swapping one for the other compiles
 * and passes every behavioral test of the consumer: a handed-off project would silently be polled
 * again, or be scoped as this machine. The store's own behavior is pinned in
 * `core/workspace-store.test.ts`.
 */
const main = readFileSync(new URL('./index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

describe('desktop main: identity list vs pollable list', () => {
  it('the 15 s connected-project poll skips a handed-off project', () => {
    expect(main).toMatch(/planRemoteWorkspacePoll\(\{\s*sshProjectIds: workspaceStore\.pollableSshProjectIds\(\),/)
  })

  it('the agent-status push to SSH hosts skips a handed-off project', () => {
    const push = main.slice(main.indexOf('initRemoteStatusPush({'))
    expect(push.slice(0, 300)).toContain('sshProjectIds: () => workspaceStore.pollableSshProjectIds(),')
  })

  it('the session-memory and dev-ports scope checks keep the identity list', () => {
    const scopes = main.match(/sshScopePredicate\(\{\s*sshProjectIds: \(\) => workspaceStore\.\w+\(\)/g) ?? []
    expect(scopes).toHaveLength(2)
    for (const s of scopes) expect(s).toMatch(/workspaceStore\.sshProjectIds\(\)$/)
  })
})
