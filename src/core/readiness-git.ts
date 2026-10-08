import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { createReadStream, promises as fs } from 'fs'
import path from 'path'
import { gitEnv } from './git-env'

const run = promisify(execFile)
const PATHS = ['.', ':(exclude).nodeterm', ':(exclude,glob)**/.nodeterm/**']
const ignored = (p: string): boolean => p.split('/').includes('.nodeterm')
export async function readinessGit(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await run('git', args, { cwd, env: { ...gitEnv(), GIT_OPTIONAL_LOCKS: '0' }, encoding: 'buffer', timeout: 15000, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}
export async function readinessHead(cwd: string): Promise<{ checkout: string; head: string }> {
  const checkout = await fs.realpath((await readinessGit(cwd, ['rev-parse', '--show-toplevel'])).toString().trim())
  const head = (await readinessGit(checkout, ['rev-parse', '--verify', 'HEAD'])).toString().trim()
  return { checkout, head }
}
interface Measurement { checkout: string; head: string; fingerprint: string; untracked: string[] }

async function measure(cwd: string): Promise<Measurement> {
  const { checkout, head } = await readinessHead(cwd)
  const tracked = await readinessGit(checkout, ['ls-files', '--stage', '-z'])
  if (tracked.toString().split('\0').some((p) => /^\d+ [a-f0-9]+ [123]\t/.test(p))) throw new Error('Resolve merge conflicts before capturing readiness evidence.')
  if (tracked.toString().split('\0').some((p) => p.startsWith('160000 '))) throw new Error('Submodule contents cannot be fully verified in this version.')
  const [flags, other] = await Promise.all([
    readinessGit(checkout, ['ls-files', '-v', '-z']),
    readinessGit(checkout, ['ls-files', '--others', '--exclude-standard', '-z'])
  ])
  if (flags.toString().split('\0').some((p) => p && !ignored(p.slice(2)) && (/^[a-z] /.test(p) || p.startsWith('S ')))) throw new Error('Cannot fully verify assume-unchanged or sparse checkout entries.')
  const entries = tracked.toString().split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t')
    return { name: entry.slice(tab + 1), index: entry.slice(0, tab) }
  }).filter((e) => !ignored(e.name)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const untracked = other.toString().split('\0').filter((p) => p && !ignored(p)).sort()
  const hash = createHash('sha256')
  hash.update(head).update(JSON.stringify(entries))
  let totalBytes = 0
  let untrackedBytes = 0
  const newFiles = new Set(untracked)
  for (const name of [...entries.map((e) => e.name), ...untracked]) {
    const file = path.join(checkout, name)
    const before = await fs.lstat(file).catch((e) => {
      if (!newFiles.has(name) && (e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw e
    })
    if (!before) { hash.update(JSON.stringify([name, 'deleted'])); continue }
    totalBytes += before.size
    if (newFiles.has(name)) untrackedBytes += before.size
    if (untrackedBytes > 64 * 1024 * 1024) throw new Error('Untracked files exceed the 64 MiB snapshot limit. Ignore generated files or stage the relevant files.')
    if (totalBytes > 256 * 1024 * 1024) throw new Error('Checkout contents exceed the 256 MiB snapshot limit; freshness cannot be verified.')
    const content = createHash('sha256')
    if (before.isSymbolicLink()) content.update(await fs.readlink(file))
    else if (before.isFile()) for await (const chunk of createReadStream(file)) content.update(chunk)
    else throw new Error('Cannot snapshot this file type.')
    const after = await fs.lstat(file)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw new Error('Code changed while the snapshot was being read. Try again.')
    hash.update(JSON.stringify([name, before.mode & 0o111, content.digest('hex')]))
  }
  return { checkout, head, fingerprint: hash.digest('hex'), untracked }
}

// One in-flight measurement per checkout. A completed read is never reused as proof of freshness.
const flights = new Map<string, Promise<Measurement>>()
export async function measureReadiness(cwd: string): Promise<Measurement> {
  const { checkout } = await readinessHead(cwd)
  const existing = flights.get(checkout)
  if (existing) return existing
  const promise = (async () => {
    const first = await measure(checkout)
    const second = await measure(checkout)
    if (first.fingerprint !== second.fingerprint) throw new Error('Code changed while the snapshot was being read. Try again.')
    return second
  })()
  flights.set(checkout, promise)
  try { return await promise } finally { if (flights.get(checkout) === promise) flights.delete(checkout) }
}

export async function readinessFiles(checkout: string, baseCommit: string, untracked: string[]): Promise<string[]> {
  const changed = (await readinessGit(checkout, ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', baseCommit, '--', ...PATHS])).toString().split('\0').filter(Boolean)
  return [...new Set([...changed, ...untracked])].filter((p) => !ignored(p)).sort()
}
