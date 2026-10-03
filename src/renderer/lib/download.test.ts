import { describe, it, expect, vi } from 'vitest'
import {
  canRevealLocally,
  canUseLocalShell,
  downloadRoute,
  isDownloadablePath,
  performDownload,
  type DownloadTransport
} from './download'

describe('downloadRoute', () => {
  it('pulls an SSH project over scp on the desktop', () => {
    expect(downloadRoute({ browser: false, ssh: true, source: 'local' })).toBe('scp')
  })

  it('serves every browser tree over HTTP — including a "local" project, which is on the server', () => {
    expect(downloadRoute({ browser: true, ssh: false, source: 'local' })).toBe('http')
  })

  it('offers nothing for a desktop local project (the file is already here)', () => {
    expect(downloadRoute({ browser: false, ssh: false, source: 'local' })).toBe('none')
  })

  it('offers nothing on a relay tab, whatever the project is', () => {
    expect(downloadRoute({ browser: false, ssh: true, source: 'relay' })).toBe('none')
    expect(downloadRoute({ browser: true, ssh: false, source: 'relay' })).toBe('none')
  })

  it('does not mint a ticket for an SSH tree in the browser (that fs is not the server’s)', () => {
    expect(downloadRoute({ browser: true, ssh: true, source: 'local' })).toBe('none')
  })
})

describe('canRevealLocally', () => {
  it('is true only for a desktop local project', () => {
    expect(canRevealLocally({ browser: false, ssh: false, source: 'local' })).toBe(true)
  })

  it('is false where the path is not on this machine, or nothing can open it', () => {
    expect(canRevealLocally({ browser: false, ssh: true, source: 'local' })).toBe(false)
    expect(canRevealLocally({ browser: true, ssh: false, source: 'local' })).toBe(false)
    expect(canRevealLocally({ browser: false, ssh: false, source: 'relay' })).toBe(false)
  })
})

describe('canUseLocalShell', () => {
  // The Server Edition bug this predicate was extracted for: a browser tab's session source is
  // 'local' (SessionSource's 'server' is declared but never constructed), so `source` alone can
  // never tell you you are in a browser — only `isBrowserRuntime()` can. `shell.openPath` is a
  // `noop` stub there, so an ungated call on a .zip or .dmg was a silent dead click.
  it('is false in a browser tab even though its session source is local', () => {
    expect(canUseLocalShell({ browser: true, ssh: false, source: 'local' })).toBe(false)
  })

  it('is true only for a desktop shell acting on this machine', () => {
    expect(canUseLocalShell({ browser: false, ssh: false, source: 'local' })).toBe(true)
    expect(canUseLocalShell({ browser: false, ssh: true, source: 'local' })).toBe(false)
    expect(canUseLocalShell({ browser: false, ssh: false, source: 'relay' })).toBe(false)
  })

  // One rule, not two that drift: reveal was gated and openPath was not, which is how the
  // Server Edition ended up with a dead click on one member of the same namespace.
  it('is the same rule reveal already used', () => {
    for (const browser of [true, false])
      for (const ssh of [true, false])
        for (const source of ['local', 'relay', 'server'] as const)
          expect(canUseLocalShell({ browser, ssh, source })).toBe(
            canRevealLocally({ browser, ssh, source })
          )
  })
})

describe('isDownloadablePath', () => {
  // The same refusal set as core's `safeDownloadBasename`: a path whose basename cannot name a
  // download. A file manager node can stand on `/`, and the HTTP route would happily tar the
  // whole server filesystem for it.
  it('refuses the filesystem root and paths with no nameable basename', () => {
    for (const p of ['/', '', '//', '~', '/srv/..', '/srv/.', '~/'])
      expect(isDownloadablePath(p), p).toBe(false)
  })

  it('accepts an ordinary file or folder, trailing slash or not', () => {
    for (const p of ['/srv/app/notes.md', '/srv/app/', '~/project', '/.bashrc'])
      expect(isDownloadablePath(p), p).toBe(true)
  })
})

describe('performDownload', () => {
  const transport = (over: Partial<DownloadTransport> = {}): DownloadTransport & {
    handed: { url: string; name: string }[]
  } => {
    const handed: { url: string; name: string }[] = []
    return {
      handed,
      scp: vi.fn(async () => ({ ok: true as const, localPath: '/Users/me/Downloads/a.txt', dir: false })),
      ticket: vi.fn(async () => ({ url: '/download?t=abc', name: 'a.txt' })),
      hand: (url, name) => handed.push({ url, name }),
      ...over
    }
  }

  it('pulls over scp with the project id and the chosen folder, and reports where it landed', async () => {
    const t = transport()
    const out = await performDownload('scp', { path: '/srv/a.txt', projectId: 'p1', destDir: '/tmp/x' }, t)
    expect(t.scp).toHaveBeenCalledWith('p1', '/srv/a.txt', '/tmp/x')
    expect(out).toEqual({ ok: true, localPath: '/Users/me/Downloads/a.txt' })
  })

  it('passes an scp failure reason through unchanged', async () => {
    const t = transport({ scp: async () => ({ ok: false as const, error: 'Not connected.' }) })
    expect(await performDownload('scp', { path: '/srv/a.txt', projectId: 'p1' }, t)).toEqual({
      ok: false,
      error: 'Not connected.'
    })
  })

  it('refuses scp without a project instead of sending an undefined id to main', async () => {
    const t = transport()
    const out = await performDownload('scp', { path: '/srv/a.txt' }, t)
    expect(out.ok).toBe(false)
    expect(t.scp).not.toHaveBeenCalled()
  })

  it('hands a minted ticket to the browser and never touches scp', async () => {
    const t = transport()
    const out = await performDownload('http', { path: '/srv/a.txt', projectId: 'p1' }, t)
    expect(out).toEqual({ ok: true })
    expect(t.handed).toEqual([{ url: '/download?t=abc', name: 'a.txt' }])
    expect(t.scp).not.toHaveBeenCalled()
  })

  it('reports a null ticket as unavailable rather than handing nothing to the browser', async () => {
    const t = transport({ ticket: async () => null })
    const out = await performDownload('http', { path: '/srv/a.txt' }, t)
    expect(out).toEqual({ ok: false, error: 'Downloading is not available here.' })
    expect(t.handed).toEqual([])
  })

  it('turns a rejected transport into a failed outcome, never a throw', async () => {
    const t = transport({
      scp: async () => {
        throw new Error('ipc gone')
      },
      ticket: async () => {
        throw new Error('ws gone')
      }
    })
    expect(await performDownload('scp', { path: '/a', projectId: 'p' }, t)).toEqual({
      ok: false,
      error: 'The download could not be started.'
    })
    expect(await performDownload('http', { path: '/a' }, t)).toEqual({
      ok: false,
      error: 'The download could not be started.'
    })
  })

  it('does nothing at all on the none route', async () => {
    const t = transport()
    const out = await performDownload('none', { path: '/a', projectId: 'p' }, t)
    expect(out.ok).toBe(false)
    expect(t.scp).not.toHaveBeenCalled()
    expect(t.ticket).not.toHaveBeenCalled()
  })
})
