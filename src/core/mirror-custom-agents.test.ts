import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { mirrorCustomAgents } from './mirror-custom-agents'
import { buildFile, filterMirrorForNodes } from './agent-status-mirror'
import { binariesFor } from '@shared/agents/pane-owner-predicate'
import type { CustomAgent } from '@shared/types'

const SECRET = 'sk-ant-SECRET-123'

const agents: CustomAgent[] = [
  {
    id: 'custom:proxy',
    label: 'Proxy Claude',
    launchCmd: '',
    baseAgent: 'claude',
    env: { ANTHROPIC_AUTH_TOKEN: SECRET, ANTHROPIC_BASE_URL: 'https://proxy.example' },
    args: `--api-key ${SECRET}`
  },
  { id: 'custom:npx', label: 'NPX agent', launchCmd: `ANTHROPIC_API_KEY=${SECRET} npx -y @acme/my-agent@1.2.3 --token ${SECRET}` },
  { id: 'custom:shell', label: 'Shell wrapped', launchCmd: `bash -lc "TOKEN=${SECRET} run-me"`, baseAgent: 'codex' },
  { id: 'custom:bin', label: 'Plain', launchCmd: '/opt/bin/aider --model x', baseAgent: 'grok' }
]

describe('mirrorCustomAgents', () => {
  it('derives binaries with the SAME logic as the pane-owner predicate', () => {
    const out = mirrorCustomAgents(agents)
    for (const a of agents) {
      const row = out.find((r) => r.id === a.id)!
      expect(row.binaries).toEqual([...(binariesFor(a.id, agents) ?? [])])
    }
    expect(out.map((r) => [r.id, r.binaries])).toEqual([
      ['custom:proxy', ['claude']],
      ['custom:npx', ['my-agent']],
      ['custom:shell', []], // unnameable ⇒ empty ⇒ the phone refuses, never guesses
      ['custom:bin', ['aider']]
    ])
  })

  it('carries id, label and a valid baseAgent — and nothing else', () => {
    const out = mirrorCustomAgents(agents)
    expect(out[0]).toEqual({ id: 'custom:proxy', label: 'Proxy Claude', baseAgent: 'claude', binaries: ['claude'] })
    expect(out[1]).toEqual({ id: 'custom:npx', label: 'NPX agent', binaries: ['my-agent'] })
    for (const row of out) expect(Object.keys(row).sort()).toEqual(
      row.baseAgent ? ['baseAgent', 'binaries', 'id', 'label'] : ['binaries', 'id', 'label']
    )
  })

  it('never leaks a raw launch command, args or env into the mirror file', () => {
    const doc = buildFile({}, 1000, undefined, { customAgents: mirrorCustomAgents(agents) })
    const json = JSON.stringify(doc)
    expect(json).not.toContain(SECRET)
    expect(json).not.toContain('proxy.example')
    expect(json).not.toContain('launchCmd')
    expect(json).not.toContain('"env"')
    expect(json).not.toContain('"args"')
    expect(json).not.toContain('npx -y')
    expect(json).not.toContain('@acme')
    expect(json).not.toContain('/opt/bin')
    expect(doc.settings?.customAgents?.length).toBe(4)
  })

  it('publishes [] for a derived name outside the plain alphabet — a URL/credential/quote/template never ships', () => {
    const risky: CustomAgent[] = [
      { id: 'custom:uvx', label: 'a', launchCmd: 'uvx --from git+https://oauth2:ghp_SECRET123@github.com agent' },
      { id: 'custom:url', label: 'b', launchCmd: 'https://user:TOKEN@host' },
      { id: 'custom:quote', label: 'c', launchCmd: 'API_KEY="sk-ant-a sk-ant-b" my-agent' },
      { id: 'custom:tmpl', label: 'd', launchCmd: '${env:AGENT_BIN} --x' },
      { id: 'custom:long', label: 'e', launchCmd: 'x'.repeat(65) }
    ]
    const out = mirrorCustomAgents(risky)
    expect(out.map((r) => r.binaries)).toEqual([[], [], [], [], []])
    const json = JSON.stringify(buildFile({}, 1000, undefined, { customAgents: out }))
    for (const leak of ['SECRET', 'TOKEN', 'ghp_', 'oauth2', 'sk-ant', 'AGENT_BIN', '${env'])
      expect(json).not.toContain(leak)
  })

  it('publishes [] for a name shaped like a credential, even inside the plain alphabet', () => {
    // A runner option VALUE before the program can be taken as the program:
    // `npx --registry-token ghp_… my-agent` names the token. The alphabet cannot catch that.
    const tok36 = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    const shaped = [
      `ghp_${tok36}`, `gho_${tok36}`, `ghu_${tok36}`, `ghs_${tok36}`, `ghr_${tok36}`,
      'github_pat_11ABCDEF', 'AIzaSyD-short', 'sk-proj-abc', 'xai-abc123', 'glpat-abc123',
      tok36 // no prefix, ≥32 chars, letters + digits: high-entropy
    ]
    const agents: CustomAgent[] = shaped.map((t, i) => ({
      id: `custom:t${i}`, label: 'x', launchCmd: `npx --registry-token ${t} my-agent`
    }))
    const out = mirrorCustomAgents(agents)
    expect(out.map((r) => r.binaries)).toEqual(shaped.map(() => []))
    const json = JSON.stringify(buildFile({}, 1000, undefined, { customAgents: out }))
    for (const t of shaped) expect(json).not.toContain(t)
  })

  it('keeps ordinary long names that do not look like a token', () => {
    const agents: CustomAgent[] = [
      { id: 'custom:a', label: 'a', launchCmd: 'my-very-long-descriptive-agent-cli-name' }, // no digits
      { id: 'custom:b', label: 'b', launchCmd: 'agent2' }
    ]
    expect(mirrorCustomAgents(agents).map((r) => r.binaries)).toEqual([
      ['my-very-long-descriptive-agent-cli-name'],
      ['agent2']
    ])
  })

  it('drops malformed records and non-custom ids, and a baseAgent that is not a builtin', () => {
    const junk = [
      null,
      { id: 'claude', label: 'Hijack', launchCmd: 'claude' },
      { id: 42, label: 'x', launchCmd: 'y' },
      { id: 'custom:ok', label: 7, launchCmd: 'ok-agent', baseAgent: 'constructor' },
      { id: 'custom:ok2', launchCmd: 'ok2' }
    ] as unknown as CustomAgent[]
    expect(mirrorCustomAgents(junk)).toEqual([
      { id: 'custom:ok', label: 'custom:ok', binaries: ['ok-agent'] },
      { id: 'custom:ok2', label: 'custom:ok2', binaries: ['ok2'] }
    ])
    expect(mirrorCustomAgents(undefined)).toEqual([])
  })

  it('is stripped from slices by filterMirrorForNodes like every settings field (the slice gets its own)', () => {
    const doc = buildFile({}, 1000, undefined, { customAgents: mirrorCustomAgents(agents) })
    expect('settings' in filterMirrorForNodes(doc, new Set())).toBe(false)
  })

  // Every surface the phone reads the mirror from: the local file (main + Server Edition providers,
  // which is also what relay `projects.list` serves) and the per-SSH-project slice (`settingsFor`).
  it('is wired into every settings provider', () => {
    const root = path.resolve(__dirname, '..')
    const main = fs.readFileSync(path.join(root, 'main/index.ts'), 'utf8')
    const server = fs.readFileSync(path.join(root, 'server/index.ts'), 'utf8')
    expect(main.match(/customAgents: mirrorCustomAgents\(/g)?.length).toBe(2)
    expect(server.match(/customAgents: mirrorCustomAgents\(/g)?.length).toBe(1)
  })
})
