import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'

/**
 * The core-side io of the headless launcher (#925): an output tap per node, and a write/release
 * pair that acts AS the synthetic client 0 `createHeadless` subscribes. Harness copied from
 * pty-coattach.test.ts: no `init()`, so there is no tmux and every session is a plain shell (its
 * node id lives on `nodeId`, not `persistKey`).
 */

/** One fake pty per spawn, recorded so a test can push output and see what was written. */
interface FakePty {
  onDataCb?: (d: string) => void
  onExitCb?: (e: { exitCode: number }) => void
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  paused: boolean
  killed: boolean
}
const spawned: FakePty[] = []

// Pin the persistence backend: `sessionHostSupported()` only asks whether
// out/session-host/host.cjs exists on disk, so whether this suite exercises the mocked
// `node-pty` spawn below or a real session-host shim depended on whether anyone had run
// `npm run build` (or `npm run host:build`). See src/core/__fixtures__/no-session-host.ts.
vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

vi.mock('node-pty', () => ({
  spawn: (_file: string, _args: string[], _opts: unknown) => {
    const p: FakePty = { writes: [], resizes: [], paused: false, killed: false }
    spawned.push(p)
    return {
      onData: (cb: (d: string) => void) => {
        p.onDataCb = cb
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        p.onExitCb = cb
      },
      write: (d: string) => p.writes.push(d),
      resize: (cols: number, rows: number) => p.resizes.push({ cols, rows }),
      pause: () => {
        p.paused = true
      },
      resume: () => {
        p.paused = false
      },
      kill: () => {
        p.killed = true
      },
      pid: 1234
    }
  }
}))

/**
 * A machine with pty devices to spare, always — otherwise the real `/dev` probe makes this suite
 * depend on how many terminals the developer running it has open (see pty-coattach.test.ts).
 */
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

describe('PtyManager headless taps (#925)', () => {
  let fake: FakePlatform

  beforeEach(() => {
    spawned.length = 0
    fake = fakePlatform()
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  async function manager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.registerIpc()
    return m
  }

  it('onOutput receives flushed output for the node, and unsubscribes cleanly', async () => {
    const m = await manager()
    const r = await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n1' })
    expect(r.sessionId).toBeTruthy()
    const seen: string[] = []
    const off = m.onOutput('n1', (c) => seen.push(c))
    spawned[0].onDataCb?.('hello')
    vi.advanceTimersByTime(50) // past FLUSH_MS
    expect(seen.join('')).toBe('hello')
    off()
    spawned[0].onDataCb?.('again')
    vi.advanceTimersByTime(50)
    expect(seen.join('')).toBe('hello')
  })

  it('writeHeadless writes only when client 0 holds a live session for that node', async () => {
    const m = await manager()
    expect(m.writeHeadless('n1', 'x')).toBe(false) // nothing spawned yet
    await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n1' })
    expect(m.writeHeadless('n1', 'abc')).toBe(true)
    expect(spawned[0].writes).toContain('abc')
    expect(m.writeHeadless('other', 'abc')).toBe(false)
  })

  it('writeHeadless refuses a live session that only a real client attached', async () => {
    const m = await manager()
    await fake.handlers[IPC.ptyCreate](1, { cols: 80, rows: 24, persistKey: 'n1' })
    expect(spawned).toHaveLength(1)
    expect(m.writeHeadless('n1', 'abc')).toBe(false) // client 0 never subscribed
    expect(spawned[0].writes).toEqual([])
    m.releaseHeadless('n1') // not client 0's to drop: the viewer's pty stays attached
    expect(spawned[0].killed).toBe(false)
  })

  it('releaseHeadless drops client 0, after which a headless write is refused', async () => {
    const m = await manager()
    await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n1' })
    m.releaseHeadless('n1')
    // Client 0 was the only subscriber, so the pty client is released (a plain shell dies with it,
    // which is why the launcher gates on persistentSpawnAvailable) and the session is forgotten.
    expect(spawned[0].killed).toBe(true)
    expect(m.writeHeadless('n1', 'abc')).toBe(false)
    expect(spawned[0].writes).not.toContain('abc')
    m.releaseHeadless('n1') // idempotent: no live session, no throw
  })

  it('a throwing output tap does not break delivery to the others', async () => {
    const m = await manager()
    await m.createHeadless({ cols: 80, rows: 24, persistKey: 'n1' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    m.onOutput('n1', () => {
      throw new Error('boom')
    })
    m.onOutput('n1', (c) => seen.push(c))
    spawned[0].onDataCb?.('z')
    vi.advanceTimersByTime(50)
    expect(seen).toEqual(['z'])
    expect(warn).toHaveBeenCalledWith('[pty] output tap failed', 'boom')
    warn.mockRestore()
  })
})
