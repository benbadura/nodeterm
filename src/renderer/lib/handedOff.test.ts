import { describe, it, expect } from 'vitest'
import { handedOffWarning } from './handedOff'

const P = { name: 'proj', ssh: { server: { host: 'box', user: 'alice' }, remoteCwd: '~/proj' } } as never
describe('handedOffWarning', () => {
  it('null for a project that was never handed off', () => expect(handedOffWarning(P, null)).toBeNull())
  it('names the team, the host and the unshare command', () => {
    const w = handedOffWarning({ ...(P as object), handedOffTo: { hostId: 'H', projectId: 'project-9', at: 1 } } as never, 'Box team')
    expect(w).toBe(
      'proj is now managed by team Box team on box. Open it from the team tab, or run "team unshare project-9" on the server first.\n\n' +
        'Open it here anyway? Two copies editing one canvas can overwrite each other, and its agents would start the same conversations the server is running. Its agents are not resumed here automatically.'
    )
  })
  it('an unfinished handover says so', () => {
    expect(handedOffWarning({ ...(P as object), handedOffTo: { at: 1 } } as never, null)).toMatch(/^Sharing proj with a team did not finish\./)
  })
  it('the unfinished copy is the whole sentence pair, and ignores any team label', () => {
    expect(handedOffWarning({ ...(P as object), handedOffTo: { at: 1 } } as never, 'Box team')).toBe(
      'Sharing proj with a team did not finish. If the server already took it over, opening it here gives one canvas two editors that can overwrite each other, and its agents would start the same conversations the server is running.\n\n' +
        'Open it here anyway? Its agents are not resumed here automatically.'
    )
  })
  it('an unknown or blank team label falls back to the generic name', () => {
    const p = { ...(P as object), handedOffTo: { hostId: 'H', projectId: 'project-9', at: 1 } } as never
    expect(handedOffWarning(p, null)).toMatch(/^proj is now managed by team the hosted team on box\./)
    expect(handedOffWarning(p, '  ')).toMatch(/^proj is now managed by team the hosted team on box\./)
  })
  it('a finished handover with no server project id still names the command, with its placeholder', () => {
    const w = handedOffWarning({ ...(P as object), handedOffTo: { hostId: 'H', at: 1 } } as never, 'Box team')
    expect(w).toContain('run "team unshare <projectId>" on the server first.')
  })
})
