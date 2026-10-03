import { describe, expect, it, vi } from 'vitest'
import * as ghPathModule from '../gh-path'
import {
  CREDENTIAL_CACHE_MS,
  createTokenValidator,
  GitHubCredentialResolver,
  runGitHubCliCommand,
  type CommandRunner,
  type GitHubSecretStore,
  type TokenValidation
} from './credentials'
import { GitHubClientError } from './client'
import type { GitHubAuthProvider } from '../../shared/github-issues'

function fixture(options: {
  gh?: 'valid' | 'invalid' | 'missing'
  storedToken?: string | null
  validTokens?: Record<string, string>
  storage?: GitHubSecretStore['availability']
}) {
  const calls: string[] = []
  const run: CommandRunner = async (_command, args) => {
    calls.push(args.join(' '))
    if (options.gh === 'missing') return { ok: false, stdout: '', stderr: 'not found' }
    // An 'invalid' gh still HANDS OUT its stored token; GitHub is what refuses it (a 401 below).
    return { ok: true, stdout: options.gh === 'valid' ? 'gh-token\n' : 'revoked-gh-token\n', stderr: '' }
  }
  const secret: GitHubSecretStore = {
    availability: options.storage ?? 'encrypted',
    readForHost: async () => options.storedToken ?? null,
    save: async () => undefined,
    clear: async () => undefined
  }
  const resolver = new GitHubCredentialResolver({
    run,
    secret,
    validate: async (token): Promise<TokenValidation> => {
      const userId = options.validTokens?.[token]
      return userId
        ? { status: 'ok', identity: { userId, login: `login-${userId}` } }
        : { status: 'unauthorized' }
    }
  })
  return { resolver, calls }
}

describe('GitHubCredentialResolver caching', () => {
  function counted(now: () => number) {
    let ghCalls = 0
    let validations = 0
    const run: CommandRunner = async () => {
      ghCalls += 1
      return { ok: true, stdout: 'gh-token\n', stderr: '' }
    }
    const secret: GitHubSecretStore = {
      availability: 'encrypted',
      readForHost: async () => null,
      save: async () => undefined,
      clear: async () => undefined
    }
    const resolver = new GitHubCredentialResolver({
      run,
      secret,
      validate: async (): Promise<TokenValidation> => {
        validations += 1
        return { status: 'ok', identity: { userId: 'gh-user', login: 'octocat' } }
      },
      now
    })
    return { resolver, counts: () => ({ ghCalls, validations }) }
  }

  it('resolves once for repeated calls inside the cache window', async () => {
    // Every epoch re-check in the service calls resolve(). Uncached, each one spawns two `gh`
    // processes AND spends a /user request that no rate-limit accounting can see.
    let clock = 1_000
    const { resolver, counts } = counted(() => clock)

    await resolver.resolve('gh')
    const first = counts()
    expect(first.ghCalls).toBe(1)
    expect(first.validations).toBe(1)

    clock += 1_000
    await resolver.resolve('gh')
    await resolver.resolve('gh')
    expect(counts()).toEqual(first)

    clock += CREDENTIAL_CACHE_MS
    await resolver.resolve('gh')
    expect(counts().validations).toBe(2)
  })

  it('re-resolves immediately after the credential boundary moves', async () => {
    let clock = 1_000
    const { resolver, counts } = counted(() => clock)
    await resolver.resolve('gh')
    expect(counts().validations).toBe(1)

    resolver.invalidate()

    await resolver.resolve('gh')
    expect(counts().validations).toBe(2)
  })

  it('caches each provider separately', async () => {
    let clock = 1_000
    const { resolver, counts } = counted(() => clock)
    await resolver.resolve('gh')
    await resolver.resolve('auto')
    expect(counts().validations).toBe(2)
  })
})

describe('GitHubCredentialResolver', () => {
  const providerCases = [
    ['auto', { gh: 'valid', storedToken: 'pat', validTokens: { 'gh-token': 'gh-user', pat: 'pat-user' } }, 'gh'],
    ['auto', { gh: 'invalid', storedToken: 'pat', validTokens: { pat: 'pat-user' } }, 'token'],
    ['gh', { gh: 'invalid', storedToken: 'pat', validTokens: { pat: 'pat-user' } }, null],
    ['token', { gh: 'valid', storedToken: 'bad', validTokens: { 'gh-token': 'gh-user' } }, null]
  ] satisfies Array<[GitHubAuthProvider, Parameters<typeof fixture>[0], 'gh' | 'token' | null]>

  it.each(providerCases)('uses the exact %s provider fallback rule', async (provider, options, expected) => {
    const { resolver } = fixture(options)
    expect((await resolver.resolve(provider))?.provider ?? null).toBe(expected)
  })

  it('does not read the stored token when GitHub CLI succeeds in auto mode', async () => {
    let secretReads = 0
    const secret: GitHubSecretStore = {
      availability: 'encrypted',
      readForHost: async () => { secretReads += 1; return 'pat' },
      save: async () => undefined,
      clear: async () => undefined
    }
    const resolver = new GitHubCredentialResolver({
      run: async () => ({ ok: true, stdout: 'gh-token', stderr: '' }),
      secret,
      validate: async (): Promise<TokenValidation> => ({
        status: 'ok', identity: { userId: '1', login: 'octocat' }
      })
    })
    expect((await resolver.resolve('auto'))?.provider).toBe('gh')
    expect(secretReads).toBe(0)
  })

  it('returns presence and provider status without credential material', async () => {
    const { resolver } = fixture({
      gh: 'invalid',
      storedToken: 'super-secret-token',
      validTokens: { 'super-secret-token': 'pat-user' },
      storage: 'restricted-file'
    })
    const status = await resolver.status('auto')
    expect(status).toEqual({
      selectedProvider: 'auto',
      activeProvider: 'token',
      ghAuthenticated: false,
      tokenPresent: true,
      storage: 'restricted-file',
      login: 'login-pat-user',
      // Not credential material: the host uses it to look up the rate budget and strips it.
      userId: 'pat-user'
    })
    expect(JSON.stringify(status)).not.toContain('super-secret-token')
  })

  it('never runs `gh auth status`, which reports a network failure as an invalid token', async () => {
    // Measured on gh 2.45 with api.github.com unreachable: `gh auth status` printed "The token in
    // hosts.yml is invalid" (and exited 0). `gh auth token` only reads the local store; whether the
    // token works is decided by our own classified /user check.
    const { resolver, calls } = fixture({ gh: 'valid', validTokens: { 'gh-token': 'gh-user' } })
    await resolver.resolve('gh')
    await resolver.status('gh')
    expect(calls.every((call) => call === 'auth token --hostname github.com')).toBe(true)
  })
})

describe('GitHubCredentialResolver: only GitHub saying no is "signed out"', () => {
  function flaky(initial: TokenValidation['status'] = 'ok') {
    let clock = 1_000
    let answer: TokenValidation = initial === 'ok'
      ? { status: 'ok', identity: { userId: 'gh-user', login: 'octocat' } }
      : { status: 'unknown', reason: 'unreachable' }
    let ghToken = 'gh-token'
    const resolver = new GitHubCredentialResolver({
      run: async () => ({ ok: true, stdout: `${ghToken}\n`, stderr: '' }),
      secret: {
        availability: 'encrypted',
        readForHost: async () => 'pat',
        save: async () => undefined,
        clear: async () => undefined
      },
      validate: async (token) => token === 'pat'
        ? { status: 'ok', identity: { userId: 'pat-user', login: 'pat-login' } }
        : answer,
      now: () => clock
    })
    return {
      resolver,
      advance: () => { clock += CREDENTIAL_CACHE_MS },
      answer: (next: TokenValidation) => { answer = next },
      ghToken: (next: string) => { ghToken = next }
    }
  }

  it.each([
    ['a rate limit', { status: 'unknown', reason: 'rate-limited', retryAt: 9_000 }],
    ['a network failure', { status: 'unknown', reason: 'unreachable' }]
  ] as const)('keeps the last good credential through %s', async (_name, failure) => {
    const { resolver, advance, answer } = flaky()
    expect((await resolver.resolve('gh'))?.login).toBe('octocat')
    advance()
    answer(failure)
    expect(await resolver.resolve('gh')).toMatchObject({ provider: 'gh', userId: 'gh-user' })
    const status = await resolver.status('gh')
    expect(status).toMatchObject({
      activeProvider: 'gh', ghAuthenticated: true, login: 'octocat',
      unreachable: { reason: failure.reason }
    })
  })

  it('refuses rather than answering "signed out" when it has never had a good answer', async () => {
    const { resolver } = flaky('unknown')
    await expect(resolver.resolve('gh')).rejects.toMatchObject({ code: 'github-unreachable' })
    const status = await resolver.status('gh')
    expect(status.unreachable).toEqual({ reason: 'unreachable' })
    expect(status.activeProvider).toBeNull()
  })

  it('does not vouch for a DIFFERENT token with an old good answer', async () => {
    const { resolver, advance, answer, ghToken } = flaky()
    await resolver.resolve('gh')
    advance()
    ghToken('someone-elses-token')
    answer({ status: 'unknown', reason: 'unreachable' })
    await expect(resolver.resolve('gh')).rejects.toMatchObject({ code: 'github-unreachable' })
  })

  it('says signed out only when GitHub refuses the credential', async () => {
    const { resolver, advance, answer } = flaky()
    await resolver.resolve('gh')
    advance()
    answer({ status: 'unauthorized' })
    expect(await resolver.resolve('gh')).toBeNull()
    const status = await resolver.status('gh')
    expect(status).toMatchObject({ activeProvider: null, ghAuthenticated: false })
    expect(status.unreachable).toBeUndefined()
  })

  it('does not switch Auto to the saved token just because GitHub could not check the CLI', async () => {
    const { resolver } = flaky('unknown')
    await expect(resolver.resolve('auto')).rejects.toMatchObject({ code: 'github-unreachable' })
  })

  it('carries the retry time of a rate-limited check', async () => {
    const { resolver, answer } = flaky('unknown')
    answer({ status: 'unknown', reason: 'rate-limited', retryAt: 9_000 })
    await expect(resolver.resolve('gh')).rejects.toMatchObject({ code: 'rate-limited', retryAt: 9_000 })
  })
})

describe('createTokenValidator', () => {
  type Fetch = Parameters<typeof createTokenValidator>[0]

  it('makes the repeat check conditional, so an unchanged identity costs no request', async () => {
    const sent: Array<[string, string | undefined]> = []
    const fetchUser: Fetch = async (token, etag) => {
      sent.push([token, etag])
      return etag === 'W/"me"'
        ? { notModified: true }
        : { notModified: false, identity: { userId: '1', login: 'octocat' }, etag: 'W/"me"' }
    }
    const validate = createTokenValidator(fetchUser)
    expect(await validate('t1')).toEqual({ status: 'ok', identity: { userId: '1', login: 'octocat' } })
    expect(await validate('t1')).toEqual({ status: 'ok', identity: { userId: '1', login: 'octocat' } })
    expect(sent).toEqual([['t1', undefined], ['t1', 'W/"me"']])
  })

  it('never presents one token\'s validator for another', async () => {
    const sent: Array<[string, string | undefined]> = []
    const validate = createTokenValidator(async (token, etag) => {
      sent.push([token, etag])
      return { notModified: false, identity: { userId: token, login: token }, etag: `W/"${token}"` }
    })
    await validate('t1')
    await validate('t2')
    expect(sent).toEqual([['t1', undefined], ['t2', undefined]])
  })

  it.each([
    ['a 401', new GitHubClientError('request-failed', 401), { status: 'unauthorized' }],
    ['a rate limit', new GitHubClientError('rate-limited', 403, 9_000),
      { status: 'unknown', reason: 'rate-limited', retryAt: 9_000 }],
    ['a network failure', new GitHubClientError('request-failed'), { status: 'unknown', reason: 'unreachable' }],
    ['a 503', new GitHubClientError('request-failed', 503), { status: 'unknown', reason: 'unreachable' }]
  ])('answers %s with the classified outcome', async (_name, error, expected) => {
    const validate = createTokenValidator(async () => { throw error })
    expect(await validate('t1')).toEqual(expected)
  })

  it('forgets a validator once GitHub refuses its token', async () => {
    let refuse = false
    const sent: Array<string | undefined> = []
    const validate = createTokenValidator(async (_token, etag) => {
      sent.push(etag)
      if (refuse) throw new GitHubClientError('request-failed', 401)
      return { notModified: false, identity: { userId: '1', login: 'a' }, etag: 'W/"e"' }
    })
    await validate('t1')
    refuse = true
    await validate('t1')
    refuse = false
    await validate('t1')
    expect(sent).toEqual([undefined, 'W/"e"', undefined])
  })
})

describe('runGitHubCliCommand', () => {
  it('rejects unsupported commands without executing', async () => {
    const result = await runGitHubCliCommand('not-gh', ['status'])
    expect(result).toEqual({
      ok: false,
      stdout: '',
      stderr: 'unsupported command'
    })
  })

  it('queries ghPath when executing gh', async () => {
    const spy = vi.spyOn(ghPathModule, 'ghPath').mockReturnValue('/mock/bin/gh')
    const result = await runGitHubCliCommand('gh', ['status'])
    expect(spy).toHaveBeenCalled()
    expect(result.ok).toBe(false)
    spy.mockRestore()
  })
})
