// The lifecycle over REAL Claude Code 2.1.284 hook streams (fixture:
// src/shared/agents/__fixtures__/claude/subagent-hook-payloads.json — provenance in
// normalize.claude.subagent-capture.test.ts). Every scenario is replayed through the real
// `normalizeClaude` and then the lifecycle, into a tiny card model that behaves like the renderer
// store (`state/agentNodes.ts`): a start creates or re-opens a card, a `supersedes` moves the old
// card to the new key, an end marks it done.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { normalizeClaude, type NormalizedAgentEvent } from '../shared/agents/normalize'
import { ClaudeSubagentLifecycle } from './claude-subagent-lifecycle'

type Payload = Record<string, unknown>
const fixture = JSON.parse(
  readFileSync(
    path.join(__dirname, '../shared/agents/__fixtures__/claude/subagent-hook-payloads.json'),
    'utf8'
  ).replace(/\r\n/g, '\n')
) as { scenarios: Record<string, { events: Payload[] }> }
const events = (name: string): Payload[] => fixture.scenarios[name].events

/** A payload set as an OLDER Claude (or a session whose hook snapshot predates SubagentStart)
 *  would have produced it: no native subagent hooks, no Stop inventory. */
const legacyOnly = (ev: Payload[]): Payload[] =>
  ev
    .filter((e) => e.hook_event_name !== 'SubagentStart' && e.hook_event_name !== 'SubagentStop')
    .map((e) => {
      const { background_tasks: _drop, ...rest } = e
      return rest
    })

interface Card {
  label?: string
  type?: string
  state: 'working' | 'done'
  starts: number
}

function run(payloads: Payload[], lc = new ClaudeSubagentLifecycle()) {
  const stream: NormalizedAgentEvent[] = []
  const cards = new Map<string, Card>()
  const apply = (e: NormalizedAgentEvent): void => {
    for (const out of lc.apply(e)) {
      stream.push(out)
      if (out.kind === 'subagent-start' && out.toolUseId) {
        // A supersede MOVES a card; it is not a start of the new key (`starts` counts re-opens).
        if (out.supersedes) cards.delete(out.supersedes)
        const prev = cards.get(out.toolUseId)
        cards.set(out.toolUseId, {
          label: out.taskLabel,
          type: out.subagentType,
          state: 'working',
          starts: (prev?.starts ?? 0) + 1
        })
      } else if (out.kind === 'subagent-end' && out.toolUseId) {
        const c = cards.get(out.toolUseId)
        if (c) c.state = 'done'
      }
    }
  }
  for (const p of payloads) {
    const e = normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: p })
    if (e) apply(e)
  }
  return { stream, cards, lc, apply }
}

/** The exact tool_use_id → agent_id pairs the CLI itself reported (the launch acks + the sync ends). */
function exactPairs(ev: Payload[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const e of ev) {
    const id = (e.tool_response as { agentId?: string } | undefined)?.agentId
    if (e.hook_event_name === 'PostToolUse' && e.tool_name === 'Agent' && typeof id === 'string') {
      m.set(e.tool_use_id as string, id)
    }
  }
  return m
}
/** tool_use_id → the task label the tool call carried (only top-level calls: a child's is filtered). */
function labels(ev: Payload[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const e of ev) {
    if (e.hook_event_name === 'PreToolUse' && e.tool_name === 'Agent' && !e.agent_id) {
      m.set(e.tool_use_id as string, (e.tool_input as { description: string }).description)
    }
  }
  return m
}
const startedIds = (ev: Payload[]): string[] => [
  ...new Set(ev.filter((e) => e.hook_event_name === 'SubagentStart').map((e) => e.agent_id as string))
]

describe('ClaudeSubagentLifecycle over captured sessions', () => {
  for (const name of Object.keys(fixture.scenarios)) {
    it(`${name}: exactly one card per real subagent, keyed by its agent_id`, () => {
      const ev = events(name)
      const { cards } = run(ev)
      expect([...cards.keys()].sort()).toEqual(startedIds(ev).sort())
    })

    it(`${name}: every top-level card carries the label of ITS OWN tool call`, () => {
      const ev = events(name)
      const { cards } = run(ev)
      const lab = labels(ev)
      for (const [toolUseId, agentId] of exactPairs(ev)) {
        if (!lab.has(toolUseId)) continue // a nested call: its tool events are the child's, never labelled
        expect(cards.get(agentId)?.label, `${name} ${agentId}`).toBe(lab.get(toolUseId))
      }
    })
  }

  it('side-agent stops never reach a consumer', () => {
    for (const name of Object.keys(fixture.scenarios)) {
      const ev = events(name)
      const phantoms = new Set(
        ev.filter((e) => e.hook_event_name === 'SubagentStop' && e.agent_type === '').map((e) => e.agent_id)
      )
      const { stream } = run(ev)
      for (const out of stream) expect(phantoms.has(out.toolUseId)).toBe(false)
    }
  })

  it('print_sync: the first subagent of a session is drawn from the tool call, then REPLACED by the native card', () => {
    const ev = events('print_sync')
    const { stream, cards } = run(ev)
    const toolStart = stream.find((e) => e.kind === 'subagent-start' && e.subagentSignal === 'tool')!
    const nativeStart = stream.find((e) => e.kind === 'subagent-start' && e.subagentSignal === 'native')!
    expect(nativeStart.supersedes).toBe(toolStart.toolUseId)
    expect(cards.size).toBe(1)
    expect([...cards.values()][0]).toMatchObject({ state: 'done', label: 'Read a.txt contents' })
  })

  it('once a session has sent a native start, a tool call draws NOTHING until its own SubagentStart', () => {
    // interactive_background_then_esc holds two prompts in one session: the second subagent's
    // PreToolUse arrives after the session latched.
    const ev = events('interactive_background_then_esc')
    const { stream } = run(ev)
    const toolStarts = stream.filter((e) => e.kind === 'subagent-start' && e.subagentSignal === 'tool')
    const nativeStarts = stream.filter((e) => e.kind === 'subagent-start' && e.subagentSignal === 'native')
    expect(toolStarts).toHaveLength(1)
    expect(nativeStarts).toHaveLength(2)
    expect(nativeStarts[1].supersedes).toBeUndefined()
    expect(nativeStarts[1].taskLabel).toBe('Run python sleep')
  })

  it('print_nested: the nested child gets its own card (the tool path never saw it), typed but unlabelled', () => {
    const ev = events('print_nested')
    const { cards } = run(ev)
    expect(cards.size).toBe(2)
    const nested = [...cards.entries()].find(([, c]) => c.label === undefined)!
    expect(nested[1]).toMatchObject({ type: 'general-purpose', state: 'done' })
  })

  it('interactive_nested_resume: a resumed agent RE-OPENS its card instead of drawing a second one', () => {
    const ev = events('interactive_nested_resume')
    const { cards } = run(ev)
    const resumed = [...cards.values()].find((c) => c.starts === 2)!
    expect(resumed).toMatchObject({ state: 'done', label: expect.any(String) })
  })

  it('async: the card ends on SubagentStop, and the later task-notification end is harmless', () => {
    // The sniffed end lands before the session ends (it is the prompt that wakes the parent).
    const ev = events('print_async').filter((e) => e.hook_event_name !== 'SessionEnd')
    const { stream, cards, apply } = run(ev)
    const [id] = startedIds(ev)
    const firstEnd = stream.findIndex((e) => e.kind === 'subagent-end' && e.toolUseId === id)
    expect(stream[firstEnd].subagentSignal).toBe('native')
    // The shells' <task-notification> sniff still fires, keyed by the TOOL id: mapped, idempotent.
    const toolUseId = [...exactPairs(ev).keys()][0]
    apply({ nodeId: 'n1', agentId: 'claude', kind: 'subagent-end', toolUseId, subagentSignal: 'transcript', result: 'x' })
    expect(stream.at(-1)).toMatchObject({ kind: 'subagent-end', toolUseId: id })
    expect(cards.get(id)?.state).toBe('done')
  })

  it('a sync end still delivers the tool stats, re-keyed to the native card', () => {
    const ev = events('print_sync')
    const { stream } = run(ev)
    const [id] = startedIds(ev)
    const toolEnd = stream.find((e) => e.kind === 'subagent-end' && e.subagentSignal === 'tool' && e.toolUseId === id)!
    expect(toolEnd).toMatchObject({ toolUseId: id, tokens: expect.any(Number), toolUses: 1 })
  })

  it('a killed child (no SubagentStop) is ended by the next Stop inventory that no longer lists it', () => {
    const ev = events('print_interrupt_background')
    const { stream, cards } = run(ev)
    const [id] = startedIds(ev)
    expect(cards.get(id)?.state).toBe('done')
    const end = stream.find((e) => e.kind === 'subagent-end' && e.toolUseId === id)!
    // …and it was the Stop that ended it: the interrupt fired no stop for this child.
    expect(ev.some((e) => e.hook_event_name === 'SubagentStop' && e.agent_id === id)).toBe(false)
    expect(end.subagentSignal).toBe('native')
  })

  it('a killed child with no later Stop stays working (the decay owns it, as before)', () => {
    const ev = events('print_interrupt_foreground')
    const { cards } = run(ev)
    expect([...cards.values()].map((c) => c.state)).toEqual(['working'])
  })

  it('a Stop inventory never ends a card it still lists', () => {
    const ev = events('print_async')
    const { cards } = run(ev.slice(0, ev.findIndex((e) => e.hook_event_name === 'Stop') + 1))
    expect([...cards.values()].map((c) => c.state)).toEqual(['working'])
  })

  it('labels stay exact when the three near-simultaneous SubagentStart POSTs arrive REORDERED', () => {
    // Measured: the three starts landed within 5 ms of each other, each followed ~1 ms later by
    // its launch ack. A backgrounded POST can overtake another; the ack is what makes it exact.
    const ev = [...events('interactive_parallel')]
    const idx = ev.map((e, i) => (e.hook_event_name === 'SubagentStart' ? i : -1)).filter((i) => i >= 0)
    const starts = idx.map((i) => ev[i]).reverse()
    idx.forEach((i, k) => (ev[i] = starts[k]))
    const { cards } = run(ev)
    const lab = labels(ev)
    for (const [toolUseId, agentId] of exactPairs(ev)) {
      if (lab.has(toolUseId)) expect(cards.get(agentId)?.label).toBe(lab.get(toolUseId))
    }
    expect(cards.size).toBe(3)
  })

  it('…and still exact when an ack overtakes its own SubagentStart', () => {
    const ev = [...events('print_async')]
    const s = ev.findIndex((e) => e.hook_event_name === 'SubagentStart')
    const a = ev.findIndex((e) => e.hook_event_name === 'PostToolUse' && e.tool_name === 'Agent')
    ;[ev[s], ev[a]] = [ev[a], ev[s]]
    const { cards } = run(ev)
    expect(cards.size).toBe(1)
    expect(cards.get(startedIds(ev)[0])?.label).toBe('Sleep then read b.txt')
  })
})

describe('the fallback: a CLI (or hook snapshot) with no native subagent hooks', () => {
  for (const name of ['print_sync', 'print_async', 'print_parallel_foreground', 'interactive_parallel']) {
    it(`${name}: the stream is byte-for-byte what normalizeClaude produced`, () => {
      const ev = legacyOnly(events(name))
      const normalized = ev
        .map((p) => normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: p }))
        .filter((e): e is NormalizedAgentEvent => !!e)
      const { stream } = run(ev)
      expect(stream).toEqual(normalized)
    })
  }

  it('cards stay keyed by the tool_use_id, exactly as before', () => {
    const ev = legacyOnly(events('print_parallel_foreground'))
    const { cards } = run(ev)
    expect([...cards.keys()].sort()).toEqual([...labels(ev).keys()].sort())
  })
})

describe('ClaudeSubagentLifecycle — the rules, one at a time', () => {
  const base = { nodeId: 'n1', agentId: 'claude', sessionId: 's1' } as const
  const toolStart = (toolUseId: string, type = 'general-purpose'): NormalizedAgentEvent => ({
    ...base, kind: 'subagent-start', toolUseId, subagentType: type, taskLabel: `task ${toolUseId}`, subagentSignal: 'tool'
  })
  const nativeStart = (id: string, type = 'general-purpose', sessionId = 's1'): NormalizedAgentEvent => ({
    ...base, sessionId, kind: 'subagent-start', toolUseId: id, subagentType: type, subagentSignal: 'native'
  })
  const nativeEnd = (id: string): NormalizedAgentEvent => ({ ...base, kind: 'subagent-end', toolUseId: id, subagentSignal: 'native' })
  const stop = (ids?: string[]): NormalizedAgentEvent => ({ ...base, kind: 'state', state: 'done', ...(ids ? { backgroundTaskIds: ids } : {}) })

  it('passes every other event through untouched (same reference)', () => {
    const lc = new ClaudeSubagentLifecycle()
    const codex: NormalizedAgentEvent = { nodeId: 'n1', agentId: 'codex', kind: 'subagent-start', toolUseId: 'x' }
    const working: NormalizedAgentEvent = { ...base, kind: 'state', state: 'working' }
    expect(lc.apply(codex)[0]).toBe(codex)
    expect(lc.apply(working)[0]).toBe(working)
  })

  it('isNative is per node AND session: a new session starts from the tool path again', () => {
    const lc = new ClaudeSubagentLifecycle()
    expect(lc.isNative('n1', 's1')).toBe(false)
    lc.apply(nativeStart('a1'))
    expect(lc.isNative('n1', 's1')).toBe(true)
    expect(lc.isNative('n1', 's2')).toBe(false)
    lc.apply(toolStart('t2'))
    expect(lc.apply({ ...toolStart('t3'), sessionId: 's2' })).toHaveLength(1) // shown: s2 is not latched
  })

  it('a tool call that never starts (denied, blocked) draws nothing in a latched session', () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(nativeStart('a1'))
    expect(lc.apply(toolStart('t2'))).toEqual([])
    expect(lc.apply(stop(['a1'])).filter((e) => e.kind === 'subagent-end')).toEqual([])
  })

  it('a card drawn from a tool call before the latch, whose child never started, is ended at the latched Stop', () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(toolStart('t1'))
    lc.apply(toolStart('t2'))
    lc.apply(nativeStart('a1')) // binds t1 (FIFO), latches
    const out = lc.apply(stop(['a1']))
    expect(out.filter((e) => e.kind === 'subagent-end').map((e) => e.toolUseId)).toEqual(['t2'])
  })

  it('an unknown native stop is dropped; a known one ends its card once and re-opens on a new start', () => {
    const lc = new ClaudeSubagentLifecycle()
    expect(lc.apply(nativeEnd('ghost'))).toEqual([])
    lc.apply(nativeStart('a1'))
    expect(lc.apply(nativeEnd('a1'))).toHaveLength(1)
    const reopened = lc.apply(nativeStart('a1'))
    expect(reopened).toHaveLength(1)
    expect(reopened[0].supersedes).toBeUndefined()
  })

  it('a session boundary forgets everything for the node', () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(nativeStart('a1'))
    lc.apply({ ...base, kind: 'session', sessionPhase: 'end' })
    expect(lc.isNative('n1', 's1')).toBe(false)
    expect(lc.apply(nativeEnd('a1'))).toEqual([])
  })

  it('reports every card it ends or replaces, so the shells can stop the transcript tail', () => {
    const released: string[] = []
    const lc = new ClaudeSubagentLifecycle({ onRelease: (id) => released.push(id) })
    lc.apply(toolStart('t1'))
    lc.apply(nativeStart('a1')) // replaces t1
    lc.apply(nativeStart('a2'))
    lc.apply(nativeEnd('a1'))
    lc.apply(stop([])) // a2 no longer listed
    expect(released).toEqual(['t1', 'a1', 'a2'])
  })

  it('a stop with no inventory (older CLI) reconciles nothing', () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(nativeStart('a1'))
    expect(lc.apply(stop())).toHaveLength(1)
  })

  // Review of #1032, probe (a): a CLI with native hooks but no Stop inventory (2.0.43 up to the
  // release that added `background_tasks`). "Every tool call of the turn has resolved by its Stop"
  // does not depend on the inventory, so the waiting labels must be cleared by ANY turn-end Stop.
  it('a denied tool call does not lend its label to a later child, even with no Stop inventory', () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(toolStart('t0'))
    lc.apply(nativeStart('a0')) // latched
    lc.apply(nativeEnd('a0'))
    lc.apply(toolStart('t1')) // denied: its child never starts
    lc.apply(stop()) // older CLI: no inventory
    const labels: Record<string, string | undefined> = {}
    for (const [t, a] of [['t2', 'a2'], ['t3', 'a3']]) {
      lc.apply(toolStart(t))
      const [start] = lc.apply(nativeStart(a))
      labels[a] = start.taskLabel
      lc.apply(nativeEnd(a))
    }
    expect(labels).toEqual({ a2: 'task t2', a3: 'task t3' })
  })

  it('the idle-prompt rescue is not a turn end: a tool call waiting for approval keeps its label', () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(nativeStart('a0'))
    lc.apply(toolStart('t1')) // Agent call held on a permission prompt; the CLI sits idle
    lc.apply({ ...stop(), interrupted: true, idle: true })
    expect(lc.apply(nativeStart('a1'))[0].taskLabel).toBe('task t1')
  })

  // Probe (b): a SubagentStart POST that overtakes its own PreToolUse, for SYNC children (no ack).
  it("a sync end names its child exactly: the child's tool call leaves the queue and a mislabelled sibling is corrected", () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(nativeStart('a0')) // latched
    lc.apply(nativeEnd('a0'))
    expect(lc.apply(nativeStart('a1'))[0].taskLabel).toBeUndefined() // overtook t1
    lc.apply(toolStart('t1'))
    lc.apply(toolStart('t2'))
    expect(lc.apply(nativeStart('a2'))[0].taskLabel).toBe('task t1') // the FIFO guess, wrong
    lc.apply(nativeEnd('a1'))
    const out = lc.apply({ ...base, kind: 'subagent-end', toolUseId: 't1', subagentAgentId: 'a1', subagentSignal: 'tool', tokens: 5 })
    expect(out[0]).toMatchObject({ kind: 'subagent-end', toolUseId: 'a1', tokens: 5 })
    // a2 is still running: it gets its own label back at once, not at the next Stop.
    expect(out.slice(1)).toEqual([expect.objectContaining({ kind: 'subagent-start', toolUseId: 'a2', taskLabel: 'task t2' })])
    // …and nothing of this turn is left to mislabel the next child.
    lc.apply(nativeEnd('a2'))
    lc.apply({ ...base, kind: 'subagent-end', toolUseId: 't2', subagentAgentId: 'a2', subagentSignal: 'tool' })
    lc.apply(toolStart('t3'))
    expect(lc.apply(nativeStart('a3'))[0].taskLabel).toBe('task t3')
  })

  it('a waiting tool call an ack already reserved for another child is not handed out by FIFO', () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(nativeStart('a0'))
    lc.apply(toolStart('t1'))
    lc.apply(toolStart('t2'))
    lc.apply({ ...base, kind: 'state', state: 'working', subagentLaunch: { toolUseId: 't1', agentId: 'a1' } })
    expect(lc.apply(nativeStart('a2'))[0].taskLabel).toBe('task t2')
    expect(lc.apply(nativeStart('a1'))[0].taskLabel).toBe('task t1')
  })

  it('a superseded tool card is also ENDED, after the start that replaces it (an older consumer ignores supersedes)', () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(toolStart('t1'))
    const out = lc.apply(nativeStart('a1'))
    expect(out.map((e) => [e.kind, e.toolUseId, e.supersedes])).toEqual([
      ['subagent-start', 'a1', 't1'],
      ['subagent-end', 't1', undefined]
    ])
  })

  it('stays bounded however many tool calls never start', () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(nativeStart('a0'))
    for (let i = 0; i < 10_000; i++) lc.apply(toolStart(`t${i}`))
    expect(lc.sizeForTest()).toBeLessThan(200)
  })
})

// The agents of Claude Code's `Workflow` tool, over the REAL 2.1.289 capture (fixture:
// src/shared/agents/__fixtures__/claude/workflow-hook-payloads.json). The launch-time `Stop` lists
// the run as ONE `type: 'workflow'` entry, never its agents — so under the plain inventory rule every
// workflow card died milliseconds after it appeared.
describe('ClaudeSubagentLifecycle — Workflow agents', () => {
  const wf = JSON.parse(
    readFileSync(
      path.join(__dirname, '../shared/agents/__fixtures__/claude/workflow-hook-payloads.json'),
      'utf8'
    ).replace(/\r\n/g, '\n')
  ) as { events: Payload[] }
  const ids = wf.events.filter((e) => e.hook_event_name === 'SubagentStart').map((e) => e.agent_id as string)
  const base = { nodeId: 'n1', agentId: 'claude', sessionId: 's1' } as const
  const wfStart = (id: string): NormalizedAgentEvent => ({
    ...base, kind: 'subagent-start', toolUseId: id, subagentType: 'workflow-subagent', subagentSignal: 'native'
  })
  const stop = (taskIds: string[], workflowIds: string[]): NormalizedAgentEvent => ({
    ...base, kind: 'state', state: 'done', backgroundTaskIds: taskIds, backgroundWorkflowIds: workflowIds,
    backgroundSubagentIds: taskIds.filter((t) => !workflowIds.includes(t))
  })

  it('the capture: two agents, no Agent/Task call, a launch-time Stop that lists only the workflow', () => {
    expect(ids).toHaveLength(2)
    expect(wf.events.some((e) => e.tool_name === 'Agent' || e.tool_name === 'Task')).toBe(false)
    const firstStop = wf.events.find((e) => e.hook_event_name === 'Stop')!
    expect((firstStop.background_tasks as Array<{ type: string; id: string }>).map((t) => t.type)).toEqual(['workflow'])
  })

  it('draws a card per agent, keeps both through the launch-time Stop, and ends each exactly once at its own SubagentStop', () => {
    const released: string[] = []
    const lc = new ClaudeSubagentLifecycle({ onRelease: (k) => released.push(k) })
    const stream: NormalizedAgentEvent[] = []
    const releasedAtStop: string[][] = []
    for (const p of wf.events) {
      const e = normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: p })
      if (!e) continue
      const before = released.length
      stream.push(...lc.apply(e))
      if (p.hook_event_name === 'Stop') releasedAtStop.push(released.slice(before))
    }
    const starts = stream.filter((e) => e.kind === 'subagent-start')
    expect(starts.map((e) => e.toolUseId)).toEqual(ids)
    expect(starts.every((e) => e.subagentType === 'workflow-subagent' && !e.supersedes)).toBe(true)
    const ends = stream.filter((e) => e.kind === 'subagent-end' && ids.includes(e.toolUseId!))
    expect(ends.map((e) => e.toolUseId).sort()).toEqual([...ids].sort())
    // Each end is the SubagentStop's own (the launch-time Stop released nothing).
    expect(releasedAtStop[0]).toEqual([])
    expect(released.sort()).toEqual([...ids].sort())
    // Both still working right after the launch-time Stop.
    const firstStopIdx = wf.events.findIndex((p) => p.hook_event_name === 'Stop')
    const lc2 = new ClaudeSubagentLifecycle()
    const live = new Map<string, boolean>()
    for (const p of wf.events.slice(0, firstStopIdx + 1)) {
      const e = normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: p })
      if (!e) continue
      for (const o of lc2.apply(e)) {
        if (o.kind === 'subagent-start') live.set(o.toolUseId!, true)
        if (o.kind === 'subagent-end') live.set(o.toolUseId!, false)
      }
    }
    expect([...live.values()]).toEqual([true, true])
  })

  it('a later Stop with no live workflow reaps a workflow card whose stop never came (killed)', () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(wfStart('a1'))
    expect(lc.apply(stop(['wjf1'], ['wjf1'])).filter((e) => e.kind === 'subagent-end')).toEqual([])
    const out = lc.apply(stop([], []))
    expect(out.filter((e) => e.kind === 'subagent-end').map((e) => e.toolUseId)).toEqual(['a1'])
  })

  it('a regular async subagent (bound to its Agent call) missing from the inventory is still ended while a workflow is live', () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(wfStart('w1'))
    lc.apply({ ...base, kind: 'subagent-start', toolUseId: 't1', subagentType: 'general-purpose', taskLabel: 'x', subagentSignal: 'tool' })
    lc.apply({ ...base, kind: 'subagent-start', toolUseId: 'a1', subagentType: 'general-purpose', subagentSignal: 'native' })
    const out = lc.apply(stop(['wjf1'], ['wjf1']))
    expect(out.filter((e) => e.kind === 'subagent-end').map((e) => e.toolUseId)).toEqual(['a1'])
  })

  it('a workflow agent run under another agentType survives the launch-time Stop (fixture, agent_type rewritten)', () => {
    const released: string[] = []
    const lc = new ClaudeSubagentLifecycle({ onRelease: (k) => released.push(k) })
    const stream: NormalizedAgentEvent[] = []
    let releasedAtFirstStop: string[] | undefined
    for (const raw of wf.events) {
      const p = raw.agent_type === 'workflow-subagent' ? { ...raw, agent_type: 'general-purpose' } : raw
      const e = normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: p })
      if (!e) continue
      const before = released.length
      stream.push(...lc.apply(e))
      if (p.hook_event_name === 'Stop' && !releasedAtFirstStop) releasedAtFirstStop = released.slice(before)
    }
    expect(releasedAtFirstStop).toEqual([])
    const ends = stream.filter((e) => e.kind === 'subagent-end' && ids.includes(e.toolUseId!))
    expect(ends.map((e) => e.toolUseId).sort()).toEqual([...ids].sort())
    expect(released.sort()).toEqual([...ids].sort())
  })

  it("a workflow agent's nested (never bound) child survives a parent Stop while the run is live, and is reaped once it is not", () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(wfStart('w1'))
    lc.apply({ ...base, kind: 'subagent-start', toolUseId: 'n1c', subagentType: 'Explore', subagentSignal: 'native' })
    expect(lc.apply(stop(['wjf1'], ['wjf1'])).filter((e) => e.kind === 'subagent-end')).toEqual([])
    expect(lc.apply(stop([], [])).filter((e) => e.kind === 'subagent-end').map((e) => e.toolUseId).sort()).toEqual(['n1c', 'w1'])
  })

  it('markWorkflow: sticky, and a call taken before anyone knew goes to the sibling it was meant for', () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(wfStart('w0')) // latches the session
    lc.apply({ ...base, kind: 'subagent-start', toolUseId: 't1', subagentType: 'general-purpose', taskLabel: 'task t1', subagentSignal: 'tool' })
    // A workflow agent run as `general-purpose` starts first and takes the call (nothing can tell yet)…
    expect(lc.apply({ ...base, kind: 'subagent-start', toolUseId: 'wg', subagentType: 'general-purpose', subagentSignal: 'native' })[0].taskLabel).toBe('task t1')
    // …the real child then starts unlabelled.
    expect(lc.apply({ ...base, kind: 'subagent-start', toolUseId: 'a1', subagentType: 'general-purpose', subagentSignal: 'native' })[0].taskLabel).toBeUndefined()
    // The tail finds wg under subagents/workflows/: the label moves to a1.
    const out = lc.markWorkflow('n1', 's1', 'wg')
    expect(out.map((e) => [e.toolUseId, e.taskLabel])).toEqual([['wg', undefined], ['a1', 'task t1']])
    // Sticky: a Stop listing the live workflow spares wg, a bound a1 not listed is ended.
    const ends = lc.apply(stop(['wjf1'], ['wjf1'])).filter((e) => e.kind === 'subagent-end').map((e) => e.toolUseId)
    expect(ends).toEqual(['a1'])
    expect(lc.markWorkflow('n1', 's2', 'wg')).toEqual([])
    expect(lc.markWorkflow('n1', 's1', 'nobody')).toEqual([])
  })

  it('markWorkflow with no sibling to give it to: the call goes back to the queue for its own child', () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(wfStart('w0'))
    lc.apply({ ...base, kind: 'subagent-start', toolUseId: 't1', subagentType: 'general-purpose', taskLabel: 'task t1', subagentSignal: 'tool' })
    lc.apply({ ...base, kind: 'subagent-start', toolUseId: 'wg', subagentType: 'general-purpose', subagentSignal: 'native' })
    expect(lc.markWorkflow('n1', 's1', 'wg').map((e) => [e.toolUseId, e.taskLabel])).toEqual([['wg', undefined]])
    expect(lc.apply({ ...base, kind: 'subagent-start', toolUseId: 'a1', subagentType: 'general-purpose', subagentSignal: 'native' })[0].taskLabel).toBe('task t1')
  })

  it('a workflow card does not take a waiting Agent label; the real child still gets it', () => {
    const lc = new ClaudeSubagentLifecycle()
    lc.apply(wfStart('w0')) // latches the session
    // An Agent call with no `subagent_type` (the CLI's default) is the one FIFO hands to any type.
    lc.apply({ ...base, kind: 'subagent-start', toolUseId: 't1', taskLabel: 'task t1', subagentSignal: 'tool' })
    const wfOut = lc.apply(wfStart('w1'))
    expect(wfOut[0].taskLabel).toBeUndefined()
    const real = lc.apply({ ...base, kind: 'subagent-start', toolUseId: 'a1', subagentType: 'general-purpose', subagentSignal: 'native' })
    expect(real[0].taskLabel).toBe('task t1')
  })

  it('labelNative: a corrective start only for an existing, working, unlabelled card of this session', () => {
    const lc = new ClaudeSubagentLifecycle()
    expect(lc.labelNative('n1', 's1', 'w1', 'read-a')).toEqual([])
    lc.apply(wfStart('w1'))
    expect(lc.labelNative('n1', 's2', 'w1', 'read-a')).toEqual([])
    const out = lc.labelNative('n1', 's1', 'w1', 'read-a‮\u0007 x')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'subagent-start', toolUseId: 'w1', taskLabel: 'read-a x', subagentSignal: 'native' })
    // Fed back through apply (the shells' ordinary path): the same working card, label kept.
    expect(lc.apply(out[0])[0]).toMatchObject({ kind: 'subagent-start', toolUseId: 'w1', taskLabel: 'read-a x' })
    expect(lc.labelNative('n1', 's1', 'w1', 'other')).toEqual([]) // already labelled
    lc.apply({ ...base, kind: 'subagent-end', toolUseId: 'w1', subagentSignal: 'native' })
    lc.apply(wfStart('w2'))
    lc.apply({ ...base, kind: 'subagent-end', toolUseId: 'w2', subagentSignal: 'native' })
    expect(lc.labelNative('n1', 's1', 'w2', 'late')).toEqual([]) // no longer working
    expect(lc.labelNative('n1', 's1', 'w2', '   ')).toEqual([])
  })
})
