// FIXTURE PROVENANCE: `__fixtures__/claude/workflow-hook-payloads.json` was captured live from Claude
// Code 2.1.289 (darwin-arm64) on 2026-10-06 in print mode, with capture hooks in a throwaway
// project; the prompt asked for a `Workflow` tool run of two parallel agents. Paths and the session
// id are redacted; agent ids, tool_use ids, keys and shapes are unchanged (see its `_provenance`).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { normalizeClaude } from './normalize'
import {
  CLAUDE_WORKFLOW_AGENT_TYPE,
  claudeSubagentTranscriptPath,
  claudeWorkflowAgentTranscriptPath,
  labelFromSubagentMeta
} from './claude-subagents'

type Payload = Record<string, unknown>
const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '__fixtures__/claude/workflow-hook-payloads.json'), 'utf8').replace(/\r\n/g, '\n')
) as { events: Payload[]; childMetaJson_a695a36b6f4558935: unknown }
const ev = fixture.events
const norm = (p: Payload) => normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: p })

describe('the Workflow capture (facts the design rests on)', () => {
  it('each workflow agent fires native SubagentStart/Stop typed workflow-subagent, with the PARENT session', () => {
    const native = ev.filter((e) => e.hook_event_name === 'SubagentStart' || e.hook_event_name === 'SubagentStop')
    expect(native).toHaveLength(4)
    for (const e of native) {
      expect(e.agent_type).toBe(CLAUDE_WORKFLOW_AGENT_TYPE)
      expect(e.session_id).toBe(ev[0].session_id)
      expect(e.transcript_path).toBe(ev[0].transcript_path)
    }
  })

  it('the agent transcript lives under subagents/workflows/<runId>/, NOT the flat subagents/ path', () => {
    const launch = ev.find((e) => e.hook_event_name === 'PostToolUse' && e.tool_name === 'Workflow')!
    const runId = (launch.tool_response as { runId: string }).runId
    for (const e of ev.filter((x) => x.hook_event_name === 'SubagentStop')) {
      const parent = e.transcript_path as string
      const id = e.agent_id as string
      expect(e.agent_transcript_path).toBe(claudeWorkflowAgentTranscriptPath(parent, runId, id))
      expect(e.agent_transcript_path).not.toBe(claudeSubagentTranscriptPath(parent, id))
    }
  })

  it("the agent's meta.json description is the agent() label", () => {
    expect(labelFromSubagentMeta(JSON.stringify(fixture.childMetaJson_a695a36b6f4558935))).toBe('read-a')
  })
})

describe('normalizeClaude over the Workflow capture', () => {
  it('workflow agents normalize as native subagent starts/ends keyed by agent_id', () => {
    const starts = ev.filter((e) => e.hook_event_name === 'SubagentStart').map(norm)
    for (const s of starts) {
      expect(s).toMatchObject({ kind: 'subagent-start', subagentSignal: 'native', subagentType: 'workflow-subagent' })
    }
  })

  it("the agents' own tool events stay filtered (they must not drive the parent)", () => {
    const child = ev.filter((e) => e.agent_id && (e.hook_event_name === 'PreToolUse' || e.hook_event_name === 'PostToolUse'))
    expect(child.length).toBeGreaterThan(0)
    for (const e of child) expect(norm(e)).toBeNull()
  })

  it('the launch-time Stop reports the running workflow in backgroundWorkflowIds, not as a subagent', () => {
    const [first, last] = ev.filter((e) => e.hook_event_name === 'Stop').map(norm)
    expect(first).toMatchObject({
      kind: 'state',
      state: 'done',
      backgroundTaskIds: ['wjf20hftg'],
      backgroundSubagentIds: [],
      backgroundWorkflowIds: ['wjf20hftg']
    })
    expect(last).toMatchObject({ backgroundTaskIds: [], backgroundSubagentIds: [], backgroundWorkflowIds: [] })
  })

  it('a Stop without the inventory says nothing about workflows either', () => {
    const { background_tasks: _drop, ...rest } = ev.find((e) => e.hook_event_name === 'Stop')!
    const e = norm(rest)!
    expect('backgroundTaskIds' in e).toBe(false)
    expect('backgroundWorkflowIds' in e).toBe(false)
  })

  it('the completion task-notification is not a genuine new turn', () => {
    const n = ev.find((e) => e.hook_event_name === 'UserPromptSubmit' && String(e.prompt).startsWith('<task-notification>'))!
    expect(norm(n)?.newTurn).toBeUndefined()
  })
})
