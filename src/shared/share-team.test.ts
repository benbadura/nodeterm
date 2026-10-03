import { describe, it, expect } from 'vitest'
import { parseResumeSessions, RESUME_MAX_SESSIONS, sharePlan, SHARE_REFUSAL, type ShareProbe } from './share-team'

describe('parseResumeSessions', () => {
  it('accepts a list of entries and keeps only the known string fields', () => {
    expect(parseResumeSessions([{ nodeId: 'term-1', agentId: 'claude', sessionId: 's-1', permissionMode: 'auto', extra: 1 }])).toEqual([
      { nodeId: 'term-1', agentId: 'claude', sessionId: 's-1', permissionMode: 'auto' }
    ])
  })
  it('refuses a non-array, a malformed entry, oversize fields and too many entries', () => {
    expect(parseResumeSessions({})).toMatch(/list/)
    expect(parseResumeSessions([{ nodeId: 'a' }])).toMatch(/entry 0/)
    expect(parseResumeSessions([{ nodeId: 'a'.repeat(129), agentId: 'claude', sessionId: 's' }])).toMatch(/entry 0/)
    expect(parseResumeSessions([{ nodeId: 'a', agentId: 'claude', sessionId: 's', permissionMode: 7 }])).toMatch(/entry 0/)
    const many = Array.from({ length: RESUME_MAX_SESSIONS + 1 }, (_, i) => ({ nodeId: `n${i}`, agentId: 'claude', sessionId: 's' }))
    expect(parseResumeSessions(many)).toMatch(/at most/)
  })
})

const probe = (o: Partial<ShareProbe> = {}): ShareProbe => ({
  os: 'Linux', uid: 1000, user: 'u', home: '/home/u', have: { git: true, curl: true }, unit: 'user',
  node: '/usr/bin/node', main: '/home/u/.nodeterm-server-app/out/server/main.cjs', dataDir: '/home/u/.nodeterm-server',
  meta: { version: '0.4.0', commit: 'abc' }, hasBootstrap: true, statusRc: 0, teamExists: false,
  adoptCwd: '/home/u/proj', homeReal: '/home/u', panes: [], ...o
})

describe('sharePlan', () => {
  it('ready when installed, new enough and answering', () => expect(sharePlan(probe())).toEqual({ kind: 'ready' }))
  it('refusals come first, in this order: non-Linux, root, system install, missing folder', () => {
    expect(sharePlan(probe({ os: 'Darwin', uid: 0 }))).toEqual({ kind: 'refuse', reason: SHARE_REFUSAL.nonLinux })
    expect(sharePlan(probe({ uid: 0, unit: 'system' }))).toEqual({ kind: 'refuse', reason: SHARE_REFUSAL.root })
    expect(sharePlan(probe({ unit: 'system' }))).toEqual({ kind: 'refuse', reason: SHARE_REFUSAL.system })
    expect(sharePlan(probe({ adoptCwd: null }))).toEqual({ kind: 'refuse', reason: SHARE_REFUSAL.noFolder })
  })
  it('never shares the home directory, the root, or a folder that contains the home directory', () => {
    // Viewers may read any file under a shared folder: ~/.ssh, agent credentials, hook tokens.
    expect(sharePlan(probe({ adoptCwd: '/home/u' }))).toEqual({ kind: 'refuse', reason: SHARE_REFUSAL.homeFolder })
    expect(sharePlan(probe({ adoptCwd: '/' }))).toEqual({ kind: 'refuse', reason: SHARE_REFUSAL.homeAncestor })
    expect(sharePlan(probe({ adoptCwd: '/home' }))).toEqual({ kind: 'refuse', reason: SHARE_REFUSAL.homeAncestor })
    // Segment-wise: a sibling whose name merely starts with the home's is not an ancestor.
    expect(sharePlan(probe({ adoptCwd: '/home/u2', homeReal: '/home/u2x' }))).toEqual({ kind: 'ready' })
    expect(sharePlan(probe({ adoptCwd: '/home/u/proj/sub' }))).toEqual({ kind: 'ready' })
    // Before the installer runs too: a host we would refuse is not worth minutes of install.
    expect(sharePlan(probe({ adoptCwd: '/home/u', unit: 'none', node: '', main: '' }))).toEqual({
      kind: 'refuse', reason: SHARE_REFUSAL.homeFolder
    })
  })
  it('a home directory the probe could not read is a refusal, never a guess', () => {
    expect(sharePlan(probe({ homeReal: null }))).toEqual({ kind: 'refuse', reason: SHARE_REFUSAL.homeUnknown })
  })
  it('install when missing, outdated (no bootstrap verb) or not running', () => {
    expect(sharePlan(probe({ unit: 'none', node: '', main: '' }))).toEqual({ kind: 'install', reason: 'missing' })
    expect(sharePlan(probe({ hasBootstrap: false }))).toEqual({ kind: 'install', reason: 'outdated' })
    expect(sharePlan(probe({ statusRc: 1 }))).toEqual({ kind: 'install', reason: 'not-running' })
  })
  it('an install that needs git or curl the host lacks is a refusal naming them', () => {
    expect(sharePlan(probe({ unit: 'none', node: '', main: '', have: { git: false, curl: false } }))).toEqual({
      kind: 'refuse', reason: 'Installing nodeterm-server needs git and curl on the host (missing: git, curl).'
    })
    expect(sharePlan(probe({ have: { git: false, curl: true } }))).toEqual({ kind: 'ready' }) // a ready host needs neither
  })
})
