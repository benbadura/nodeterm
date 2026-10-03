import type {
  GitHubAuthProvider,
  GitHubAuthStatus,
  GitHubSecretAvailability
} from '../../shared/github-issues'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SecretStore } from '../secret-store'
import { gitEnv } from '../git-env'
import { ghPath } from '../gh-path'
import { classifyGitHubFailure, GitHubReachabilityError } from './failure'

export type CommandResult = { ok: boolean; stdout: string; stderr: string }
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>

const execute = promisify(execFile)

export const runGitHubCliCommand: CommandRunner = async (command, args) => {
  if (command !== 'gh') return { ok: false, stdout: '', stderr: 'unsupported command' }
  try {
    const gh = ghPath() ?? 'gh'
    const result = await execute(gh, args, {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      // Shared with git-service so the two can never disagree about what a git/gh child gets. It
      // used to be a character-for-character copy whose hardcoded ':' corrupted PATH on Windows
      // (issue #583) — in the credential path, which is the one that hurts most there.
      env: gitEnv()
    })
    return { ok: true, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr || failure.message || 'GitHub CLI failed'
    }
  }
}

export interface GitHubSecretStore extends SecretStore {
  readonly availability: GitHubSecretAvailability
}

export interface ValidatedGitHubIdentity {
  userId: string
  login: string
}

export interface ResolvedGitHubCredential extends ValidatedGitHubIdentity {
  provider: 'gh' | 'token'
  token: string
}

/**
 * What checking one token against GitHub established. Three answers, never two: `unauthorized` is
 * GitHub refusing the token; `unknown` is failing to get an answer at all (network, outage, rate
 * limit). Folding `unknown` into "not authenticated" is how a throttle used to read as "you are
 * signed out" — see ./failure.ts.
 */
export type TokenValidation =
  | { status: 'ok'; identity: ValidatedGitHubIdentity }
  | { status: 'unauthorized' }
  | { status: 'unknown'; reason: 'rate-limited' | 'unreachable'; retryAt?: number }

/** One `/user` read. `etag` asks GitHub to answer 304 when the identity is unchanged. */
export type AuthenticatedUserFetch = (token: string, etag?: string) => Promise<
  | { notModified: true }
  | { notModified: false; identity: ValidatedGitHubIdentity; etag?: string }
>

const VALIDATOR_MEMO_LIMIT = 8

/**
 * Validates tokens with a CONDITIONAL `GET /user`. Every background poll re-resolves the credential
 * (the resolver's memo is shorter than the poll interval), so an unconditional check spent one
 * request per poll even when the heartbeat itself was a free 304. Measured 2026-09-28: ten
 * conditional `/user` reads answered 304 and moved `x-ratelimit-used` by zero, and a bogus token
 * presenting a valid `If-None-Match` still got 401 — the condition never masks a revoked token.
 *
 * The memo is keyed by a digest of the token (never the token itself), holds one validator per
 * token, and drops a token's entry the moment GitHub refuses it.
 */
export function createTokenValidator(fetchUser: AuthenticatedUserFetch): (token: string) => Promise<TokenValidation> {
  const memo = new Map<string, { etag: string; identity: ValidatedGitHubIdentity }>()
  return async (token) => {
    const key = createHash('sha256').update(token).digest('hex')
    const known = memo.get(key)
    try {
      const result = await fetchUser(token, known?.etag)
      if (result.notModified) {
        if (known) return { status: 'ok', identity: known.identity }
        return { status: 'unknown', reason: 'unreachable' }
      }
      memo.delete(key)
      if (result.etag) {
        memo.set(key, { etag: result.etag, identity: result.identity })
        while (memo.size > VALIDATOR_MEMO_LIMIT) memo.delete(memo.keys().next().value!)
      }
      return { status: 'ok', identity: result.identity }
    } catch (error) {
      const failure = classifyGitHubFailure(error)
      if (failure.kind === 'unauthorized') {
        memo.delete(key)
        return { status: 'unauthorized' }
      }
      if (failure.kind === 'rate-limited') {
        return failure.retryAt === undefined
          ? { status: 'unknown', reason: 'rate-limited' }
          : { status: 'unknown', reason: 'rate-limited', retryAt: failure.retryAt }
      }
      return { status: 'unknown', reason: 'unreachable' }
    }
  }
}

type ResolverDependencies = {
  run: CommandRunner
  secret: GitHubSecretStore
  validate(token: string): Promise<TokenValidation>
  now?: () => number
}

/** How long one resolved credential is reused. The service re-checks its epoch before every read
 *  and around every write, and each check calls resolve() — which, uncached, spawns `gh auth
 *  token` AND spends a GET /user request. Those /user calls never pass through the request
 *  coordinator, so they are neither rate-limited nor backed off: a single full sync of a large
 *  repository could fire hundreds of them, trip GitHub's secondary limiter, and — before the
 *  tri-state below — surface as "not authenticated" to a user who is signed in perfectly well.
 *  Short enough that an external `gh auth logout` is noticed promptly; every in-app credential
 *  change calls invalidate() instead of waiting for it. */
export const CREDENTIAL_CACHE_MS = 30_000

type Source = 'gh' | 'token'

/** One credential source, checked. `lastGood` is the last `ok` answer for THIS token, kept so that
 *  failing to reach GitHub does not un-sign-in a user GitHub has already vouched for. */
type SourceOutcome =
  | { status: 'absent' }
  | { status: 'ok'; credential: ResolvedGitHubCredential }
  | { status: 'unauthorized' }
  | {
      status: 'unknown'
      reason: 'rate-limited' | 'unreachable'
      retryAt?: number
      lastGood?: ResolvedGitHubCredential
    }

type CacheEntry = { at: number; outcome: SourceOutcome }

export class GitHubCredentialResolver {
  private readonly cache = new Map<GitHubAuthProvider, CacheEntry>()
  private readonly lastGood = new Map<Source, ResolvedGitHubCredential>()
  private readonly now: () => number

  constructor(private readonly dependencies: ResolverDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  /**
   * The credential to act with; null ONLY when there is none or GitHub refused it. When GitHub
   * could not be asked, the last credential it vouched for (same token) is returned; with no such
   * answer this throws a GitHubReachabilityError — never a null that would read as signed out.
   */
  async resolve(provider: GitHubAuthProvider): Promise<ResolvedGitHubCredential | null> {
    const cached = this.cache.get(provider)
    const at = this.now()
    const outcome = cached && at - cached.at < CREDENTIAL_CACHE_MS
      ? cached.outcome
      : await this.select(provider)
    // Every outcome is cached, a negative one too: "gh is logged out" and "GitHub is unreachable"
    // are exactly the states that would otherwise re-spawn `gh` on every epoch check of every
    // failing refresh.
    if (!cached || cached.outcome !== outcome) this.cache.set(provider, { at, outcome })
    return credentialFrom(outcome)
  }

  /** Drop the memo the moment the credential boundary moves (token saved/cleared, provider
   *  switched, project revoked) so the next resolve reflects the new reality immediately. */
  invalidate(): void {
    this.cache.clear()
  }

  async status(provider: GitHubAuthProvider): Promise<GitHubAuthStatus & { userId?: string }> {
    const gh = await this.fromGitHubCli()
    const stored = await this.dependencies.secret.readForHost()
    const token = await this.check('token', stored)
    const selected = provider === 'gh' ? gh : provider === 'token' ? token : autoChoice(gh, token)
    const active = selected.status === 'ok'
      ? selected.credential
      : selected.status === 'unknown' ? selected.lastGood : undefined
    return {
      selectedProvider: provider,
      activeProvider: active?.provider ?? null,
      ghAuthenticated: gh.status === 'ok' || (gh.status === 'unknown' && !!gh.lastGood),
      tokenPresent: stored !== null,
      storage: this.dependencies.secret.availability,
      ...(active ? { login: active.login, userId: active.userId } : {}),
      ...(selected.status === 'unknown'
        ? { unreachable: {
            reason: selected.reason,
            ...(selected.retryAt !== undefined ? { retryAt: selected.retryAt } : {})
          } }
        : {})
    }
  }

  private async select(provider: GitHubAuthProvider): Promise<SourceOutcome> {
    if (provider === 'gh') return this.fromGitHubCli()
    if (provider === 'token') return this.check('token', await this.dependencies.secret.readForHost())
    const gh = await this.fromGitHubCli()
    // Auto prefers the CLI. The saved token is read only when the CLI has no credential or GitHub
    // refused it — not when GitHub merely could not be asked, which would silently switch the
    // identity every request is made as for the length of an outage.
    if (gh.status === 'ok' || gh.status === 'unknown') return gh
    return this.check('token', await this.dependencies.secret.readForHost())
  }

  /** `gh auth token` only reads gh's local store. `gh auth status` is deliberately NOT used: it
   *  checks the token over the network and — measured on gh 2.45 with GitHub unreachable — reports
   *  "The token in hosts.yml is invalid" for what was a dropped connection. */
  private async fromGitHubCli(): Promise<SourceOutcome> {
    const result = await this.dependencies.run('gh', ['auth', 'token', '--hostname', 'github.com'])
    const token = result.ok ? result.stdout.trim() : ''
    return this.check('gh', token || null)
  }

  private async check(source: Source, token: string | null): Promise<SourceOutcome> {
    if (!token) return { status: 'absent' }
    const validation = await this.dependencies.validate(token)
    if (validation.status === 'ok') {
      const credential: ResolvedGitHubCredential = { ...validation.identity, provider: source, token }
      this.lastGood.set(source, credential)
      return { status: 'ok', credential }
    }
    if (validation.status === 'unauthorized') {
      this.lastGood.delete(source)
      return { status: 'unauthorized' }
    }
    const previous = this.lastGood.get(source)
    return {
      status: 'unknown',
      reason: validation.reason,
      ...(validation.retryAt !== undefined ? { retryAt: validation.retryAt } : {}),
      // Only for the SAME token: a newly logged-in account is not vouched for by the old one.
      ...(previous && previous.token === token ? { lastGood: previous } : {})
    }
  }
}

function autoChoice(gh: SourceOutcome, token: SourceOutcome): SourceOutcome {
  return gh.status === 'ok' || gh.status === 'unknown' ? gh : token
}

function credentialFrom(outcome: SourceOutcome): ResolvedGitHubCredential | null {
  if (outcome.status === 'ok') return outcome.credential
  if (outcome.status !== 'unknown') return null
  if (outcome.lastGood) return outcome.lastGood
  throw new GitHubReachabilityError(
    outcome.reason === 'rate-limited' ? 'rate-limited' : 'github-unreachable',
    outcome.retryAt
  )
}
