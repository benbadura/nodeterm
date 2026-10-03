import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Project } from '../../shared/types'
import type { CorePlatform } from '../platform'
import { registerGitHubIntegration } from './integration'
import { IPC } from '../../shared/ipc'
import type { CommandRunner, GitHubSecretStore } from './credentials'

let userDataDir: string

const project: Project = {
  id: 'project-1',
  name: 'Test',
  color: '#8b5cf6',
  cwd: '/repo',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  kanban: {
    columns: [
      { id: 'todo', title: 'Todo', color: '#2563eb' },
      { id: 'done', title: 'Done', color: '#16a34a' }
    ],
    assignments: [],
    github: {
      repository: 'owner/repo',
      columnMappings: [
        { columnId: 'todo', label: 'status:todo' },
        { columnId: 'done', label: 'status:done' }
      ],
      completionColumnId: 'done'
    }
  }
}

/** Only the four members registerGitHubIntegration touches. */
function fakePlatform(): CorePlatform {
  const noop = (): void => undefined
  return {
    handle: noop,
    on: noop,
    handleWithSender: noop,
    onWithSender: noop,
    sendTo: noop
  } as unknown as CorePlatform
}

let realFetch: typeof globalThis.fetch
let userRequests = 0

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-github-integration-'))
  // registerGitHubIntegration builds its own token validator against api.github.com. Stub the
  // transport rather than adding a production seam that exists only for this test.
  realFetch = globalThis.fetch
  userRequests = 0
  globalThis.fetch = (async () => {
    userRequests += 1
    return new Response(JSON.stringify({ id: 1, login: 'octocat' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof globalThis.fetch
})

afterEach(async () => {
  globalThis.fetch = realFetch
  await fs.rm(userDataDir, { recursive: true, force: true })
})

describe('registerGitHubIntegration', () => {
  it('drops the memoised credential when the token changes, without waiting for its TTL', async () => {
    // The resolver memoises so the service's epoch re-checks stop spawning `gh` and spending a
    // /user request each. That memo must not outlive an in-app credential change: saving a token
    // and immediately reading a context has to see the NEW credential, not the cached old one.
    // Provider 'token' keeps the credential on the stored-token path, so clearing the token is a
    // real boundary move rather than something the gh path would paper over.
    const run: CommandRunner = async () => ({ ok: false, stdout: '', stderr: 'not logged in' })
    let stored: string | null = 'stored-token'
    const secret: GitHubSecretStore = {
      availability: 'encrypted',
      readForHost: async () => stored,
      save: async (value) => { stored = value },
      clear: async () => { stored = null }
    }

    const { controller } = registerGitHubIntegration({
      platform: fakePlatform(),
      userDataDir,
      project: async (id) => id === project.id
        ? { project, localApprovalId: 'local-1' }
        : null,
      detectRepository: async () => 'owner/repo',
      secret,
      run
    })

    const status = await controller.status('project-1')
    await controller.approve({
      projectId: 'project-1',
      repository: 'owner/repo',
      expectedRevision: status.control.revision
    })

    // Count the /user validations, since those are the requests the memo exists to stop — they
    // bypass the request coordinator entirely and so are never rate-limited or backed off.
    const before = userRequests
    await controller.contextForProject('project-1')
    expect(userRequests).toBe(before + 1)

    // Inside the TTL a second context reuses the memo, spending nothing.
    await controller.contextForProject('project-1')
    expect(userRequests).toBe(before + 1)

    // Clearing the saved token moves the credential boundary. Serving the stale memo here would
    // keep a revoked credential alive for the rest of the window.
    await controller.clearToken()
    await expect(controller.contextForProject('project-1')).rejects.toThrow('not-authenticated')
  })
})

describe('registerGitHubIntegration rate budget', () => {
  it('feeds each response budget to the coordinator under the credential identity, and shows it in status', async () => {
    const reset = Math.floor(Date.now() / 1_000) + 3_600
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ id: 1, login: 'octocat' }), { status: 200 })
      }
      return new Response('[]', {
        status: 200,
        headers: {
          etag: 'W/"top"',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '12',
          'x-ratelimit-reset': String(reset),
          'x-ratelimit-resource': 'core'
        }
      })
    }) as typeof globalThis.fetch
    const secret: GitHubSecretStore = {
      availability: 'encrypted',
      readForHost: async () => 'stored-token',
      save: async () => undefined,
      clear: async () => undefined
    }
    const { controller } = registerGitHubIntegration({
      platform: fakePlatform(),
      userDataDir,
      project: async (id) => id === project.id ? { project, localApprovalId: 'local-1' } : null,
      detectRepository: async () => 'owner/repo',
      secret,
      run: async () => ({ ok: false, stdout: '', stderr: 'not logged in' })
    })
    const initial = await controller.status('project-1')
    await controller.approve({
      projectId: 'project-1', repository: 'owner/repo', expectedRevision: initial.control.revision
    })

    const context = await controller.contextForProject('project-1')
    await context.client.issuesHeartbeat('owner/repo')

    const view = await controller.status('project-1')
    expect(view.rate).toMatchObject({ resource: 'core', limit: 5_000, remaining: 12, resetAt: reset * 1_000 })
    expect(view.throttle).toEqual({ until: reset * 1_000, kind: 'low-budget' })
  })
})

describe('registerGitHubIntegration revoke', () => {
  it('deletes the private issue cache from disk when this machine is revoked', async () => {
    const issue = {
      id: 1001, number: 1, title: 'Secret roadmap', body: 'private body', state: 'open',
      state_reason: null, html_url: 'https://github.com/owner/repo/issues/1',
      url: 'https://api.github.com/repos/owner/repo/issues/1', labels: [], assignees: [],
      created_at: '2026-08-01T10:00:00Z', updated_at: '2026-08-09T10:00:00Z', locked: false
    }
    globalThis.fetch = (async (input: RequestInfo | URL) => String(input).endsWith('/user')
      ? new Response(JSON.stringify({ id: 1, login: 'octocat' }), { status: 200 })
      : new Response(JSON.stringify([issue]), { status: 200, headers: { etag: 'W/"top"' } })
    ) as typeof globalThis.fetch
    const secret: GitHubSecretStore = {
      availability: 'encrypted',
      readForHost: async () => 'stored-token',
      save: async () => undefined,
      clear: async () => undefined
    }
    const { controller, service } = registerGitHubIntegration({
      platform: fakePlatform(),
      userDataDir,
      project: async (id) => id === project.id ? { project, localApprovalId: 'local-1' } : null,
      detectRepository: async () => 'owner/repo',
      secret,
      run: async () => ({ ok: false, stdout: '', stderr: 'not logged in' })
    })
    const initial = await controller.status('project-1')
    await controller.approve({
      projectId: 'project-1', repository: 'owner/repo', expectedRevision: initial.control.revision
    })
    await service.refresh({ projectId: 'project-1', full: true })
    const cacheDir = path.join(userDataDir, 'github-issues-cache')
    const cached = await fs.readdir(cacheDir)
    expect(cached).toHaveLength(1)
    expect(await fs.readFile(path.join(cacheDir, cached[0]), 'utf-8')).toContain('private body')

    const approved = await controller.status('project-1')
    await controller.revoke({ projectId: 'project-1', expectedRevision: approved.control.revision })

    expect(await fs.readdir(cacheDir)).toEqual([])
    expect(await fs.readdir(path.join(userDataDir, 'github-issues-bindings'))).toEqual([])
  })
})

describe('registerGitHubIntegration approval reaches the board', () => {
  it('prompts the project\'s subscribers to re-read when its approval changes', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => String(input).endsWith('/user')
      ? new Response(JSON.stringify({ id: 1, login: 'octocat' }), { status: 200 })
      : new Response('[]', { status: 200, headers: { etag: 'W/"top"' } })
    ) as typeof globalThis.fetch
    const sent: Array<[number, string, unknown]> = []
    const platform = {
      ...fakePlatform(),
      sendTo: (uiId: number, channel: string, payload: unknown) => { sent.push([uiId, channel, payload]) }
    } as unknown as CorePlatform
    let current: Project = project
    const { controller, service } = registerGitHubIntegration({
      platform,
      userDataDir,
      project: async (id) => id === current.id ? { project: current, localApprovalId: 'local-1' } : null,
      detectRepository: async () => 'owner/repo',
      secret: {
        availability: 'encrypted',
        readForHost: async () => 'stored-token',
        save: async () => undefined,
        clear: async () => undefined
      },
      run: async () => ({ ok: false, stdout: '', stderr: 'not logged in' })
    })
    const initial = await controller.status('project-1')
    await controller.approve({ projectId: 'project-1', repository: 'owner/repo', expectedRevision: initial.control.revision })
    await service.subscribe(5, { projectId: 'project-1' })

    // A pulled commit changes the mapping: the board is read only until this machine approves it.
    current = { ...project, kanban: { ...project.kanban!, github: { ...project.kanban!.github!, completionColumnId: 'todo' } } }
    expect((await service.query({ projectId: 'project-1', columnId: null, pageSize: 50 })).mappingNotApproved).toBe(true)
    sent.length = 0

    const status = await controller.status('project-1')
    await controller.approve({ projectId: 'project-1', repository: 'owner/repo', expectedRevision: status.control.revision })

    // The Settings overlay leaves the board mounted; without this prompt it stayed read only
    // until something changed on GitHub.
    expect(sent).toContainEqual([5, IPC.githubIssuesChanged('project-1'), []])
    expect((await service.query({ projectId: 'project-1', columnId: null, pageSize: 50 })).mappingNotApproved)
      .toBeUndefined()

    sent.length = 0
    const approved = await controller.status('project-1')
    await controller.revoke({ projectId: 'project-1', expectedRevision: approved.control.revision })
    expect(sent.some(([uiId, channel]) => uiId === 5 && channel === IPC.githubIssuesChanged('project-1'))).toBe(true)
  })
})
