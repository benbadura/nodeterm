import { describe, expect, it } from 'vitest'
import { nodeIdsHeldElsewhere, nodeOwner } from './nodeOwner'

// The shape Share with team leaves behind: the closed, handed-off SSH project first (a hosted tab is
// appended), and the team's tab holding the same node ids.
const sshProject = { id: 'ssh-1', closed: true, handedOffTo: { hostId: 'H', projectId: 'p-9', at: 1 }, nodes: [{ id: 'n1' }, { id: 'n2' }] }
const teamTab = { id: 'p-9', nodes: [{ id: 'n1' }, { id: 'n2' }] }

describe('nodeOwner', () => {
  it('prefers the open team tab over the closed, handed-off SSH project listed before it', () => {
    expect(nodeOwner([sshProject, teamTab], 'n1')?.id).toBe('p-9')
  })

  it('an open project wins over a closed one; among open (or closed) ones, the one not handed off wins', () => {
    const openMarked = { id: 'a', handedOffTo: { at: 1 }, nodes: [{ id: 'x' }] }
    const openPlain = { id: 'b', nodes: [{ id: 'x' }] }
    const closedPlain = { id: 'c', closed: true, nodes: [{ id: 'x' }] }
    const closedMarked = { id: 'd', closed: true, handedOffTo: { at: 1 }, nodes: [{ id: 'x' }] }
    expect(nodeOwner([closedMarked, closedPlain, openMarked, openPlain], 'x')?.id).toBe('b')
    expect(nodeOwner([closedMarked, closedPlain, openMarked], 'x')?.id).toBe('a')
    expect(nodeOwner([closedMarked, closedPlain], 'x')?.id).toBe('c')
    expect(nodeOwner([closedMarked], 'x')?.id).toBe('d')
  })

  it('a CLOSED team tab owns nothing: the shared node falls back to the handed-off SSH project, whose reopen asks', () => {
    const closedTab = { ...teamTab, closed: true, remote: true }
    expect(nodeOwner([sshProject, closedTab], 'n1')?.id).toBe('ssh-1')
    expect(nodeOwner([closedTab], 'n1')).toBeUndefined()
    // An open team tab still wins, as before.
    expect(nodeOwner([sshProject, { ...teamTab, remote: true }], 'n1')?.id).toBe('p-9')
  })

  it('ties go to the first in the list; an unknown node has no owner', () => {
    expect(nodeOwner([{ id: 'a', nodes: [{ id: 'x' }] }, { id: 'b', nodes: [{ id: 'x' }] }], 'x')?.id).toBe('a')
    expect(nodeOwner([teamTab], 'nope')).toBeUndefined()
  })
})

describe('nodeIdsHeldElsewhere', () => {
  it('lists the node ids another project still holds', () => {
    const other = { id: 'o', nodes: [{ id: 'z' }] }
    expect([...nodeIdsHeldElsewhere([sshProject, teamTab, other], 'ssh-1')].sort()).toEqual(['n1', 'n2', 'z'])
    expect([...nodeIdsHeldElsewhere([sshProject], 'ssh-1')]).toEqual([])
  })
})
