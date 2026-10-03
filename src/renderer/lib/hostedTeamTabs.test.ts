import { describe, it, expect, vi } from 'vitest'
import type { Project } from '@shared/types'
import { createTeamTabs, openSuccessor, reconcileTeamTabs, type TeamTabOps } from './hostedTeamTabs'

/** A host's shared project, as the relay hands it over (`sanitizeRelayProject` marks it remote). */
const proj = (id: string, name = id): Project => ({
  id,
  name,
  color: '#fff',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  remote: true
})
/** One of the user's own local projects. */
const local = (id: string): Project => ({ id, name: id, color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] })

const A = proj('A', 'Alpha')
const B = proj('B', 'Beta')
const C = proj('C', 'Gamma')

const team = { hostId: 'host-1', label: 'Team X' }
const live = { ...team, sessionId: 'relay-1' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** An in-memory stand-in for the projects store + the session registry's bindings, shaped like the
 *  real ones: `adoptProject` activates what it adopts and derives a fresh id when the id is taken,
 *  `addPlaceholder` (the store's `addProject`) does not activate, `removeTab` hands the active slot
 *  to the project that moves into it (the store's delete), `close` keeps the project marked closed
 *  (the store's closeProject), and `bind` throws for a disposed session. */
function fakeOps(initial: Project[] = [], active: string | null = null) {
  const state = { projects: [...initial], active, placeholders: 0, disposed: new Set<string>() }
  const bindings = new Map<string, string>()
  const calls: string[] = []
  const find = (id: string): Project | undefined => state.projects.find((p) => p.id === id)
  const ops: TeamTabOps = {
    getProject: find,
    isOpenTab: (id) => {
      const p = find(id)
      return !!p && !p.closed
    },
    adoptProject: vi.fn((p: Project) => {
      const adopted = find(p.id) ? { ...p, id: `${p.id}~derived` } : p
      state.projects.push(adopted)
      state.active = adopted.id
      return { id: adopted.id }
    }),
    addPlaceholder: vi.fn((label: string) => {
      const id = `ph-${++state.placeholders}`
      state.projects.push({ ...local(id), name: label })
      return { id }
    }),
    removeTab: vi.fn((id: string, _hostId: string) => {
      calls.push(`remove:${id}`)
      const index = state.projects.findIndex((p) => p.id === id)
      if (index < 0) return
      state.projects.splice(index, 1)
      if (state.active === id) {
        state.active = state.projects.length ? state.projects[Math.min(index, state.projects.length - 1)].id : null
      }
    }),
    activeProjectId: () => state.active,
    setActive: (id) => {
      state.active = id
    },
    bind: vi.fn((projectId: string, sessionId: string) => {
      if (state.disposed.has(sessionId)) throw new Error(`[session] no session ${sessionId}`)
      bindings.set(projectId, sessionId)
    }),
    unbind: vi.fn((projectId: string) => {
      calls.push(`unbind:${projectId}`)
      bindings.delete(projectId)
    })
  }
  return {
    ops,
    state,
    bindings,
    calls,
    has: (id: string) => !!find(id),
    ids: () => state.projects.map((p) => p.id),
    close: (id: string) => {
      const index = state.projects.findIndex((p) => p.id === id)
      state.projects = state.projects.map((p) => (p.id === id ? { ...p, closed: true } : p))
      if (state.active === id) {
        const open = state.projects
          .map((p, i) => ({ p, d: Math.abs(i - index) }))
          .filter(({ p }) => !p.closed)
          .sort((a, b) => a.d - b.d)
        state.active = open.length ? open[0].p.id : null
      }
    },
    dispose: (sessionId: string) => {
      state.disposed.add(sessionId)
    }
  }
}

describe('createTeamTabs', () => {
  it('place: adopts each shared project as a tab in host order, and keeps the user on their tab when asked', () => {
    const f = fakeOps([local('mine')], 'mine')
    const tabs = createTeamTabs(f.ops)

    expect(tabs.place(team, [A, B], [], { keepActive: true })).toEqual(['A', 'B'])
    expect(f.ops.adoptProject).toHaveBeenCalledTimes(2)
    expect(f.ids()).toEqual(['mine', 'A', 'B'])
    expect(f.state.active).toBe('mine')
    expect(tabs.teamOf('A')).toBe('host-1')
    expect(tabs.teamOf('B')).toBe('host-1')
    expect(tabs.teamOf('mine')).toBeUndefined()

    // Not asked to keep it: the user lands where the store's adopt put them.
    const g = fakeOps([local('mine')], 'mine')
    createTeamTabs(g.ops).place(team, [A, B], [], { keepActive: false })
    expect(g.state.active).toBe('B')
  })

  it('place: with nothing shared, a placeholder tab named after the team', () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)

    expect(tabs.place(team, [], [], { keepActive: false })).toEqual(['ph-1'])
    expect(f.state.projects.find((p) => p.id === 'ph-1')?.name).toBe('Team X')
    expect(tabs.teamOf('ph-1')).toBe('host-1')

    // Placing nothing again (a reconnect) keeps that one placeholder instead of minting another.
    expect(tabs.place(team, [], ['ph-1'], { keepActive: false })).toEqual(['ph-1'])
    expect(f.ops.addPlaceholder).toHaveBeenCalledTimes(1)
  })

  it('place on reconnect: reuses the existing tabs by id, unbinds then removes a tab that is no longer shared', () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    for (const id of tabs.place(team, [A, B], [], { keepActive: false })) f.ops.bind(id, 'relay-1')

    // The host now shares only A; the greyed tabs A and B are this team's existing tabs.
    expect(tabs.place(team, [A], ['A', 'B'], { keepActive: false })).toEqual(['A'])
    expect(f.ops.adoptProject).toHaveBeenCalledTimes(2) // A was reused, not adopted a second time
    expect(f.has('A')).toBe(true)
    expect(f.has('B')).toBe(false)
    expect(f.bindings.has('B')).toBe(false)
    expect(f.calls.indexOf('unbind:B')).toBeGreaterThanOrEqual(0)
    expect(f.calls.indexOf('unbind:B')).toBeLessThan(f.calls.indexOf('remove:B'))
    expect(tabs.teamOf('B')).toBeUndefined()
  })

  it('place: a project the user dismissed is not reopened on reconnect', () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    tabs.place(team, [A, B], [], { keepActive: false })

    expect(tabs.closeTab('B')).toEqual({ remaining: ['A'] })
    f.close('B') // the store keeps the closed tab, marked closed

    expect(tabs.place(team, [A, B], ['A'], { keepActive: false })).toEqual(['A'])
    expect(f.ops.adoptProject).toHaveBeenCalledTimes(2)
    expect(f.ops.isOpenTab('B')).toBe(false)
  })

  it('place: the host list is cleaned (duplicates, empty and overlong ids) before anything is adopted', () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)

    expect(tabs.place(team, [A, A, proj(''), proj('x'.repeat(129)), B], [], { keepActive: false })).toEqual(['A', 'B'])
    expect(f.ops.adoptProject).toHaveBeenCalledTimes(2)
    expect(f.ids()).toEqual(['A', 'B'])
  })

  it('place on reconnect: a closed copy whose dismissal was forgotten reopens under the host id, never a derived one', async () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    for (const id of tabs.place(team, [A, B], [], { keepActive: false })) f.ops.bind(id, 'relay-1')
    tabs.closeTab('B')
    f.close('B')
    // The host stops sharing B, which forgets the dismissal; the store still holds the closed copy.
    await tabs.sharedChanged(live, ['A'], async () => [A], { keepActive: false })

    expect(tabs.place(team, [A, B], ['A'], { keepActive: false })).toEqual(['A', 'B'])
    expect(f.ops.isOpenTab('B')).toBe(true)
    expect(f.ids().some((id) => id.includes('~derived'))).toBe(false)
  })

  it('a closed LOCAL project holding the host id is never removed, and no tab opens under another id', () => {
    const f = fakeOps([{ ...local('B'), closed: true }])
    const tabs = createTeamTabs(f.ops)

    expect(tabs.place(team, [A, B], [], { keepActive: false })).toEqual(['A'])
    expect(f.state.projects.find((p) => p.id === 'B')).toMatchObject({ closed: true })
    expect(f.ops.removeTab).not.toHaveBeenCalled()
    expect(f.ids().some((id) => id.includes('~derived'))).toBe(false)
    expect(tabs.teamOf('B')).toBeUndefined()
  })

  it('sharedChanged: opens and binds a newly shared project, loading the workspace only when something opens', async () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    tabs.place(team, [A], [], { keepActive: false })
    expect(f.state.active).toBe('A')
    const load = vi.fn(async () => [A, C])

    await expect(tabs.sharedChanged(live, ['A', 'C'], load, { keepActive: true })).resolves.toEqual({
      opened: ['C'],
      closed: []
    })
    expect(load).toHaveBeenCalledTimes(1)
    expect(f.bindings.get('C')).toBe('relay-1')
    expect(f.has('C')).toBe(true)
    expect(f.ops.adoptProject).toHaveBeenCalledTimes(2) // A was already open: only C was adopted
    expect(tabs.teamOf('C')).toBe('host-1')
    expect(f.state.active).toBe('A') // kept, although the store's adopt activated C

    // The same list again opens nothing, so the host's workspace is not loaded again.
    await expect(tabs.sharedChanged(live, ['A', 'C'], load, { keepActive: true })).resolves.toEqual({
      opened: [],
      closed: []
    })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('sharedChanged: closes and unbinds an unshared tab; the last unshare leaves a bound placeholder', async () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    for (const id of tabs.place(team, [A, B], [], { keepActive: false })) f.ops.bind(id, 'relay-1')
    const load = vi.fn(async () => [A, B])

    await expect(tabs.sharedChanged(live, ['A'], load, { keepActive: false })).resolves.toEqual({
      opened: [],
      closed: ['B']
    })
    expect(f.has('B')).toBe(false)
    expect(f.bindings.has('B')).toBe(false)
    expect(f.bindings.get('A')).toBe('relay-1')
    expect(tabs.teamOf('B')).toBeUndefined()

    await expect(tabs.sharedChanged(live, [], load, { keepActive: false })).resolves.toEqual({
      opened: [],
      closed: ['A']
    })
    expect(f.has('A')).toBe(false)
    expect(f.bindings.has('A')).toBe(false)
    expect(f.state.projects.find((p) => p.id === 'ph-1')?.name).toBe('Team X')
    expect(f.bindings.get('ph-1')).toBe('relay-1')
    expect(tabs.teamOf('ph-1')).toBe('host-1')
    expect(load).not.toHaveBeenCalled()
  })

  it('sharedChanged: the first real project replaces the placeholder', async () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    expect(tabs.place(team, [], [], { keepActive: false })).toEqual(['ph-1'])
    f.ops.bind('ph-1', 'relay-1')

    await expect(tabs.sharedChanged(live, ['A'], async () => [A], { keepActive: false })).resolves.toEqual({
      opened: ['A'],
      closed: []
    })
    expect(f.has('A')).toBe(true)
    expect(f.bindings.get('A')).toBe('relay-1')
    expect(f.has('ph-1')).toBe(false)
    expect(f.bindings.has('ph-1')).toBe(false)
    expect(tabs.teamOf('ph-1')).toBeUndefined()
    expect(tabs.teamOf('A')).toBe('host-1')
  })

  it('sharedChanged: a closed copy of a former tab is replaced, so a re-share reopens it under its own id', async () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    for (const id of tabs.place(team, [A, B], [], { keepActive: false })) f.ops.bind(id, 'relay-1')
    expect(tabs.closeTab('B')).toEqual({ remaining: ['A'] })
    f.close('B')

    await tabs.sharedChanged(live, ['A'], async () => [A], { keepActive: false }) // unshare
    await expect(tabs.sharedChanged(live, ['A', 'B'], async () => [A, B], { keepActive: false })).resolves.toEqual({
      opened: ['B'],
      closed: []
    })
    expect(f.ops.isOpenTab('B')).toBe(true)
    expect(f.bindings.get('B')).toBe('relay-1')
    expect(tabs.teamOf('B')).toBe('host-1')
    expect(f.ids().some((id) => id.includes('~derived'))).toBe(false)
  })

  it('sharedChanged: a store that derives an id anyway gets no tab under it, and the user stays put', async () => {
    const f = fakeOps([local('mine')], 'mine')
    const tabs = createTeamTabs(f.ops)
    tabs.place(team, [A], [], { keepActive: true })
    // A store that minted the id against state this renderer has not seen yet.
    f.ops.adoptProject = vi.fn((p: Project) => {
      const adopted = { ...p, id: `${p.id}~derived` }
      f.state.projects.push(adopted)
      f.state.active = adopted.id
      return { id: adopted.id }
    })

    await expect(tabs.sharedChanged(live, ['A', 'C'], async () => [A, C], { keepActive: false })).resolves.toEqual({
      opened: [],
      closed: []
    })
    expect(f.ids()).toEqual(['mine', 'A'])
    expect(f.state.active).toBe('mine')
    expect(f.bindings.size).toBe(0)
  })

  it('sharedChanged: shown counts only open tabs, so a team whose tabs were all closed gets its placeholder', async () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    for (const id of tabs.place(team, [A], [], { keepActive: false })) f.ops.bind(id, 'relay-1')
    f.close('A') // closed in the store, behind the controller's back

    await tabs.sharedChanged(live, ['A'], async () => [A], { keepActive: false })
    expect(f.bindings.get('ph-1')).toBe('relay-1')
    expect(tabs.teamOf('ph-1')).toBe('host-1')
  })

  it('sharedChanged: a user on the placeholder lands on the newly opened tab, never on the store fallback', async () => {
    const f = fakeOps([local('mine')], 'mine')
    const tabs = createTeamTabs(f.ops)
    const [ph] = tabs.place(team, [], [], { keepActive: false })
    f.ops.bind(ph, 'relay-1')
    f.state.projects.push({ ...local('later'), closed: true }) // a project the user made and closed meanwhile
    f.ops.setActive(ph) // the user is looking at the team's placeholder

    await tabs.sharedChanged(live, ['A'], async () => [A], { keepActive: true })
    expect(f.state.active).toBe('A')
    expect(f.ops.isOpenTab(f.state.active as string)).toBe(true)
  })

  it('sharedChanged: a user on a tab the host unshares lands on another of the team tabs', async () => {
    const f = fakeOps([local('mine')], 'mine')
    const tabs = createTeamTabs(f.ops)
    for (const id of tabs.place(team, [A, B], [], { keepActive: false })) f.ops.bind(id, 'relay-1')
    f.state.projects.push({ ...local('later'), closed: true })
    f.ops.setActive('B')

    await tabs.sharedChanged(live, ['A'], async () => [A], { keepActive: true })
    expect(f.state.active).toBe('A')
  })

  it('sharedChanged: a rejected load applies the closes, opens nothing, and a later re-share opens the project', async () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    for (const id of tabs.place(team, [A, B], [], { keepActive: false })) f.ops.bind(id, 'relay-1')

    await expect(
      tabs.sharedChanged(live, ['A', 'C'], async () => {
        throw new Error('relay hiccup')
      }, { keepActive: false })
    ).rejects.toThrow('relay hiccup')
    expect(f.has('B')).toBe(false)
    expect(tabs.teamOf('B')).toBeUndefined()
    expect(f.has('C')).toBe(false)
    expect(f.ops.addPlaceholder).not.toHaveBeenCalled() // A is still shown

    await expect(tabs.sharedChanged(live, ['A', 'B'], async () => [A, B], { keepActive: false })).resolves.toEqual({
      opened: ['B'],
      closed: []
    })
    expect(f.ops.isOpenTab('B')).toBe(true)
  })

  it('sharedChanged: overlapping events apply in order, each against the set the previous one left', async () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    tabs.place(team, [A], [], { keepActive: false })
    const first = deferred<Project[]>()
    const secondLoad = vi.fn(async () => [A])

    const e1 = tabs.sharedChanged(live, ['A', 'B'], () => first.promise, { keepActive: false })
    const e2 = tabs.sharedChanged(live, ['A'], secondLoad, { keepActive: false })
    first.resolve([A, B])

    await expect(e1).resolves.toEqual({ opened: ['B'], closed: [] })
    await expect(e2).resolves.toEqual({ opened: [], closed: ['B'] })
    expect(f.has('B')).toBe(false)
    expect(f.bindings.has('B')).toBe(false)
    expect(tabs.teamOf('B')).toBeUndefined()
    expect(secondLoad).not.toHaveBeenCalled()
  })

  it('sharedChanged: a session disposed during the load gets no tab; the adopted one is removed', async () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    for (const id of tabs.place(team, [A], [], { keepActive: false })) f.ops.bind(id, 'relay-1')

    await expect(
      tabs.sharedChanged(live, ['A', 'C'], async () => {
        f.dispose('relay-1')
        return [A, C]
      }, { keepActive: false })
    ).rejects.toThrow(/no session/)
    expect(f.has('C')).toBe(false)
    expect(tabs.teamOf('C')).toBeUndefined()
    expect(f.has('A')).toBe(true)
  })

  it('sharedChanged: an event in flight when the team remounts changes nothing', async () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    for (const id of tabs.place(team, [A], [], { keepActive: false })) f.ops.bind(id, 'relay-1')
    const load = deferred<Project[]>()

    const stale = tabs.sharedChanged(live, ['A', 'B'], () => load.promise, { keepActive: false })
    // The connection drops and remounts; the new workspace shares only A.
    expect(tabs.place(team, [A], ['A'], { keepActive: false })).toEqual(['A'])
    load.resolve([A, B])

    await expect(stale).resolves.toEqual({ opened: [], closed: [] })
    expect(f.has('B')).toBe(false)
    expect(f.bindings.has('B')).toBe(false)
  })

  it('sharedChanged: a remount while the workspace loads makes the event open nothing', async () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    for (const id of tabs.place(team, [A], [], { keepActive: false })) f.ops.bind(id, 'relay-1')
    const load = deferred<Project[]>()
    const loading = deferred<void>()

    const stale = tabs.sharedChanged(live, ['A', 'B'], () => {
      loading.resolve()
      return load.promise
    }, { keepActive: false })
    await loading.promise // the event is now waiting on the host's workspace
    expect(tabs.place(team, [A], ['A'], { keepActive: false })).toEqual(['A'])
    load.resolve([A, B])

    await expect(stale).resolves.toEqual({ opened: [], closed: [] })
    expect(f.has('B')).toBe(false)
    expect(f.bindings.has('B')).toBe(false)
  })

  it('closeTab: with other tabs open only unbinds this one and reports them; the last tab reports none', () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    for (const id of tabs.place(team, [A, B, C], [], { keepActive: false })) f.ops.bind(id, 'relay-1')
    // C was closed in the store behind this controller's back: it is no longer an open tab.
    f.close('C')

    expect(tabs.closeTab('A')).toEqual({ remaining: ['B'] })
    expect(f.bindings.has('A')).toBe(false)
    expect(f.bindings.get('B')).toBe('relay-1')
    expect(tabs.teamOf('A')).toBeUndefined()
    expect(f.ops.removeTab).not.toHaveBeenCalled() // closing is the caller's; this only bookkeeps

    // The last open tab of the team: its binding stays for the caller that ends the connection.
    expect(tabs.closeTab('B')).toEqual({ remaining: [] })
    expect(f.bindings.get('B')).toBe('relay-1')
    expect(tabs.teamOf('B')).toBeUndefined()

    // A tab that belongs to no team reports nothing and touches nothing.
    expect(tabs.closeTab('mine')).toEqual({ remaining: [] })
  })

  it('closeTab: closing the last tab forgets the team, so a later join is not shadowed by an old dismissal', () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    for (const id of tabs.place(team, [A, B], [], { keepActive: false })) f.ops.bind(id, 'relay-1')
    expect(tabs.closeTab('A')).toEqual({ remaining: ['B'] })
    f.close('A')
    expect(tabs.closeTab('B')).toEqual({ remaining: [] })
    f.close('B')

    // The user joins the team again in the same run.
    expect(tabs.place(team, [A, B], [], { keepActive: false })).toEqual(['A', 'B'])
    expect(f.ops.isOpenTab('A')).toBe(true)
    expect(f.ops.isOpenTab('B')).toBe(true)
  })

  it('removeTab names the team the tab belonged to, so the caller can keep the user on that team', async () => {
    const f = fakeOps()
    const tabs = createTeamTabs(f.ops)
    for (const id of tabs.place(team, [A, B], [], { keepActive: false })) f.ops.bind(id, 'relay-1')
    await tabs.sharedChanged(live, ['A'], async () => [], { keepActive: true })
    expect(f.ops.removeTab).toHaveBeenCalledWith('B', 'host-1')
    // The last unshare leaves a placeholder; the next share removes it, named the same way.
    await tabs.sharedChanged(live, [], async () => [], { keepActive: true })
    expect(f.ops.removeTab).toHaveBeenCalledWith('A', 'host-1')
    await tabs.sharedChanged(live, ['C'], async () => [C], { keepActive: true })
    expect(f.ops.removeTab).toHaveBeenCalledWith('ph-1', 'host-1')
    // A reconnect that finds a project unshared removes it under the team too.
    tabs.place(team, [], ['C'], { keepActive: true })
    expect(f.ops.removeTab).toHaveBeenCalledWith('C', 'host-1')
  })
})

describe('reconcileTeamTabs', () => {
  it('reports the tabs gone and the tabs new since the joiner was last told', () => {
    expect(reconcileTeamTabs(['A', 'B'], ['B', 'C'])).toEqual({ removed: ['A'], added: ['C'], known: ['B', 'C'] })
    expect(reconcileTeamTabs(['ph-1'], ['C'])).toEqual({ removed: ['ph-1'], added: ['C'], known: ['C'] })
    expect(reconcileTeamTabs(['A'], ['A'])).toEqual({ removed: [], added: [], known: ['A'] })
  })

  it('with no open team tab, removes nothing and keeps what it knew for the next reconcile', () => {
    expect(reconcileTeamTabs(['A', 'B'], [])).toEqual({ removed: [], added: [], known: ['A', 'B'] })
  })

  it('an earlier event reconciled after a later one closed every tab ends nothing; the later one moves the team on', async () => {
    // The joiner as Canvas drives it: what it was told, in order.
    const joiner: string[] = []
    const f = fakeOps([local('mine')], 'mine')
    const tabs = createTeamTabs(f.ops)
    const placed = tabs.place(team, [], [], { keepActive: true })
    for (const id of placed) f.ops.bind(id, 'relay-1')
    let known = [...placed]
    const seen: string[][] = []
    const teamTabIds = () => f.state.projects.filter((p) => !p.closed && tabs.teamOf(p.id) === 'host-1').map((p) => p.id)
    // Canvas's handler: run the event, then reconcile from the store whether it resolved or not.
    const follow = (ids: string[], load: () => Promise<Project[]>) =>
      tabs
        .sharedChanged(live, ids, load, { keepActive: true })
        .catch(() => {})
        .then(() => {
          const after = teamTabIds()
          seen.push(after)
          const r = reconcileTeamTabs(known, after)
          known = r.known
          if (r.added.length) joiner.push(`added:${r.added.join(',')}`)
          for (const id of r.removed) joiner.push(`removed:${id}->${r.known[0]}`)
        })

    const l1 = deferred<Project[]>()
    const l2 = deferred<Project[]>()
    const e1 = follow(['A', 'B'], () => l1.promise)
    const e2 = follow(['C'], () => l2.promise) // a full replace, queued behind e1
    l1.resolve([A, B])
    await e1
    // e2's close half ran before e1's reconcile: the team had no open tab at that moment…
    expect(seen).toEqual([[]])
    // …and the joiner was told nothing (a "tab closed" here would release the live connection).
    expect(joiner).toEqual([])
    l2.resolve([C])
    await e2
    expect(seen.at(-1)).toEqual(['C'])
    expect(joiner).toEqual(['added:C', 'removed:ph-1->C'])
    expect(known).toEqual(['C'])
  })
})

describe('openSuccessor', () => {
  const tab = (id: string, closed = false) => ({ id, closed })

  it('prefers the nearest open tab of the same team', () => {
    // `x` was removed from index 2: the list is what remains.
    const projects = [tab('a'), tab('t1'), tab('mine'), tab('other'), tab('t2')]
    expect(openSuccessor(projects, 2, (id) => id === 't1' || id === 't2')).toBe('t1')
    expect(openSuccessor(projects, 4, (id) => id === 't1' || id === 't2')).toBe('t2')
  })

  it('never lands on a closed project, of the team or not', () => {
    const projects = [tab('mine'), tab('t1', true), tab('closed', true), tab('far')]
    expect(openSuccessor(projects, 2, (id) => id === 't1')).toBe('far')
    expect(openSuccessor(projects, 1, () => false)).toBe('mine')
  })

  it('without a team tab left, the nearest open project; without one at all, the welcome screen', () => {
    expect(openSuccessor([tab('a'), tab('b'), tab('c')], 1, () => false)).toBe('b')
    expect(openSuccessor([tab('a'), tab('b')], 2, () => false)).toBe('b')
    expect(openSuccessor([tab('a', true)], 0, () => false)).toBe('')
    expect(openSuccessor([], 0, () => false)).toBe('')
  })
})
