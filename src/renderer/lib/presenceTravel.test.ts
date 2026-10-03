import { describe, expect, it } from 'vitest'
import { nodeTravel, projectTravel, type TravelProject } from './presenceTravel'

const projects: TravelProject[] = [
  { id: 'open', nodes: [{ id: 'n-open' }] },
  { id: 'active', nodes: [{ id: 'n-active' }] },
  { id: 'closed', closed: true, nodes: [{ id: 'n-closed' }] },
  { id: 'gone', closed: true, unavailable: true, nodes: [{ id: 'n-gone' }] }
]

describe('projectTravel', () => {
  it('does nothing for the project we are already on', () => {
    expect(projectTravel(projects, 'active', 'active')).toEqual({ kind: 'none' })
  })

  it('switches to another open project', () => {
    expect(projectTravel(projects, 'active', 'open')).toEqual({ kind: 'switch', projectId: 'open' })
  })

  it('reopens a closed project rather than activating an invisible tab', () => {
    expect(projectTravel(projects, 'active', 'closed')).toEqual({
      kind: 'reopen',
      projectId: 'closed'
    })
  })

  it('blocks an unavailable project (reopening it would show an empty canvas)', () => {
    expect(projectTravel(projects, 'active', 'gone')).toEqual({ kind: 'blocked' })
  })

  it('does nothing for a project we do not have', () => {
    expect(projectTravel(projects, 'active', 'nope')).toEqual({ kind: 'none' })
  })

  it('travels from the welcome screen (no active project)', () => {
    expect(projectTravel(projects, '', 'open')).toEqual({ kind: 'switch', projectId: 'open' })
  })
})

describe('nodeTravel', () => {
  it('needs no travel for a node on the active canvas', () => {
    expect(nodeTravel(projects, 'active', 'n-active')).toEqual({ kind: 'none' })
  })

  it('switches to the open project that owns the node', () => {
    expect(nodeTravel(projects, 'active', 'n-open')).toEqual({ kind: 'switch', projectId: 'open' })
  })

  it('reopens the closed project that owns the node', () => {
    expect(nodeTravel(projects, 'active', 'n-closed')).toEqual({
      kind: 'reopen',
      projectId: 'closed'
    })
  })

  it('blocks a node in an unavailable project', () => {
    expect(nodeTravel(projects, 'active', 'n-gone')).toEqual({ kind: 'blocked' })
  })

  it('a node a closed, handed-off SSH project shares with its open team tab travels to the tab', () => {
    const shared: TravelProject[] = [
      { id: 'ssh-1', closed: true, handedOffTo: { at: 1 }, nodes: [{ id: 'n-team' }] },
      { id: 'team-tab', nodes: [{ id: 'n-team' }] },
      { id: 'active', nodes: [] }
    ]
    expect(nodeTravel(shared, 'active', 'n-team')).toEqual({ kind: 'switch', projectId: 'team-tab' })
  })

  it('a shared node whose team tab is CLOSED travels to the handed-off SSH project (guarded reopen), never the tab', () => {
    const shared: TravelProject[] = [
      { id: 'ssh-1', closed: true, handedOffTo: { at: 1 }, nodes: [{ id: 'n-team' }] },
      { id: 'team-tab', closed: true, remote: true, nodes: [{ id: 'n-team' }] },
      { id: 'active', nodes: [] }
    ]
    expect(nodeTravel(shared, 'active', 'n-team')).toEqual({ kind: 'reopen', projectId: 'ssh-1' })
  })

  it('does nothing for an unknown node', () => {
    expect(nodeTravel(projects, 'active', 'n-ghost')).toEqual({ kind: 'none' })
  })
})
