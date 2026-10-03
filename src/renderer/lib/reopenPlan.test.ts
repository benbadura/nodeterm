import { describe, it, expect, beforeEach } from 'vitest'
import { planReopen, type PlanReopenProject } from './reopenPlan'
import { useReopenHistory } from '@renderer/state/reopenHistory'
import type { ReopenNodeSnapshot } from './reopenNode'
import type { CanvasNode } from '@renderer/state/workspace'

const snap = (over: Partial<ReopenNodeSnapshot> = {}): ReopenNodeSnapshot => ({
  type: 'sticky',
  position: { x: 0, y: 0 },
  absolutePosition: { x: 0, y: 0 },
  data: { title: 'Note', color: '#ffd60a', group: null },
  ...over
})

const node = (id: string): CanvasNode =>
  ({ id, type: 'sticky', position: { x: 0, y: 0 }, data: { title: 'Note', color: '#ffd60a', group: null } }) as CanvasNode

/** A `recreate` stand-in that always succeeds, tagging each output node with a counter so a
 *  multi-node batch is distinguishable in assertions. */
function alwaysRecreates(): (s: ReopenNodeSnapshot) => CanvasNode | null {
  let n = 0
  return () => node(`recreated-${n++}`)
}

const neverRecreates = () => null

beforeEach(() => {
  useReopenHistory.setState({ stack: [] })
})

describe('planReopen', () => {
  it('reopens a still-closed project', () => {
    const projects: PlanReopenProject[] = [{ id: 'p1', closed: true, nodes: [] }]
    const plan = planReopen(
      { kind: 'project', projectId: 'p1', closedAt: 1 },
      projects,
      'p2',
      new Set(),
      neverRecreates
    )
    expect(plan).toEqual({ action: 'reopenProject', projectId: 'p1' })
  })

  it('skips a project entry whose project was already reopened another way (no longer closed)', () => {
    const projects: PlanReopenProject[] = [{ id: 'p1', closed: false, nodes: [] }]
    const plan = planReopen(
      { kind: 'project', projectId: 'p1', closedAt: 1 },
      projects,
      'p2',
      new Set(),
      neverRecreates
    )
    expect(plan).toEqual({ action: 'skip' })
  })

  it('refuses a closed relay (team) tab: a reopen would mount the host nodes on this core', () => {
    const projects: PlanReopenProject[] = [{ id: 'team', closed: true, remote: true, nodes: [] }]
    const plan = planReopen({ kind: 'project', projectId: 'team', closedAt: 1 }, projects, 'p2', new Set(), neverRecreates)
    expect(plan).toEqual({ action: 'refuse', projectId: 'team' })
  })

  it('refuses a nodes entry for a closed team tab BEFORE recreating anything into it', () => {
    // insertStored + reopenProjectAfter would write the nodes into the relay copy and then reopen it.
    const projects: PlanReopenProject[] = [{ id: 'team', closed: true, remote: true, nodes: [] }]
    let recreated = 0
    const plan = planReopen({ kind: 'nodes', projectId: 'team', closedAt: 1, nodes: [snap()] }, projects, 'p2', new Set(), () => {
      recreated++
      return node('x')
    })
    expect(plan).toEqual({ action: 'refuse', projectId: 'team' })
    expect(recreated).toBe(0)
  })

  it('an OPEN team tab still takes a restored node (its relay session is live)', () => {
    const projects: PlanReopenProject[] = [{ id: 'team', remote: true, nodes: [] }]
    const plan = planReopen({ kind: 'nodes', projectId: 'team', closedAt: 1, nodes: [snap()] }, projects, 'p2', new Set(), alwaysRecreates())
    expect(plan).toMatchObject({ action: 'insertStored', projectId: 'team', reopenProjectAfter: false })
  })

  it('skips a project entry whose project was permanently deleted since', () => {
    const plan = planReopen({ kind: 'project', projectId: 'gone', closedAt: 1 }, [], 'p2', new Set(), neverRecreates)
    expect(plan).toEqual({ action: 'skip' })
  })

  it('skips a nodes entry whose project was permanently deleted since', () => {
    const plan = planReopen(
      { kind: 'nodes', projectId: 'gone', closedAt: 1, nodes: [snap()] },
      [],
      'p2',
      new Set(),
      alwaysRecreates()
    )
    expect(plan).toEqual({ action: 'skip' })
  })

  it('skips a nodes entry that recreates to nothing, rather than switching for an empty result', () => {
    const projects: PlanReopenProject[] = [{ id: 'p1', closed: false, nodes: [] }]
    const plan = planReopen(
      { kind: 'nodes', projectId: 'p1', closedAt: 1, nodes: [snap(), snap()] },
      projects,
      'p1',
      new Set(),
      neverRecreates
    )
    expect(plan).toEqual({ action: 'skip' })
  })

  it('inserts live when the target project is the active one', () => {
    const projects: PlanReopenProject[] = [{ id: 'p1', closed: false, nodes: [] }]
    const plan = planReopen(
      { kind: 'nodes', projectId: 'p1', closedAt: 1, nodes: [snap(), snap()] },
      projects,
      'p1',
      new Set(['live-1']),
      alwaysRecreates()
    )
    expect(plan.action).toBe('insertActive')
    if (plan.action !== 'insertActive') throw new Error('unreachable')
    // A multi-node batch restores as ONE unit, not split across separate plans.
    expect(plan.nodes.map((n) => n.id)).toEqual(['recreated-0', 'recreated-1'])
  })

  it('a batch that partially recreates still restores as one unit with only the survivors', () => {
    const projects: PlanReopenProject[] = [{ id: 'p1', closed: false, nodes: [] }]
    let call = 0
    const recreate = () => (call++ === 0 ? null : node('survivor'))
    const plan = planReopen(
      { kind: 'nodes', projectId: 'p1', closedAt: 1, nodes: [snap(), snap()] },
      projects,
      'p1',
      new Set(),
      recreate
    )
    expect(plan.action).toBe('insertActive')
    if (plan.action !== 'insertActive') throw new Error('unreachable')
    expect(plan.nodes).toHaveLength(1)
    expect(plan.nodes[0].id).toBe('survivor')
  })

  it('routes a non-active OPEN project through insertStored with reopenProjectAfter false (plain switch)', () => {
    const projects: PlanReopenProject[] = [{ id: 'p1', closed: false, nodes: [{ id: 'existing' }] }]
    const plan = planReopen(
      { kind: 'nodes', projectId: 'p1', closedAt: 1, nodes: [snap()] },
      projects,
      'p-active-elsewhere',
      new Set(['ignored-because-not-active']),
      alwaysRecreates()
    )
    expect(plan).toMatchObject({ action: 'insertStored', projectId: 'p1', reopenProjectAfter: false })
  })

  it('routes a non-active CLOSED project through insertStored with reopenProjectAfter true', () => {
    const projects: PlanReopenProject[] = [{ id: 'p1', closed: true, nodes: [] }]
    const plan = planReopen(
      { kind: 'nodes', projectId: 'p1', closedAt: 1, nodes: [snap()] },
      projects,
      'p-active-elsewhere',
      new Set(),
      alwaysRecreates()
    )
    expect(plan).toMatchObject({ action: 'insertStored', projectId: 'p1', reopenProjectAfter: true })
  })

  it('uses the STORED project nodes (not the live set) as liveNodeIds for a non-active target', () => {
    const projects: PlanReopenProject[] = [{ id: 'p1', closed: false, nodes: [{ id: 'stored-parent' }] }]
    let seenLiveIds: ReadonlySet<string> | null = null
    const plan = planReopen(
      { kind: 'nodes', projectId: 'p1', closedAt: 1, nodes: [snap({ parentId: 'stored-parent' })] },
      projects,
      'p-active-elsewhere',
      new Set(['live-only-id']), // must NOT be what the recreate call sees
      (s, liveIds) => {
        seenLiveIds = liveIds
        return node('n')
      }
    )
    expect(plan.action).toBe('insertStored')
    expect(seenLiveIds).toEqual(new Set(['stored-parent']))
  })

  it('uses the ACTIVE live node ids (not the stored copy) for the active target', () => {
    const projects: PlanReopenProject[] = [{ id: 'p1', closed: false, nodes: [{ id: 'stale-stored-id' }] }]
    let seenLiveIds: ReadonlySet<string> | null = null
    planReopen(
      { kind: 'nodes', projectId: 'p1', closedAt: 1, nodes: [snap()] },
      projects,
      'p1',
      new Set(['live-parent']),
      (s, liveIds) => {
        seenLiveIds = liveIds
        return node('n')
      }
    )
    expect(seenLiveIds).toEqual(new Set(['live-parent']))
  })

  // Spec scenario (a): repeated presses walk back through history in true chronological order,
  // across interleaved entry kinds — driven through the REAL stack (Task 1's useReopenHistory),
  // not a fake, so this exercises the actual pop order the command relies on.
  it('walks back through interleaved project/nodes history in true chronological order, skipping stale entries', () => {
    const projects: PlanReopenProject[] = [
      { id: 'proj-old', closed: true, nodes: [] }, // still closed: reopenable
      { id: 'proj-mid', closed: false, nodes: [] }, // reopened another way since: stale
      { id: 'proj-new', closed: false, nodes: [] } // holds the recreatable node batch
    ]
    useReopenHistory.getState().push({ kind: 'project', projectId: 'proj-old', closedAt: 1 })
    useReopenHistory.getState().push({ kind: 'project', projectId: 'proj-mid', closedAt: 2 })
    useReopenHistory.getState().push({ kind: 'nodes', projectId: 'proj-new', closedAt: 3, nodes: [snap()] })

    const plans: ReturnType<typeof planReopen>[] = []
    let popped = useReopenHistory.getState().popNext()
    while (popped) {
      plans.push(planReopen(popped, projects, 'proj-new', new Set(['live-1']), alwaysRecreates()))
      popped = useReopenHistory.getState().popNext()
    }

    // Most-recently-closed first: the nodes batch, then proj-mid (stale — skip), then proj-old.
    expect(plans[0].action).toBe('insertActive')
    expect(plans[1]).toEqual({ action: 'skip' })
    expect(plans[2]).toEqual({ action: 'reopenProject', projectId: 'proj-old' })
    expect(plans).toHaveLength(3)
  })
})
