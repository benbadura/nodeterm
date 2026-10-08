import { describe, it, expect } from 'vitest'
import { planRelayAttach, type RelayNodePlacement, type RelayRemoteRef } from './relay-attach-plan'

/**
 * The routing matrix of a phone's relay `pty.attach` — where the session runs and with what — from
 * this machine's records alone. The bug it pins: an SSH project's node, attached from the phone
 * before the desktop mounted it, came up as a LOCAL `nt-<id>` (a shell in this machine's `$HOME`
 * wearing a remote node's identity), and a local node got none of its agent/account/cwd env.
 */

const SERVER = { host: 'box.test', user: 'deploy' }
const MASTER: RelayRemoteRef = {
  conn: SERVER,
  controlPath: '/tmp/cm-p1',
  hookEndpointPath: '/home/deploy/.nodeterm/hook-endpoint-p1.env',
  tmuxConfPath: '/home/deploy/.nodeterm/tmux.conf',
  remoteHome: '/home/deploy',
  setupDone: true
}

const sshNode = (over: Partial<RelayNodePlacement['node']> = {}): RelayNodePlacement => ({
  projectId: 'p-ssh',
  projectServer: SERVER,
  node: {
    kind: 'terminal',
    cwd: '/srv/app',
    agentId: 'claude',
    accountId: 'acct-1',
    ssh: SERVER,
    sshRemoteTmux: true,
    ...over
  }
})
const localNode = (over: Partial<RelayNodePlacement['node']> = {}): RelayNodePlacement => ({
  projectId: 'p-local',
  node: { kind: 'terminal', cwd: '/home/me/app', agentId: 'codex', agentModel: 'gpt-x', ...over }
})

const base = { refFor: () => undefined, sshAvailable: true }

describe('planRelayAttach', () => {
  it('an SSH-project node with no live master is REFUSED, never spawned locally', () => {
    const plan = planRelayAttach({ ...base, placements: [sshNode()] })
    expect(plan.kind).toBe('refuse')
    if (plan.kind !== 'refuse') return
    expect(plan.reason).toBe('not-connected')
    expect(plan.message).toContain('deploy@box.test')
    expect(plan.message).toContain('Nothing was started here')
  })

  it('…and with no ssh executable it is refused for that reason', () => {
    const plan = planRelayAttach({
      ...base,
      sshAvailable: false,
      refFor: () => MASTER,
      placements: [sshNode()]
    })
    expect(plan).toMatchObject({ kind: 'refuse', reason: 'no-ssh' })
  })

  it('with a master it runs over that master, requireRemote, with the node’s own profile', () => {
    const plan = planRelayAttach({
      ...base,
      refFor: (scope) => (scope === 'p-ssh' ? MASTER : undefined),
      placements: [sshNode()]
    })
    expect(plan.kind).toBe('remote')
    if (plan.kind !== 'remote') return
    expect(plan.options).toMatchObject({
      cwd: '/srv/app',
      agentId: 'claude',
      accountId: 'acct-1',
      ownerProjectId: 'p-ssh',
      requireRemote: true,
      sshRemote: {
        controlPath: '/tmp/cm-p1',
        conn: SERVER,
        remoteCwd: '/srv/app',
        hookEndpointPath: MASTER.hookEndpointPath,
        tmuxConfPath: MASTER.tmuxConfPath,
        remoteHome: '/home/deploy'
      }
    })
    expect(plan.setupDone).toBe(true)
  })

  it('a node in an SSH project with no flags is still remote (routing it local is the bug)', () => {
    const plan = planRelayAttach({
      ...base,
      placements: [{ projectId: 'p-ssh', projectServer: SERVER, node: { kind: 'terminal' } }]
    })
    expect(plan).toMatchObject({ kind: 'refuse', reason: 'not-connected' })
  })

  it('a host attachment in a LOCAL project runs over the attachment scope, not the project', () => {
    const other = { host: 'other.test', user: 'ops' }
    const scopes: string[] = []
    planRelayAttach({
      ...base,
      refFor: (scope) => {
        scopes.push(scope)
        return undefined
      },
      placements: [
        { projectId: 'p-local', node: { kind: 'terminal', ssh: other, sshRemoteTmux: true } }
      ]
    })
    expect(scopes).toHaveLength(1)
    expect(scopes[0]).not.toBe('p-local')
  })

  it('a live remote handle held by this process wins over the index', () => {
    const live: RelayRemoteRef = { conn: SERVER, controlPath: '/tmp/cm-live' }
    const plan = planRelayAttach({ ...base, liveRemote: live, placements: [sshNode()] })
    expect(plan.kind === 'remote' && plan.options.sshRemote?.controlPath).toBe('/tmp/cm-live')
  })

  it('a local node gets the profile the desktop would give it (agent, model, cwd, owner)', () => {
    const plan = planRelayAttach({ ...base, placements: [localNode()] })
    expect(plan).toEqual({
      kind: 'local',
      projectId: 'p-local',
      options: {
        cwd: '/home/me/app',
        agentId: 'codex',
        agentModel: 'gpt-x',
        ownerProjectId: 'p-local'
      }
    })
  })

  it('a plain ssh terminal node runs `ssh` locally, as the renderer does', () => {
    const plan = planRelayAttach({
      ...base,
      placements: [{ projectId: 'p-local', node: { kind: 'terminal', ssh: SERVER } }]
    })
    expect(plan.kind).toBe('local')
    if (plan.kind !== 'local') return
    expect(plan.options.shell).toBe('ssh')
    expect(plan.options.shellArgs?.join(' ')).toContain('box.test')
  })

  it('an unknown node keeps the bare local attach (a phone-started local session)', () => {
    expect(planRelayAttach({ ...base, placements: [] })).toEqual({ kind: 'local', options: {} })
  })

  it('an unknown node the phone says belongs to an SSH project is refused, not guessed', () => {
    const plan = planRelayAttach({
      ...base,
      placements: [],
      projectHint: 'p-ssh',
      hintIsRemoteProject: true
    })
    expect(plan).toMatchObject({ kind: 'refuse', reason: 'unregistered-remote' })
  })

  it('a hint naming a project that does not hold the node cannot route it anywhere', () => {
    const plan = planRelayAttach({
      ...base,
      placements: [sshNode()],
      projectHint: 'p-local-elsewhere'
    })
    expect(plan).toMatchObject({ kind: 'refuse', reason: 'not-connected' })
  })

  describe('one id in a local AND an SSH project (the same canvas in two folders)', () => {
    const both = [sshNode(), localNode()]
    it('a hint picks among the real placements', () => {
      expect(planRelayAttach({ ...base, placements: both, projectHint: 'p-local' }).kind).toBe(
        'local'
      )
      expect(
        planRelayAttach({ ...base, placements: both, projectHint: 'p-ssh', refFor: () => MASTER })
          .kind
      ).toBe('remote')
    })
    it('without one, a live LOCAL session wins; otherwise the remote one', () => {
      expect(
        planRelayAttach({ ...base, placements: both, localSessionExists: true }).kind
      ).toBe('local')
      expect(
        planRelayAttach({ ...base, placements: both, localSessionExists: false, refFor: () => MASTER })
          .kind
      ).toBe('remote')
    })
  })

  it('a master whose setup is unfinished is reported as such (the caller only joins then)', () => {
    const plan = planRelayAttach({
      ...base,
      refFor: () => ({ ...MASTER, setupDone: false }),
      placements: [sshNode()]
    })
    expect(plan.kind === 'remote' && plan.setupDone).toBe(false)
  })
})
