import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  GitHubAuthProvider,
  GitHubControlState,
  GitHubProjectApproval
} from '../../shared/github-issues'
import { renameAtomic, tempNameFor } from '../fs-atomic'
import { parseGitHubRepository } from './config'

const FILE_NAME = 'github-issues-control.json'
const EMPTY_STATE: GitHubControlState = {
  version: 1,
  revision: 0,
  authProvider: 'auto',
  approvals: []
}

export class GitHubControlError extends Error {
  constructor(readonly code: 'revision-conflict' | 'invalid-control-input') {
    super(code)
  }
}

type ApprovalInput = {
  expectedRevision: number
  localApprovalId: string
  projectId: string
  repository: string
  mappingDigest?: string
}

function validString(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function validApproval(value: unknown): value is GitHubProjectApproval {
  if (!value || typeof value !== 'object') return false
  const approval = value as GitHubProjectApproval
  return validString(approval.localApprovalId, 128) &&
    validString(approval.projectId, 256) &&
    parseGitHubRepository(approval.repository) === approval.repository &&
    approval.enabled === true &&
    Number.isSafeInteger(approval.approvedAt) && approval.approvedAt > 0 &&
    (approval.mappingDigest === undefined || validString(approval.mappingDigest, 128))
}

function validState(value: unknown): value is GitHubControlState {
  if (!value || typeof value !== 'object') return false
  const state = value as GitHubControlState
  return state.version === 1 &&
    Number.isSafeInteger(state.revision) && state.revision >= 0 &&
    (state.authProvider === 'auto' || state.authProvider === 'gh' || state.authProvider === 'token') &&
    Array.isArray(state.approvals) && state.approvals.every(validApproval)
}

export class GitHubControlStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly userDataDir: string) {}

  private get filePath(): string {
    return path.join(this.userDataDir, FILE_NAME)
  }

  async load(): Promise<GitHubControlState> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf-8'))
      return validState(parsed) ? structuredClone(parsed) : structuredClone(EMPTY_STATE)
    } catch {
      return structuredClone(EMPTY_STATE)
    }
  }

  approve(input: ApprovalInput): Promise<GitHubControlState> {
    return this.mutate(input.expectedRevision, (state) => {
      if (!validString(input.localApprovalId, 128) ||
          !validString(input.projectId, 256) ||
          parseGitHubRepository(input.repository) !== input.repository ||
          (input.mappingDigest !== undefined && !validString(input.mappingDigest, 128))) {
        throw new GitHubControlError('invalid-control-input')
      }
      const approval: GitHubProjectApproval = {
        localApprovalId: input.localApprovalId,
        projectId: input.projectId,
        repository: input.repository,
        enabled: true,
        approvedAt: Date.now(),
        ...(input.mappingDigest ? { mappingDigest: input.mappingDigest } : {})
      }
      return {
        ...state,
        approvals: [
          ...state.approvals.filter((item) => item.localApprovalId !== input.localApprovalId),
          approval
        ]
      }
    })
  }

  revoke(input: { expectedRevision: number; localApprovalId: string }): Promise<GitHubControlState> {
    return this.mutate(input.expectedRevision, (state) => {
      if (!validString(input.localApprovalId, 128)) {
        throw new GitHubControlError('invalid-control-input')
      }
      return {
        ...state,
        approvals: state.approvals.filter((item) => item.localApprovalId !== input.localApprovalId)
      }
    })
  }

  selectProvider(input: {
    expectedRevision: number
    provider: GitHubAuthProvider
  }): Promise<GitHubControlState> {
    return this.mutate(input.expectedRevision, (state) => {
      if (input.provider !== 'auto' && input.provider !== 'gh' && input.provider !== 'token') {
        throw new GitHubControlError('invalid-control-input')
      }
      return { ...state, authProvider: input.provider }
    })
  }

  isApproved(
    state: GitHubControlState,
    input: { localApprovalId: string; projectId: string; repository: string }
  ): boolean {
    return state.approvals.some((approval) => approval.enabled &&
      approval.localApprovalId === input.localApprovalId &&
      approval.projectId === input.projectId &&
      approval.repository === input.repository)
  }

  /** Approved for WRITES: the repository approval, and the column mapping it was given for is the
   *  one on disk now. An approval from before mappings were bound carries no digest and never
   *  matches — it keeps reading (isApproved) until the user approves again. */
  isMappingApproved(
    state: GitHubControlState,
    input: { localApprovalId: string; projectId: string; repository: string; mappingDigest: string }
  ): boolean {
    return state.approvals.some((approval) => approval.enabled &&
      approval.localApprovalId === input.localApprovalId &&
      approval.projectId === input.projectId &&
      approval.repository === input.repository &&
      approval.mappingDigest === input.mappingDigest)
  }

  private mutate(
    expectedRevision: number,
    change: (state: GitHubControlState) => GitHubControlState
  ): Promise<GitHubControlState> {
    let resolveResult: (state: GitHubControlState) => void
    let rejectResult: (error: unknown) => void
    const result = new Promise<GitHubControlState>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const current = await this.load()
        if (!Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision) {
          throw new GitHubControlError('revision-conflict')
        }
        const next = { ...change(current), revision: current.revision + 1 }
        await this.write(next)
        resolveResult(structuredClone(next))
      } catch (error) {
        rejectResult(error)
      }
    })
    return result
  }

  private async write(state: GitHubControlState): Promise<void> {
    await fs.mkdir(this.userDataDir, { recursive: true })
    // Unique temp + retrying rename (core/fs-atomic.ts). mutate()'s writeQueue serializes writes
    // WITHIN this instance, but a second instance on the same data dir (Server Edition --data-dir)
    // shares nothing with it — the fixed `<file>.tmp` name this used to carry let two such writers
    // publish each other's half-written bytes. The unique name never self-heals, so a failed write
    // removes its own temp before rethrowing.
    const temporary = tempNameFor(this.filePath)
    try {
      await fs.writeFile(temporary, JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 })
      await fs.chmod(temporary, 0o600)
      await renameAtomic(temporary, this.filePath)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    await fs.chmod(this.filePath, 0o600)
  }
}
