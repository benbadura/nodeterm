import { describe, it, expect, beforeEach } from 'vitest'
import { useProjects } from '../state/projects'
import { codexApprovalCaps } from '../state/codexCli'
import {
  createSession,
  resetSessionsForTest,
  bindProjectToSession,
  projectIdsBoundToSession,
  sessionForProject
} from '../session/session'
import { handleRelayDrop } from '../session/relay-tab'
import { createTeamTabs, type TeamTabs } from './hostedTeamTabs'
import { teamTabStoreOps } from './hostedTeamTabStore'
import type { NodeTerminalApi, Project } from '@shared/types'

// The model's store side against the REAL projects store and session registry: what a hosted team's
// placeholder and its tab removals do to the user's tabs and saved workspace.

const team = { hostId: 'H1', label: 'Acme' }

function hostProject(id: string): Project {
  return { id, name: id, color: '#888', nodes: [], remote: true } as unknown as Project
}

function model(): TeamTabs {
  const tabs: TeamTabs = createTeamTabs(teamTabStoreOps((id) => tabs.teamOf(id)))
  return tabs
}

function relaySession(): string {
  return createSession('relay', { marker: 'relay' } as unknown as NodeTerminalApi, 'Acme').id
}

const store = () => useProjects.getState()
const ids = () => store().projects.map((p) => p.id)
const savedIds = () => store().toWorkspace().projects.map((p) => p.id)

function freshApp(): void {
  resetSessionsForTest()
  createSession('local', { marker: 'local' } as unknown as NodeTerminalApi, 'This Mac')
}

beforeEach(() => {
  freshApp()
  store().hydrate({ version: 2, activeProjectId: '', projects: [] })
})

describe('the placeholder of a team with nothing shared', () => {
  it('is a relay tab: never saved, not active on its own, and the codex probe calls it remote', () => {
    const local = store().addProject('Mine')
    store().setActive(local.id)
    const [ph] = model().place(team, [], [], { keepActive: true })

    expect(store().getProject(ph)).toMatchObject({ name: 'Acme', remote: true })
    expect(store().activeProjectId).toBe(local.id)
    expect(savedIds()).toEqual([local.id])
    expect(codexApprovalCaps(undefined, ph).codexApprovalValues).toBeNull()
  })

  it('a restart and a boot reconnect leave no extra saved project behind', () => {
    const [first] = model().place(team, [], [], { keepActive: false })
    const saved = store().toWorkspace()

    // Restart: the store comes back from disk, the model and the sessions start fresh.
    freshApp()
    store().hydrate(saved)
    expect(ids()).toEqual([])
    const [second] = model().place(team, [], [], { keepActive: false })

    expect(second).not.toBe(first)
    expect(ids()).toEqual([second])
    expect(savedIds()).toEqual([])
  })

  it('a share event binds it, a drop greys it, and the first shared project replaces it', async () => {
    const tabs = model()
    const s = relaySession()
    const [a] = tabs.place(team, [hostProject('A')], [], { keepActive: false })
    bindProjectToSession(a, s) // openRelayTab binds what `place` returns

    // The host stops sharing A: the model opens the placeholder and binds it itself.
    await tabs.sharedChanged({ ...team, sessionId: s }, [], async () => [], { keepActive: false })
    const [ph] = ids()
    expect(store().getProject(ph)).toMatchObject({ name: 'Acme', remote: true })
    expect(projectIdsBoundToSession(s)).toEqual([ph])
    expect(sessionForProject(ph).id).toBe(s)
    expect(savedIds()).toEqual([])

    handleRelayDrop(
      { sessionId: s, projectId: a, projectIds: [a], dispose: () => {} },
      { setProjectUnavailable: (id, v) => store().setProjectUnavailable(id, v) }
    )
    expect(store().getProject(ph)?.unavailable).toBe(true)

    await tabs.sharedChanged({ ...team, sessionId: s }, ['B'], async () => [hostProject('B')], { keepActive: false })
    expect(ids()).toEqual(['B'])
    expect(projectIdsBoundToSession(s)).toEqual(['B'])
    expect(savedIds()).toEqual([])
  })
})

describe('removeTab', () => {
  const teamOf = (id: string) => (id === 'A' || id === 'B' ? 'H1' : undefined)

  function seed(order: Array<{ id: string; closed?: boolean; team?: boolean }>, active: string): void {
    store().hydrate({
      version: 2,
      activeProjectId: active,
      projects: order.map(({ id, closed, team: t }) => ({
        ...hostProject(id),
        remote: !!t,
        ...(closed ? { closed: true } : {})
      }))
    })
  }

  it('when the store hands the slot to a closed project, lands on the team\'s nearest open tab', () => {
    seed([{ id: 'Mine' }, { id: 'A', team: true }, { id: 'Old', closed: true }, { id: 'B', team: true }], 'A')
    teamTabStoreOps(teamOf).removeTab('A', 'H1')
    expect(ids()).toEqual(['Mine', 'Old', 'B'])
    expect(store().activeProjectId).toBe('B')
  })

  it('with no team tab left, lands on the nearest open project', () => {
    seed([{ id: 'Mine' }, { id: 'A', team: true }, { id: 'Old', closed: true }], 'A')
    teamTabStoreOps(teamOf).removeTab('A', 'H1')
    expect(store().activeProjectId).toBe('Mine')
  })

  it('keeps the store\'s pick when it is open, and the active tab when it was not the removed one', () => {
    seed([{ id: 'A', team: true }, { id: 'Other' }, { id: 'B', team: true }], 'A')
    teamTabStoreOps(teamOf).removeTab('A', 'H1')
    expect(store().activeProjectId).toBe('Other')

    seed([{ id: 'Mine' }, { id: 'A', team: true }, { id: 'B', team: true }], 'Mine')
    teamTabStoreOps(teamOf).removeTab('A', 'H1')
    expect(store().activeProjectId).toBe('Mine')
  })

  it('removes from the store only (no unknown id error), and the last tab leaves the welcome screen', () => {
    seed([{ id: 'A', team: true }], 'A')
    teamTabStoreOps(teamOf).removeTab('missing', 'H1')
    expect(ids()).toEqual(['A'])
    teamTabStoreOps(teamOf).removeTab('A', 'H1')
    expect(ids()).toEqual([])
    expect(store().activeProjectId).toBe('')
  })
})
