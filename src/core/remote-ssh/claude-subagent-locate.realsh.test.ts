// The generated locate command (claude-subagent-locate.ts), executed by a REAL /bin/sh against a
// fake host tree. It is generated shell no compiler checks: an unquoted glob, a parameter expansion
// and a bounded meta read are exactly the parts that only running it can prove.
import { describe, expect, it, beforeAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { testTmpDir } from '../test-tmp'
import {
  parseRemoteSubagentLocate,
  remoteSubagentLocateCommand,
  remoteSubagentMetaCommand,
  SUBAGENT_META_READ_MAX
} from './claude-subagent-locate'

let root: string
let parent: string
let subs: string

const run = (cmd: string): string => execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' })

beforeAll(() => {
  if (process.platform === 'win32') return
  // A space and a quote in the path: everything but the id and the glob is quoted.
  root = path.join(testTmpDir('ntsublocate-'), "home dir's")
  parent = path.join(root, '.claude', 'projects', '-w', 's1.jsonl')
  subs = path.join(root, '.claude', 'projects', '-w', 's1', 'subagents')
  fs.mkdirSync(path.join(subs, 'workflows', 'wf_5b923257-98d'), { recursive: true })
  fs.mkdirSync(path.join(subs, 'workflows', 'wf_other'), { recursive: true })
  fs.writeFileSync(path.join(subs, 'agent-aflat.jsonl'), '{}\n')
  fs.writeFileSync(path.join(subs, 'workflows', 'wf_5b923257-98d', 'agent-awf.jsonl'), '{}\n')
  fs.writeFileSync(
    path.join(subs, 'workflows', 'wf_5b923257-98d', 'agent-awf.meta.json'),
    JSON.stringify({ agentType: 'workflow-subagent', description: 'read-a' })
  )
  fs.writeFileSync(path.join(subs, 'workflows', 'wf_other', 'agent-another.jsonl'), '{}\n')
})

// /bin/sh is POSIX-only; the command only ever runs on an SSH host.
describe.skipIf(process.platform === 'win32')('remoteSubagentLocateCommand (real /bin/sh)', () => {
  it('finds a Workflow agent under its run directory and returns its meta label', () => {
    const out = run(remoteSubagentLocateCommand(parent, 'awf')!)
    expect(parseRemoteSubagentLocate(out, parent, 'awf')).toEqual({
      path: path.join(subs, 'workflows', 'wf_5b923257-98d', 'agent-awf.jsonl'),
      workflow: true,
      label: 'read-a'
    })
  })

  it('prefers the flat path for an Agent/Task child (no meta → no label)', () => {
    const out = run(remoteSubagentLocateCommand(parent, 'aflat')!)
    expect(parseRemoteSubagentLocate(out, parent, 'aflat')).toEqual({
      path: path.join(subs, 'agent-aflat.jsonl'),
      workflow: false
    })
  })

  it('a clean miss prints nothing and exits 0 (an unmatched glob is not a file)', () => {
    expect(run(remoteSubagentLocateCommand(parent, 'anobody')!)).toBe('')
    expect(parseRemoteSubagentLocate('', parent, 'anobody')).toBeUndefined()
  })

  it('a parent with no subagents directory at all is a clean miss too', () => {
    expect(run(remoteSubagentLocateCommand(path.join(root, 'none.jsonl'), 'awf')!)).toBe('')
  })

  it('reads at most SUBAGENT_META_READ_MAX bytes of a meta', () => {
    const big = path.join(subs, 'workflows', 'wf_other', 'agent-another.meta.json')
    fs.writeFileSync(big, 'x'.repeat(SUBAGENT_META_READ_MAX * 3))
    const out = run(remoteSubagentLocateCommand(parent, 'another')!)
    expect(out.length).toBeLessThanOrEqual(SUBAGENT_META_READ_MAX + 400)
    expect(parseRemoteSubagentLocate(out, parent, 'another')?.label).toBeUndefined()
  })

  it('the follow-up meta read: a meta that lands after the transcript is read on a later ask', () => {
    const dir = path.join(subs, 'workflows', 'wf_late')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'agent-alate.jsonl'), '{}\n')
    const found = parseRemoteSubagentLocate(run(remoteSubagentLocateCommand(parent, 'alate')!), parent, 'alate')!
    expect(found).toEqual({ path: path.join(dir, 'agent-alate.jsonl'), workflow: true })
    const meta = remoteSubagentMetaCommand(found)!
    expect(run(meta)).toBe('') // not there yet: a clean miss
    fs.writeFileSync(path.join(dir, 'agent-alate.meta.json'), JSON.stringify({ description: 'late label' }))
    expect(run(meta)).toBe(JSON.stringify({ description: 'late label' }))
  })

  it('refuses an unsafe id or a non-transcript parent before building any shell', () => {
    expect(remoteSubagentLocateCommand(parent, 'a;rm -rf /')).toBeUndefined()
    expect(remoteSubagentLocateCommand(parent, '../x')).toBeUndefined()
    expect(remoteSubagentLocateCommand('/x/notes.txt', 'a1')).toBeUndefined()
  })
})

describe('parseRemoteSubagentLocate (the host answer is jailed)', () => {
  const p = '/h/.claude/projects/-w/s1.jsonl'
  it('accepts only the two layouts for THIS id under THIS parent', () => {
    expect(parseRemoteSubagentLocate('/h/.claude/projects/-w/s1/subagents/agent-a1.jsonl\n', p, 'a1')?.path).toBe(
      '/h/.claude/projects/-w/s1/subagents/agent-a1.jsonl'
    )
    expect(
      parseRemoteSubagentLocate('/h/.claude/projects/-w/s1/subagents/workflows/wf_1/agent-a1.jsonl\n', p, 'a1')?.path
    ).toBe('/h/.claude/projects/-w/s1/subagents/workflows/wf_1/agent-a1.jsonl')
  })
  it('refuses another id, another parent, a traversal or an extra level', () => {
    for (const bad of [
      '/h/.claude/projects/-w/s1/subagents/agent-a2.jsonl',
      '/h/.claude/projects/-w/s2/subagents/agent-a1.jsonl',
      '/h/.claude/projects/-w/s1/subagents/workflows/../agent-a1.jsonl',
      '/h/.claude/projects/-w/s1/subagents/workflows/wf_1/x/agent-a1.jsonl',
      '/etc/passwd'
    ]) {
      expect(parseRemoteSubagentLocate(`${bad}\n`, p, 'a1')).toBeUndefined()
    }
  })
})
