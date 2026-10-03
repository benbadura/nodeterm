// A failed LOCAL read must not wipe the numbers the previous read produced. The usage endpoint
// rate-limits (HTTP 429) on a budget every Claude CLI using the same login also spends, so on a
// busy machine reads fail intermittently — and each failure used to replace
// the bars with "Could not read usage" until the next successful read, 5–15 minutes later.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { IPC } from '../../shared/ipc'
import type { ClaudeUsage } from '../../shared/types'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform, type FakePlatform } from '../platform-fake'
import { startUsageService, type UsageService } from './usage-service'

const { keychain } = vi.hoisted(() => ({ keychain: vi.fn() }))
vi.mock('child_process', () => ({ execFile: keychain }))
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>()
  return { ...actual, promises: { ...actual.promises, readFile: vi.fn() } }
})
vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>()
  return { ...actual, default: { ...actual, homedir: () => '/fixture-home' } }
})

const files: Record<string, string> = {
  '/fixture-home/.claude/.credentials.json': JSON.stringify({
    claudeAiOauth: { accessToken: 'fixture-token', email: 'me@example.test' }
  })
}
const ok = (): Response =>
  new Response(JSON.stringify({ limits: [{ kind: 'session', group: 'session', percent: 40 }] }))
const limited = (): Response =>
  new Response('{"error":{"type":"rate_limit_error"}}', { status: 429 })

let platform: FakePlatform
let service: UsageService | undefined
let responses: Array<() => Response>
const fetchStub = vi.fn(async () => (responses.shift() ?? limited)())

beforeEach(() => {
  platform = fakePlatform({ userDataDir: '/fixture-data' })
  initPlatform(platform)
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  vi.mocked(fs.readFile).mockImplementation(async (file) => {
    const raw = files[String(file)]
    if (raw === undefined) throw new Error('fixture missing')
    return raw
  })
  keychain.mockImplementation((_cmd, _args, cb) => cb(new Error('fixture missing')))
  fetchStub.mockClear()
  vi.stubGlobal('fetch', fetchStub)
  service = startUsageService({ shouldPoll: () => false })
})

afterEach(() => {
  service?.dispose()
  service = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetPlatformForTests()
})

const refresh = (): Promise<ClaudeUsage> => platform.handlers[IPC.usageRefresh]() as Promise<ClaudeUsage>
const fetchCached = (): Promise<ClaudeUsage> => platform.handlers[IPC.usageFetch]() as Promise<ClaudeUsage>
const pushed = (): ClaudeUsage[] =>
  platform.sent.filter((m) => m.channel === IPC.usageUpdate).map((m) => m.args[0] as ClaudeUsage)

describe('local usage through a failed read', () => {
  it('keeps and pushes the last good numbers when the endpoint answers 429', async () => {
    responses = [ok, limited]
    const first = await refresh()
    expect(first.status).toBe('ok')
    const held = await refresh()
    expect(held).toMatchObject({ status: 'error', rateLimited: true, updatedAt: first.updatedAt })
    expect(held.limits).toEqual(first.limits)
    // The collapsed chip is fed by the push channel — it must get the held numbers too.
    expect(pushed().at(-1)).toEqual(held)
  })

  it('debounces from the failed read, not from the age of the numbers it kept', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000_000)
    responses = [ok, limited]
    await refresh()
    // Past the 5-minute debounce, but well inside the hold window.
    vi.setSystemTime(1_000_000_000 + 6 * 60_000)
    await refresh()
    // The held snapshot's updatedAt is older than the read that produced it. Keying the debounce
    // on it would make every cached fetch re-read — hammering exactly the endpoint that said 429.
    await fetchCached()
    expect(fetchStub).toHaveBeenCalledTimes(2)
  })

  it('still reports a plain failure when there was never a good read to keep', async () => {
    responses = [limited]
    const u = await refresh()
    expect(u).toMatchObject({ status: 'error', rateLimited: true, limits: [] })
  })
})
