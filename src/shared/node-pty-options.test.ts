import { describe, expect, it } from 'vitest'
import { HEADLESS_COLS, HEADLESS_ROWS, localNodePtyOptions } from './node-pty-options'

const project = { id: 'p1', cwd: '/repo' }

describe('localNodePtyOptions', () => {
  it('builds the local spawn a node gets, falling back to the project cwd', () => {
    expect(localNodePtyOptions(project, { id: 'n1' }, { cols: 80, rows: 24 })).toEqual({
      cwd: '/repo',
      cols: 80,
      rows: 24,
      persistKey: 'n1',
      ownerProjectId: 'p1'
    })
  })

  it('carries shell, agent, model and account only when set, and prefers the node cwd', () => {
    expect(
      localNodePtyOptions(
        project,
        { id: 'n2', cwd: '/repo/sub', shell: '/bin/zsh', agentId: 'claude', agentModel: 'm', accountId: 'a1' },
        { cols: HEADLESS_COLS, rows: HEADLESS_ROWS }
      )
    ).toEqual({
      cwd: '/repo/sub',
      cols: 120,
      rows: 36,
      persistKey: 'n2',
      ownerProjectId: 'p1',
      shell: '/bin/zsh',
      agentId: 'claude',
      agentModel: 'm',
      accountId: 'a1'
    })
  })

  // The key set IS the contract with TerminalNode's local create (see the module comment): a key
  // added there and forgotten here makes a headless-started session differ from a mounted one.
  it('never emits keys beyond the local-spawn set', () => {
    const keys = Object.keys(
      localNodePtyOptions(
        project,
        { id: 'n3', cwd: '/x', shell: 's', agentId: 'codex', agentModel: 'm', accountId: 'a' },
        { cols: 1, rows: 1 }
      )
    ).sort()
    expect(keys).toEqual(
      ['accountId', 'agentId', 'agentModel', 'cols', 'cwd', 'ownerProjectId', 'persistKey', 'rows', 'shell'].sort()
    )
  })
})
