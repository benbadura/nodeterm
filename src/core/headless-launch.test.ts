import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DELIVERY_ATTEMPTS, KILL_LINE, VERIFY_TIMEOUT_MS } from '@shared/command-delivery'
import type { HeadlessLaunchRequest } from '@shared/headless-launch'
import {
  desktopHeadlessRequest,
  launchHeadless,
  SETTLE_CAP_MS,
  SETTLE_MAX_MS,
  SETTLE_QUIET_MS,
  type HeadlessLaunchDeps
} from './headless-launch'
import type { PtyManager } from './pty-manager'

const CMD = "claude 'fix the flaky test in the worker pool'"

function harness(opts: { echoFrom?: number; fresh?: boolean; pane?: string | null } = {}) {
  const writes: string[] = []
  const listeners = new Set<(c: string) => void>()
  let cmdWrites = 0
  const deps: HeadlessLaunchDeps = {
    persistentSpawnAvailable: vi.fn(() => true),
    createHeadless: vi.fn(async () => ({ sessionId: 's1', fresh: opts.fresh ?? true, persistent: true })),
    paneCommand: vi.fn(async () => (opts.pane === undefined ? 'zsh' : opts.pane)),
    writeHeadless: vi.fn((_k: string, d: string) => {
      writes.push(d)
      if (d === '\r' || d === KILL_LINE || d === '\x1b') return true
      cmdWrites += 1
      // The shell echoes what it was typed, from the `echoFrom`-th command write on (1 = at once).
      if (cmdWrites >= (opts.echoFrom ?? 1)) for (const l of [...listeners]) l(d)
      return true
    }),
    onOutput: vi.fn((_k: string, cb: (c: string) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }),
    releaseHeadless: vi.fn()
  }
  const emit = (c: string): void => { for (const l of [...listeners]) l(c) }
  return { deps, writes, emit, listeners }
}

const req = (over: Partial<HeadlessLaunchRequest> = {}): HeadlessLaunchRequest => ({
  ptyOptions: { cols: 120, rows: 36, persistKey: 'n1', cwd: '/repo', shell: '/bin/zsh' },
  command: CMD,
  release: true,
  requirePersistent: true,
  ...over
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('launchHeadless (#925)', () => {
  it('a PtyManager is the deps as-is (checked by npm run typecheck)', () => {
    const structural: PtyManager extends HeadlessLaunchDeps ? true : false = true
    expect(structural).toBe(true)
  })

  it('refuses before spawning when no persistent backend exists', async () => {
    const { deps } = harness()
    ;(deps.persistentSpawnAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false)
    expect(await launchHeadless(deps, req())).toEqual({ outcome: 'failed', reason: 'not-persistent' })
    expect(deps.createHeadless).not.toHaveBeenCalled()
    expect(deps.releaseHeadless).not.toHaveBeenCalled()
  })

  it('does not ask about persistence when the caller keeps its client (Server Edition)', async () => {
    const { deps } = harness()
    ;(deps.persistentSpawnAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false)
    const p = launchHeadless(deps, req({ release: false, requirePersistent: false }))
    await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS)
    expect(await p).toEqual({ outcome: 'delivered', fresh: true })
    expect(deps.persistentSpawnAvailable).not.toHaveBeenCalled()
  })

  // The pre-spawn probe races a settings change: tmux switched off in between yields a plain
  // shell, and releasing a plain shell kills it. Typing a launch into it would kill that launch too.
  it('refuses a spawn that came back non-persistent, without typing, and still releases', async () => {
    const { deps, writes } = harness()
    ;(deps.createHeadless as ReturnType<typeof vi.fn>).mockResolvedValue({ sessionId: 's1', fresh: true, persistent: false })
    expect(await launchHeadless(deps, req())).toEqual({ outcome: 'failed', reason: 'not-persistent', fresh: true })
    expect(writes).toEqual([])
    expect(deps.paneCommand).not.toHaveBeenCalled()
    expect(deps.releaseHeadless).toHaveBeenCalledWith('n1')
  })

  // The pty IS the shell just spawned, and a plain shell has no tmux pane to ask: the real probe
  // answers null. Like the mounted writer (`trustsFreshShell`), a fresh one is trusted unprobed.
  it('delivers into a fresh non-persistent spawn without probing, when persistence is not required', async () => {
    const { deps, writes } = harness({ pane: null })
    ;(deps.createHeadless as ReturnType<typeof vi.fn>).mockResolvedValue({ sessionId: 's1', fresh: true, persistent: false })
    const p = launchHeadless(deps, req({ requirePersistent: false }))
    await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS)
    expect(await p).toEqual({ outcome: 'delivered', fresh: true })
    expect(writes).toEqual([CMD, '\r'])
    expect(deps.paneCommand).not.toHaveBeenCalled()
  })

  // #916: the session host's probe walks the process tree and reads a prompt helper as "not a
  // shell", so a fresh session-host shell is trusted after the settle, as the mounted writer does.
  it('trusts a fresh session-host shell after the settle, without probing', async () => {
    const { deps, writes } = harness({ pane: 'git' })
    ;(deps.createHeadless as ReturnType<typeof vi.fn>).mockResolvedValue({ sessionId: 's1', fresh: true, persistent: true, sessionHost: true })
    const p = launchHeadless(deps, req())
    await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS - 1)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toEqual({ outcome: 'delivered', fresh: true })
    expect(writes).toEqual([CMD, '\r'])
    expect(deps.paneCommand).not.toHaveBeenCalled()
  })

  it('still probes a session-host session that already existed', async () => {
    const { deps, writes } = harness({ pane: 'git' })
    ;(deps.createHeadless as ReturnType<typeof vi.fn>).mockResolvedValue({ sessionId: 's1', fresh: false, persistent: true, sessionHost: true })
    expect(await launchHeadless(deps, req())).toEqual({ outcome: 'failed', reason: 'no-shell', fresh: false })
    expect(deps.paneCommand).toHaveBeenCalledWith('n1')
    expect(writes).toEqual([])
  })

  it('an older core that omits `persistent` counts as persistent', async () => {
    const { deps } = harness()
    ;(deps.createHeadless as ReturnType<typeof vi.fn>).mockResolvedValue({ sessionId: 's1', fresh: true })
    const p = launchHeadless(deps, req())
    await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS)
    expect(await p).toEqual({ outcome: 'delivered', fresh: true })
  })

  it('waits for a fresh shell to settle before the pane probe (cap with no output)', async () => {
    const { deps, writes, listeners } = harness()
    const p = launchHeadless(deps, req())
    await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS - 1)
    expect(deps.paneCommand).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toEqual({ outcome: 'delivered', fresh: true })
    expect(writes).toEqual([CMD, '\r'])
    // A fresh TMUX pane is still probed (it answers exactly, and covers the new-session -A race).
    expect(deps.paneCommand).toHaveBeenCalledWith('n1')
    expect(deps.releaseHeadless).toHaveBeenCalledWith('n1')
    // Both output taps (the settle's and the delivery's) are gone once the launch is over.
    expect(listeners.size).toBe(0)
  })

  it('output restarts the quiet window', async () => {
    const { deps, emit } = harness()
    const p = launchHeadless(deps, req())
    await vi.advanceTimersByTimeAsync(10)
    emit('prompt% ')
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS - 1)
    expect(deps.paneCommand).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toMatchObject({ outcome: 'delivered' })
  })

  // Review finding: the silence cap is cleared by the first chunk, so a pane that paints more often
  // than the quiet window never settled — and the Server Edition awaits this inside its global
  // control lock, so one such pane wedged every control verb behind it.
  it('a pane that never stops painting still reaches the probe at SETTLE_MAX_MS, and not before', async () => {
    const { deps, writes, emit, listeners } = harness()
    let tapsAtProbe = -1
    ;(deps.paneCommand as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      tapsAtProbe = listeners.size
      return 'zsh'
    })
    const p = launchHeadless(deps, req())
    const painter = setInterval(() => emit('\x1b[2K\r⠋ loading'), 100)
    await vi.advanceTimersByTimeAsync(SETTLE_MAX_MS - 1)
    expect(deps.paneCommand).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.paneCommand).toHaveBeenCalledWith('n1')
    // The ceiling exit unsubscribed the settle's tap before anything else ran.
    expect(tapsAtProbe).toBe(0)
    clearInterval(painter)
    expect(await p).toEqual({ outcome: 'delivered', fresh: true })
    expect(writes).toEqual([CMD, '\r'])
    expect(listeners.size).toBe(0)
    // No settle timer (quiet window or ceiling) outlives the launch.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a pane that goes quiet settles on the quiet window, not the ceiling, and leaves no timer', async () => {
    const { deps, emit } = harness()
    const p = launchHeadless(deps, req())
    const painter = setInterval(() => emit('rc output\r\n'), 100)
    await vi.advanceTimersByTimeAsync(1000)
    clearInterval(painter)
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS - 1)
    expect(deps.paneCommand).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.paneCommand).toHaveBeenCalledWith('n1')
    expect(await p).toEqual({ outcome: 'delivered', fresh: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the silence cap exit disarms the ceiling too', async () => {
    const { deps } = harness()
    const p = launchHeadless(deps, req())
    await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS)
    expect(await p).toEqual({ outcome: 'delivered', fresh: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honours a ceiling passed through the timing seam', async () => {
    const { deps, emit } = harness()
    deps.timing = { quietMs: SETTLE_QUIET_MS, capMs: SETTLE_CAP_MS, maxMs: 700 }
    const p = launchHeadless(deps, req())
    const painter = setInterval(() => emit('.'), 100)
    await vi.advanceTimersByTimeAsync(699)
    expect(deps.paneCommand).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.paneCommand).toHaveBeenCalledWith('n1')
    clearInterval(painter)
    expect(await p).toEqual({ outcome: 'delivered', fresh: true })
  })

  it('an output tap that cannot be opened ends the launch without leaving a timer armed', async () => {
    const { deps, writes } = harness()
    ;(deps.onOutput as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('session gone')
    })
    expect(await launchHeadless(deps, req())).toEqual({ outcome: 'failed', reason: 'cancelled', fresh: true })
    expect(writes).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an existing session skips the settle and clears any pending input first', async () => {
    const { deps, writes } = harness({ fresh: false })
    expect(await launchHeadless(deps, req())).toEqual({ outcome: 'delivered', fresh: false })
    expect(writes).toEqual([KILL_LINE, CMD, '\r'])
  })

  it('types nothing when no shell owns the pane (a running agent, an unreadable probe)', async () => {
    for (const pane of ['vim', null]) {
      const { deps, writes } = harness({ fresh: false, pane })
      expect(await launchHeadless(deps, req())).toEqual({ outcome: 'failed', reason: 'no-shell', fresh: false })
      expect(writes).toEqual([])
      expect(deps.releaseHeadless).toHaveBeenCalledWith('n1')
    }
  })

  it('treats a throwing probe as no shell', async () => {
    const { deps, writes } = harness({ fresh: false })
    ;(deps.paneCommand as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('tmux gone'))
    expect(await launchHeadless(deps, req())).toMatchObject({ outcome: 'failed', reason: 'no-shell' })
    expect(writes).toEqual([])
  })

  // Review Focus 2: rc work swallowed the first attempt — kill the line and retype, never submit it.
  it('a first attempt whose echo never arrives is killed and retried, not submitted', async () => {
    const { deps, writes } = harness({ fresh: false, echoFrom: 2 })
    const p = launchHeadless(deps, req())
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS)
    expect(await p).toEqual({ outcome: 'delivered', fresh: false })
    expect(writes).toEqual([KILL_LINE, CMD, KILL_LINE, CMD, '\r'])
  })

  // Review Focus 3: a line the tty cannot hold is refused, never submitted truncated (#706).
  it('an over-long command that never echoes ends line-too-long with no Enter', async () => {
    const long = `claude '${'x'.repeat(5000)}'`
    const { deps, writes } = harness({ fresh: false, echoFrom: Number.POSITIVE_INFINITY })
    const p = launchHeadless(deps, req({ command: long }))
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS * DELIVERY_ATTEMPTS)
    expect(await p).toEqual({ outcome: 'failed', reason: 'line-too-long', fresh: false })
    expect(writes).not.toContain('\r')
    expect(writes[writes.length - 1]).toBe(KILL_LINE)
  })

  it('a refused headless write ends the delivery as cancelled', async () => {
    const { deps } = harness({ fresh: false })
    ;(deps.writeHeadless as ReturnType<typeof vi.fn>).mockReturnValue(false)
    expect(await launchHeadless(deps, req())).toMatchObject({ outcome: 'failed', reason: 'cancelled' })
  })

  it('spawn failures: a throw, no session, or an unavailable answer', async () => {
    for (const impl of [
      async () => { throw new Error('spawn') },
      async () => ({ sessionId: '', fresh: true }),
      async () => ({ sessionId: 's1', fresh: true, unavailable: 'ssh' as const })
    ]) {
      const { deps } = harness()
      ;(deps.createHeadless as ReturnType<typeof vi.fn>).mockImplementation(impl)
      expect(await launchHeadless(deps, req())).toMatchObject({ outcome: 'failed', reason: 'spawn-failed' })
    }
  })

  it('never releases when nothing was spawned', async () => {
    for (const impl of [async () => { throw new Error('spawn') }, async () => ({ sessionId: '', fresh: true })]) {
      const { deps } = harness()
      ;(deps.createHeadless as ReturnType<typeof vi.fn>).mockImplementation(impl)
      await launchHeadless(deps, req())
      expect(deps.releaseHeadless).not.toHaveBeenCalled()
    }
  })

  it('keeps the client when asked to (release:false)', async () => {
    const { deps } = harness({ fresh: false })
    await launchHeadless(deps, req({ release: false }))
    expect(deps.releaseHeadless).not.toHaveBeenCalled()
  })

  it('uses the Windows line-clear for a PowerShell pane', async () => {
    const { deps, writes } = harness({ fresh: false, pane: 'pwsh' })
    await launchHeadless(deps, req({ ptyOptions: { cols: 1, rows: 1, persistKey: 'n1', shell: 'pwsh.exe' } }))
    expect(writes[0]).toBe('\x1b')
  })
})

describe('desktopHeadlessRequest (#925)', () => {
  const opts = { cols: 120, rows: 36, persistKey: 'n1', cwd: '/repo' }
  const ssh = { controlPath: '/tmp/cm', conn: { host: 'h', user: 'u' } } as never

  it('forces release and requirePersistent true, whatever the wire claims', () => {
    const out = desktopHeadlessRequest({
      ptyOptions: opts,
      command: CMD,
      release: false,
      requirePersistent: false
    } as never)
    expect(out.release).toBe(true)
    expect(out.requirePersistent).toBe(true)
    expect(out.command).toBe(CMD)
  })

  it('removes sshRemote: this path never spawns over a ControlMaster', () => {
    const out = desktopHeadlessRequest({ ptyOptions: { ...opts, sshRemote: ssh }, command: CMD })
    expect(out.ptyOptions.sshRemote).toBeUndefined()
    expect(out.ptyOptions).toMatchObject(opts)
  })

  // A `viewerId` would subscribe `(0, viewer)` while `releaseHeadless` kills `(0, PRIMARY)`, leaving
  // client 0 attached forever; `clearEnv` is a one-shot "Restart on subscription" flag that a
  // headless start must never carry. Neither may cross the wire into this launcher.
  it('removes viewerId and clearEnv, and keeps every other option as sent', () => {
    const out = desktopHeadlessRequest({
      ptyOptions: { ...opts, viewerId: 'modal-1', clearEnv: true, agentId: 'claude', requireRemote: true },
      command: CMD
    })
    expect(out.ptyOptions.viewerId).toBeUndefined()
    expect(out.ptyOptions.clearEnv).toBeUndefined()
    expect(out.ptyOptions).toMatchObject({ ...opts, agentId: 'claude', requireRemote: true })
  })

  it('what reaches createHeadless carries no viewerId, so the release detaches the client it spawned', async () => {
    const { deps } = harness()
    const p = launchHeadless(
      deps,
      desktopHeadlessRequest({ ptyOptions: { ...opts, viewerId: 'modal-1', clearEnv: true }, command: CMD })
    )
    await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS)
    expect(await p).toEqual({ outcome: 'delivered', fresh: true })
    const sent = (deps.createHeadless as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>
    expect(sent.viewerId).toBeUndefined()
    expect(sent.clearEnv).toBeUndefined()
    expect(deps.releaseHeadless).toHaveBeenCalledWith('n1')
  })

  it('keeps requireRemote, so core still refuses to spawn a remote node locally', () => {
    const out = desktopHeadlessRequest({
      ptyOptions: { ...opts, sshRemote: ssh, requireRemote: true },
      command: CMD
    })
    expect(out.ptyOptions.requireRemote).toBe(true)
  })

  it('coerces a non-string command', () => {
    expect(desktopHeadlessRequest({ ptyOptions: opts, command: 42 as never }).command).toBe('42')
    expect(desktopHeadlessRequest({ ptyOptions: opts, command: undefined as never }).command).toBe('')
    expect(desktopHeadlessRequest({ ptyOptions: opts, command: null as never }).command).toBe('')
  })

  it("a remote node's options end as spawn-failed with nothing typed (core's unavailable:'ssh')", async () => {
    const { deps, writes } = harness()
    ;(deps.createHeadless as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      sessionId: 's',
      fresh: true,
      unavailable: 'ssh' as const
    }))
    const r = desktopHeadlessRequest({
      ptyOptions: { ...opts, sshRemote: ssh, requireRemote: true },
      command: CMD
    })
    expect(await launchHeadless(deps, r)).toMatchObject({ outcome: 'failed', reason: 'spawn-failed' })
    // What reached core carried the refusal flag, and no ControlMaster.
    expect(deps.createHeadless).toHaveBeenCalledWith(
      expect.objectContaining({ requireRemote: true, sshRemote: undefined })
    )
    expect(writes).toEqual([])
    expect(deps.writeHeadless).not.toHaveBeenCalled()
  })
})
