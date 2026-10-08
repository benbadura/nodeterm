import { describe, expect, it } from 'vitest'
import {
  claudeSubagentMetaPath,
  claudeSubagentTranscriptPath,
  claudeWorkflowAgentTranscriptPath,
  claudeWorkflowsDir,
  labelFromSubagentMeta,
  liveBackgroundSubagentIds,
  liveBackgroundWorkflowIds,
  sanitizeSubagentLabel,
  SUBAGENT_LABEL_MAX
} from './claude-subagents'

const parent = '/home/u/.claude/projects/-w/s1.jsonl'

describe('workflow transcript locators', () => {
  it('derive the workflows dir and a run agent path beside the flat subagents path', () => {
    expect(claudeSubagentTranscriptPath(parent, 'a1')).toBe('/home/u/.claude/projects/-w/s1/subagents/agent-a1.jsonl')
    expect(claudeWorkflowsDir(parent)).toBe('/home/u/.claude/projects/-w/s1/subagents/workflows')
    expect(claudeWorkflowAgentTranscriptPath(parent, 'wf_5b923257-98d', 'a1')).toBe(
      '/home/u/.claude/projects/-w/s1/subagents/workflows/wf_5b923257-98d/agent-a1.jsonl'
    )
  })

  it('keep a Windows path in its own separator', () => {
    const win = 'C:\\Users\\u\\.claude\\projects\\w\\s1.jsonl'
    expect(claudeWorkflowsDir(win)).toBe('C:\\Users\\u\\.claude\\projects\\w\\s1\\subagents\\workflows')
    expect(claudeWorkflowAgentTranscriptPath(win, 'wf_1', 'a1')).toBe(
      'C:\\Users\\u\\.claude\\projects\\w\\s1\\subagents\\workflows\\wf_1\\agent-a1.jsonl'
    )
  })

  it('refuse unsafe ids and non-transcript parents', () => {
    expect(claudeWorkflowsDir('/x/notes.txt')).toBeUndefined()
    expect(claudeWorkflowAgentTranscriptPath(parent, '../x', 'a1')).toBeUndefined()
    expect(claudeWorkflowAgentTranscriptPath(parent, 'wf_1', 'a/../b')).toBeUndefined()
    expect(claudeSubagentTranscriptPath(parent, '..')).toBeUndefined()
  })

  it('the meta path is the .meta.json sibling', () => {
    expect(claudeSubagentMetaPath('/d/agent-a1.jsonl')).toBe('/d/agent-a1.meta.json')
    expect(claudeSubagentMetaPath('/d/agent-a1.txt')).toBeUndefined()
  })
})

describe('liveBackgroundWorkflowIds', () => {
  it('is the live workflow subset, and undefined with no inventory', () => {
    expect(liveBackgroundWorkflowIds(undefined)).toBeUndefined()
    const inv = [
      { id: 'w1', type: 'workflow', status: 'running' },
      { id: 'w2', type: 'workflow', status: 'completed' },
      { id: 'a1', type: 'subagent', status: 'running' },
      { id: 'w3', type: 'workflow', status: 'something-new' },
      { id: 'w1', type: 'workflow', status: 'running' }
    ]
    expect(liveBackgroundWorkflowIds(inv)).toEqual(['w1', 'w3'])
    expect(liveBackgroundSubagentIds(inv)).toEqual(['a1'])
    expect(liveBackgroundWorkflowIds([])).toEqual([])
  })
})

describe('sanitizeSubagentLabel', () => {
  it('keeps one clean line', () => {
    expect(sanitizeSubagentLabel('  read-a\n\tnext ')).toBe('read-a next')
  })
  it('strips C0/C1, bidi and zero-width controls', () => {
    expect(sanitizeSubagentLabel('a\u0007b\u009bc\u202ed\u200be\u2066f\ufeff')).toBe('a b cdef')
  })
  it('strips every other format control too (U+061C, soft hyphen, U+180E, U+FFF9–FFFB, tags), keeping ZWJ', () => {
    expect(sanitizeSubagentLabel('a\u061cb\u00adc\u180ed\ufff9e\ufffbf\u{e0041}g')).toBe('abcdefg')
    expect(sanitizeSubagentLabel('👨\u200d💻 dev')).toBe('👨\u200d💻 dev')
  })
  it('caps by code point', () => {
    const out = sanitizeSubagentLabel('😀'.repeat(500))!
    expect([...out]).toHaveLength(SUBAGENT_LABEL_MAX)
    expect(out.endsWith('…')).toBe(true)
  })
  it('refuses non-strings and empty results', () => {
    expect(sanitizeSubagentLabel(5)).toBeUndefined()
    expect(sanitizeSubagentLabel('\u200b \u0001')).toBeUndefined()
  })
  it('labelFromSubagentMeta reads the description, and nothing from junk', () => {
    expect(labelFromSubagentMeta('{"description":"read-a"}')).toBe('read-a')
    expect(labelFromSubagentMeta('{"description":7}')).toBeUndefined()
    expect(labelFromSubagentMeta('not json')).toBeUndefined()
    expect(labelFromSubagentMeta('null')).toBeUndefined()
  })
})
