import { describe, expect, it } from 'vitest'
import { cardFileLinkRoute } from './cardFileLinks'

const host = { host: 'box', user: 'me' } as never
const other = { host: 'elsewhere', user: 'me' } as never

describe('cardFileLinkRoute', () => {
  it('routes a local card to the local filesystem', () => {
    expect(cardFileLinkRoute({ project: { id: 'p1' }, source: 'local', spawn: {} })).toEqual({
      ssh: false,
      sshProject: false,
      standaloneSsh: false
    })
  })

  it("routes an SSH card through the CARD's project, whatever project is active", () => {
    // The Omni board opens this card while a LOCAL project is active: the route is decided by the
    // card's own project, so the path is checked on the host it was printed on.
    const r = cardFileLinkRoute({
      project: { id: 'ssh1', ssh: { server: host } },
      source: 'local',
      spawn: { ssh: host, sshRemoteTmux: true }
    })
    expect(r).toEqual({ ssh: true, sshProject: true, standaloneSsh: false })
  })

  it('refuses an unknown project, and a relay/server core', () => {
    expect(cardFileLinkRoute({ project: undefined, source: 'local', spawn: {} })).toBeNull()
    expect(cardFileLinkRoute({ project: { id: 'p' }, source: 'relay', spawn: {} })).toBeNull()
    expect(cardFileLinkRoute({ project: { id: 'p' }, source: 'server', spawn: {} })).toBeNull()
    expect(cardFileLinkRoute({ project: { id: 'p' }, source: null, spawn: {} })).toBeNull()
  })

  it('refuses a remote session its project has no filesystem for', () => {
    // A plain `ssh` node in a local project: its output names paths on another machine.
    expect(cardFileLinkRoute({ project: { id: 'p' }, source: 'local', spawn: { ssh: host } })).toBeNull()
    // A host attachment: the SSH project's fs is ITS host, not the one this session runs on.
    expect(
      cardFileLinkRoute({
        project: { id: 'ssh1', ssh: { server: host } },
        source: 'local',
        spawn: { ssh: other, sshRemoteTmux: true }
      })
    ).toBeNull()
    expect(
      cardFileLinkRoute({
        project: { id: 'ssh1', ssh: { server: host } },
        source: 'local',
        spawn: { sshRemoteTmux: true }
      })
    ).toBeNull()
  })
})
