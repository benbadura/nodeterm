import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitEnv } from '../../src/core/git-env'
import { createAgentWorktree } from '../../src/renderer/lib/agentWorkspace'
import { worktreeAdd, type GitExecutor } from '../../src/shared/worktree-ops'
import type { GroupWorktree } from '../../src/shared/worktree'

let directory: string | undefined
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

describe('manual agent worktrees with real Git', () => {
  it('creates five independent checkouts, launches in their directories and preserves dirty source files', async () => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'nt-agent-workspace-')))
    const repo = join(directory, 'repo')
    mkdirSync(repo)
    const env = {
      ...gitEnv(),
      TMPDIR: directory,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(directory, 'no-global-config')
    }
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'user.email', 'test@example.invalid')
    git(repo, 'config', 'commit.gpgSign', 'false')
    writeFileSync(join(repo, 'code.txt'), 'committed base')
    git(repo, 'add', 'code.txt')
    git(repo, 'commit', '-m', 'base')
    writeFileSync(join(repo, 'code.txt'), 'uncommitted source edit')
    writeFileSync(join(repo, 'local.txt'), 'untracked source file')
    const originalStatus = git(repo, 'status', '--porcelain')
    const execute: GitExecutor = async (cwd, args) => {
      const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
      if (result.error) throw result.error
      return { ok: result.status === 0, out: result.stdout, err: result.stderr }
    }
    const groups = new Map<string, GroupWorktree>()
    const launches: string[] = []
    const deps = {
      worktreeAdd: (repoPath: string, path: string, branch: string, base: string, isNew: boolean) =>
        worktreeAdd(execute, repoPath, path, branch, base, isNew),
      activeProjectId: () => 'project',
      isCurrent: () => true,
      attach: (_target: unknown, worktree: GroupWorktree) => {
        groups.set(worktree.branch, worktree)
        return worktree.branch
      },
      openAgent: (groupId: string) => {
        const cwd = groups.get(groupId)!.path
        // A real child process, standing in for the agent CLI, sees the frame's checkout.
        launches.push(execFileSync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {
          cwd, encoding: 'utf8'
        }))
        return true
      }
    }
    const options = { projectId: 'project', target: () => ({ groupId: null }) }
    for (let i = 0; i < 5; i++) {
      const path = join(directory, `agent-${i}`)
      const branch = `feature/agent-${i}`
      expect(await createAgentWorktree(deps, { repoPath: repo, path, branch, baseRef: 'main', mode: 'new' }, options))
        .toMatchObject({ ok: true, agentCreated: true })
      expect(git(path, 'branch', '--show-current')).toBe(branch)
      expect(git(path, 'status', '--porcelain')).toBe('')
      expect(readFileSync(join(path, 'code.txt'), 'utf8')).toBe('committed base')
      expect(realpathSync(git(path, 'rev-parse', '--git-common-dir'))).toBe(realpathSync(join(repo, '.git')))
      writeFileSync(join(path, 'code.txt'), `agent ${i} edit`)
    }
    expect(new Set(launches).size).toBe(5)
    for (const [i, cwd] of launches.entries()) {
      expect(cwd).toBe(join(directory, `agent-${i}`))
      expect(readFileSync(join(cwd, 'code.txt'), 'utf8')).toBe(`agent ${i} edit`)
    }
    expect(git(repo, 'status', '--porcelain')).toBe(originalStatus)
    expect(readFileSync(join(repo, 'code.txt'), 'utf8')).toBe('uncommitted source edit')
    const collision = await createAgentWorktree(deps, {
      repoPath: repo, path: join(directory, 'duplicate'), branch: 'feature/agent-0', baseRef: 'main', mode: 'new'
    }, options)
    expect(collision).toMatchObject({ ok: false, reason: 'git' })
    expect(groups.size).toBe(5)
    expect(launches).toHaveLength(5)
  })
})
