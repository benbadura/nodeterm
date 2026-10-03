import { describe, it, expect } from 'vitest'
import { expandHomeCwd, localizeAdoptedNode } from './adopt-cwd'
import type { CanvasNodeState } from './types'

const node = (o: Partial<CanvasNodeState>): CanvasNodeState =>
  ({ id: 'term-1', kind: 'terminal', position: { x: 0, y: 0 }, title: 'T', color: '#fff', ...o }) as CanvasNodeState

describe('expandHomeCwd', () => {
  it('expands ~ and ~/x against home, leaves everything else alone', () => {
    expect(expandHomeCwd('~', '/home/u')).toBe('/home/u')
    expect(expandHomeCwd('~/p/x', '/home/u')).toBe('/home/u/p/x')
    expect(expandHomeCwd('~/', '/home/u')).toBe('/home/u')
    expect(expandHomeCwd('/srv/x', '/home/u')).toBe('/srv/x')
    expect(expandHomeCwd('~other/x', '/home/u')).toBe('~other/x') // another user's home is not ours to guess
    expect(expandHomeCwd('./rel', '/home/u')).toBe('./rel')
  })
})

describe('localizeAdoptedNode', () => {
  it('drops the SSH-session flags so a local core spawns it locally, and expands its cwd', () => {
    const out = localizeAdoptedNode(
      node({ cwd: '~/proj', sshRemoteTmux: true, ssh: { host: 'h', user: 'u' } as never }),
      '/home/u'
    )
    expect(out.cwd).toBe('/home/u/proj')
    expect(out.sshRemoteTmux).toBeUndefined()
    expect(out.ssh).toBeUndefined()
  })
  it('keeps a plain `ssh <host>` node (no sshRemoteTmux): its ssh is a pty program, not a session', () => {
    const ssh = { host: 'h', user: 'u' } as never
    expect(localizeAdoptedNode(node({ ssh }), '/home/u').ssh).toBe(ssh)
  })
  it('returns the same object when nothing changes', () => {
    const n = node({ cwd: '/abs' })
    expect(localizeAdoptedNode(n, '/home/u')).toBe(n)
    const editor = node({ kind: 'editor', filePath: '/srv/a.ts', cwd: '/srv' })
    expect(localizeAdoptedNode(editor, '/home/u')).toBe(editor)
  })
  it('drops sshFs, so an editor or video node reads the local filesystem instead of an SSH project fs', () => {
    const out = localizeAdoptedNode(node({ kind: 'editor', filePath: '/srv/a.ts', sshFs: true }), '/home/u')
    expect(out.sshFs).toBeUndefined()
    expect('sshFs' in out).toBe(false)
    expect(out.filePath).toBe('/srv/a.ts')
  })
  it('expands a leading ~ in filePath, and only that', () => {
    expect(localizeAdoptedNode(node({ kind: 'video', filePath: '~/clips/a.mp4' }), '/home/u').filePath)
      .toBe('/home/u/clips/a.mp4')
    const other = node({ kind: 'editor', filePath: '~other/a.ts' })
    expect(localizeAdoptedNode(other, '/home/u')).toBe(other)
  })
})
