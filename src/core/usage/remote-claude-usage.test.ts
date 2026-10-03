// The remote-usage command is generated shell that no compiler checks, running on a machine we
// cannot inspect — the same class of code as the canvas-control shim, and tested the same way:
// the real script, run by the real /bin/sh, against a fake `curl` on PATH and a fake $HOME. A
// quoting slip here does not fail loudly; it returns an empty pill and looks like "the host has
// no usage", which is precisely the bug this feature exists to fix.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ClaudeAccount } from '../../shared/types'
import {
  fetchRemoteUsage,
  parseRemoteUsageOutput,
  remoteUsageCommand,
  remoteUsageTargets,
  type RemoteUsageTarget
} from './remote-claude-usage'

const run = promisify(execFile)

let dir = ''
let home = ''
let bin = ''

/** Where the fake curl records what it was handed, so the token's path can be asserted. */
const argvLog = (): string => path.join(dir, 'curl-argv.txt')
const stdinLog = (): string => path.join(dir, 'curl-stdin.txt')

const USAGE_BODY = JSON.stringify({
  limits: [
    { kind: 'session', group: 'session', percent: 60, severity: 'normal' },
    { kind: 'weekly_all', group: 'weekly', percent: 12, severity: 'normal' }
  ]
})

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-rusage-'))
  home = path.join(dir, 'home')
  bin = path.join(dir, 'bin')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(bin, { recursive: true })
  // Stands in for curl: records argv + stdin, then emits a body plus the `-w` marker the real
  // curl would append. Everything the command does around it (reading the files, piping the
  // config, the markers) is the real thing.
  fs.writeFileSync(
    path.join(bin, 'curl'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" > ${JSON.stringify(argvLog())}`,
      `cat > ${JSON.stringify(stdinLog())}`,
      `printf '%s' ${JSON.stringify(USAGE_BODY)}`,
      "printf '\\n__NTU_HTTP__200\\n'",
      ''
    ].join('\n'),
    { mode: 0o755 }
  )
  // A host with the ordinary text tools but no curl. Emptying PATH instead would break the
  // credential read too and report `nocreds` — a different, misleading answer.
  const noCurl = path.join(dir, 'nocurl-bin')
  fs.mkdirSync(noCurl, { recursive: true })
  for (const tool of ['tr', 'grep', 'sed', 'head', 'cat']) {
    const real = ['/usr/bin', '/bin'].map((p) => path.join(p, tool)).find((p) => fs.existsSync(p))
    if (real) fs.symlinkSync(real, path.join(noCurl, tool))
  }
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Run the generated command in a sandboxed $HOME, with the fake curl first on PATH. */
async function runCommand(
  accountId: string | null,
  opts: { curl?: boolean } = {}
): Promise<string> {
  const { stdout } = await run('/bin/sh', ['-c', remoteUsageCommand(accountId)], {
    env: {
      HOME: home,
      // `command -v curl` genuinely fails on the no-curl PATH — the real branch, not a mock of it.
      PATH: opts.curl === false ? path.join(dir, 'nocurl-bin') : `${bin}:${process.env.PATH ?? ''}`
    }
  })
  return stdout
}

function writeCreds(dirPath: string, token: string, pretty = false): void {
  fs.mkdirSync(dirPath, { recursive: true })
  const body = { claudeAiOauth: { accessToken: token } }
  fs.writeFileSync(
    path.join(dirPath, '.credentials.json'),
    pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body)
  )
}

describe('remoteUsageTargets', () => {
  const accounts: ClaudeAccount[] = [
    { id: 'acc-1', label: 'Work', host: 'root@alpha', createdAt: 0 },
    { id: 'acc-2', label: 'Half-done', host: 'root@alpha', pending: true, createdAt: 0 },
    { id: 'acc-3', label: 'Elsewhere', host: 'root@beta', createdAt: 0 },
    { id: 'acc-4', label: 'Local', createdAt: 0 }
  ]

  it('offers the system account plus the host-matched managed ones', () => {
    const t = remoteUsageTargets([{ projectId: 'p1', hostKey: 'root@alpha' }], accounts)
    expect(t.map((x) => x.accountId)).toEqual([null, 'acc-1'])
    expect(t[0].label).toBe('root@alpha')
    expect(t[1].label).toBe('Work')
    expect(t.every((x) => x.projectId === 'p1')).toBe(true)
  })

  it('reads a shared host once, through its first connected project', () => {
    const t = remoteUsageTargets(
      [
        { projectId: 'p1', hostKey: 'root@alpha' },
        { projectId: 'p2', hostKey: 'root@alpha' },
        { projectId: 'p3', hostKey: 'root@beta' }
      ],
      accounts
    )
    expect(t.map((x) => x.key)).toEqual(['root@alpha#', 'root@alpha#acc-1', 'root@beta#', 'root@beta#acc-3'])
    expect(t.find((x) => x.hostKey === 'root@alpha')?.projectId).toBe('p1')
  })

  it('has nothing to offer with no connections', () => {
    expect(remoteUsageTargets([], accounts)).toEqual([])
  })

  it('refuses an account id that could escape the accounts root', () => {
    const t = remoteUsageTargets(
      [{ projectId: 'p1', hostKey: 'root@alpha' }],
      [{ id: '../../.ssh', label: 'evil', host: 'root@alpha', createdAt: 0 }]
    )
    expect(t.map((x) => x.accountId)).toEqual([null])
  })
})

describe('remoteUsageCommand', () => {
  it('refuses a hostile account id at the interpolation site', () => {
    expect(() => remoteUsageCommand('a"; rm -rf ~; #')).toThrow()
    expect(() => remoteUsageCommand('../other')).toThrow()
  })

  it('reads the system account from ~/.claude and a managed one from its config dir', () => {
    expect(remoteUsageCommand(null)).toContain('"$HOME/.claude/.credentials.json"')
    expect(remoteUsageCommand('acc-1')).toContain(
      '"$HOME/.nodeterm/claude-accounts/acc-1/.credentials.json"'
    )
  })

  it('never puts the token on curl’s command line', () => {
    // `-H "authorization: …"` would be visible in `ps` to every other user on the host.
    expect(remoteUsageCommand(null)).toContain('--config -')
    expect(remoteUsageCommand(null)).not.toMatch(/-H\s+["']?authorization/i)
  })
})

describe('the generated command, run by /bin/sh', () => {
  it('reads the system account and returns the usage payload', async () => {
    writeCreds(path.join(home, '.claude'), 'tok-system')
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } })
    )
    const out = parseRemoteUsageOutput(await runCommand(null))
    expect(out.complete).toBe(true)
    expect(out.reason).toBeNull()
    expect(out.httpCode).toBe(200)
    expect(out.email).toBe('me@example.com')
    expect(JSON.parse(out.body).limits).toHaveLength(2)
    // The token reached curl on STDIN and never through argv.
    expect(fs.readFileSync(stdinLog(), 'utf-8')).toContain('Bearer tok-system')
    expect(fs.readFileSync(argvLog(), 'utf-8')).not.toContain('tok-system')
  })

  it('takes the subscription token, not an MCP server’s', async () => {
    // Found against a real credentials file: every MCP server the CLI has authorized keeps its
    // own "accessToken" under `mcpOAuth`. Grabbing the first match in the file sends an MCP token
    // to the usage endpoint, which answers 401 — so a perfectly signed-in host reported "not
    // signed in". Both key orders, since the writer does not promise one.
    for (const body of [
      { mcpOAuth: { 'srv-a': { accessToken: 'tok-mcp' } }, claudeAiOauth: { accessToken: 'tok-real' } },
      { claudeAiOauth: { accessToken: 'tok-real', scopes: ['user:inference'] }, mcpOAuth: { 'srv-a': { accessToken: 'tok-mcp' } } }
    ]) {
      fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify(body))
      await runCommand(null)
      const sent = fs.readFileSync(stdinLog(), 'utf-8')
      expect(sent).toContain('Bearer tok-real')
      expect(sent).not.toContain('tok-mcp')
    }
  })

  it('still reads a flat top-level credentials shape', async () => {
    // What `parseCreds` accepts as its fallback (`j.claudeAiOauth ?? j`) must work here too.
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ accessToken: 'tok-flat', expiresAt: 1 })
    )
    await runCommand(null)
    expect(fs.readFileSync(stdinLog(), 'utf-8')).toContain('Bearer tok-flat')
  })

  it('parses a pretty-printed credentials file', async () => {
    writeCreds(path.join(home, '.claude'), 'tok-pretty', true)
    await runCommand(null)
    expect(fs.readFileSync(stdinLog(), 'utf-8')).toContain('Bearer tok-pretty')
  })

  it('reads a managed account from its own config dir', async () => {
    const accDir = path.join(home, '.nodeterm', 'claude-accounts', 'acc-1')
    writeCreds(accDir, 'tok-managed')
    fs.writeFileSync(
      path.join(accDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'work@example.com' } })
    )
    const out = parseRemoteUsageOutput(await runCommand('acc-1'))
    expect(out.email).toBe('work@example.com')
    expect(fs.readFileSync(stdinLog(), 'utf-8')).toContain('Bearer tok-managed')
  })

  it('reports nocreds — without calling curl — when the account has never logged in', async () => {
    const out = parseRemoteUsageOutput(await runCommand('acc-never'))
    expect(out.complete).toBe(true)
    expect(out.reason).toBe('nocreds')
    expect(out.email).toBeNull()
  })

  it('reports nocurl on a host without curl', async () => {
    writeCreds(path.join(home, '.claude'), 'tok-system')
    const out = parseRemoteUsageOutput(await runCommand(null, { curl: false }))
    expect(out.reason).toBe('nocurl')
  })
})

describe('parseRemoteUsageOutput', () => {
  it('discards everything outside the marker block', () => {
    const out = parseRemoteUsageOutput(
      ['Welcome to Ubuntu 22.04!', 'Last login: today', '__NTU_BEGIN__', '__NTU_EMAIL__a@b.c', '{"limits":[]}', '__NTU_HTTP__200', '__NTU_END__', 'logout'].join('\n')
    )
    expect(out.complete).toBe(true)
    expect(out.body).toBe('{"limits":[]}')
    expect(out.email).toBe('a@b.c')
  })

  it('reports an incomplete run when the command never finished', () => {
    const out = parseRemoteUsageOutput('__NTU_BEGIN__\n__NTU_EMAIL__a@b.c\n')
    expect(out.complete).toBe(false)
  })

  it('is not fooled by empty output', () => {
    expect(parseRemoteUsageOutput('').complete).toBe(false)
  })
})

describe('fetchRemoteUsage', () => {
  const target: RemoteUsageTarget = {
    key: 'root@alpha#',
    hostKey: 'root@alpha',
    projectId: 'p1',
    accountId: null,
    label: 'root@alpha'
  }
  const reply = (...lines: string[]): string =>
    ['__NTU_BEGIN__', ...lines, '__NTU_END__'].join('\n')

  it('maps a 200 into limits', async () => {
    const u = await fetchRemoteUsage(
      target,
      async () => reply('__NTU_EMAIL__me@example.com', USAGE_BODY, '__NTU_HTTP__200'),
      1000
    )
    expect(u.status).toBe('ok')
    expect(u.email).toBe('me@example.com')
    expect(u.limits.map((l) => l.usedPercent)).toEqual([60, 12])
    expect(u.session?.leftPercent).toBe(40)
  })

  it('treats a logged-out account as unavailable (hidden), not an error', async () => {
    const u = await fetchRemoteUsage(target, async () => reply('__NTU_EMAIL__', '__NTU_STATUS__nocreds'), 1)
    expect(u.status).toBe('unavailable')
  })

  it('treats an API-key / expired token (401) as unavailable', async () => {
    const u = await fetchRemoteUsage(target, async () => reply('__NTU_EMAIL__', '{}', '__NTU_HTTP__401'), 1)
    expect(u.status).toBe('unavailable')
  })

  it('says so when the endpoint rate-limited the read (429), and only then', async () => {
    const limited = await fetchRemoteUsage(
      target,
      async () => reply('__NTU_EMAIL__me@example.com', '{"error":{"type":"rate_limit_error"}}', '__NTU_HTTP__429'),
      1
    )
    expect(limited).toMatchObject({ status: 'error', rateLimited: true, email: 'me@example.com' })
    const http500 = await fetchRemoteUsage(target, async () => reply('oops', '__NTU_HTTP__500'), 1)
    expect(http500.rateLimited).toBeUndefined()
  })

  it('keeps a broken read visible as an error', async () => {
    const missingCurl = await fetchRemoteUsage(target, async () => reply('__NTU_STATUS__nocurl'), 1)
    expect(missingCurl.status).toBe('error')
    const http500 = await fetchRemoteUsage(target, async () => reply('oops', '__NTU_HTTP__500'), 1)
    expect(http500.status).toBe('error')
    const garbage = await fetchRemoteUsage(target, async () => reply('not json', '__NTU_HTTP__200'), 1)
    expect(garbage.status).toBe('error')
  })

  it('never reports unavailable when the command could not run at all', async () => {
    // A dead master / disconnected project says nothing about whether the account has a
    // subscription — reporting 'unavailable' would silently drop the row from the popover.
    expect((await fetchRemoteUsage(target, async () => null, 1)).status).toBe('error')
    expect((await fetchRemoteUsage(target, async () => 'ssh: connect failed', 1)).status).toBe('error')
    expect(
      (
        await fetchRemoteUsage(
          target,
          () => Promise.reject(new Error('master gone')),
          1
        )
      ).status
    ).toBe('error')
  })
})
