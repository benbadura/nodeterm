import { describe, it, expect } from 'vitest'
import { build, type Plugin } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { testTmpDir } from '../core/test-tmp'

/**
 * `scripts/install-server.sh` and the Dockerfile install with `npm ci --ignore-scripts` (the repo's
 * postinstall rebuilds natives for ELECTRON's ABI, not the server's), then run `npm run
 * server:build`. So on every Server Edition host — a fresh install, a "Share with team", every
 * daily auto-update, every image build — the bundle is built with NO compiled native addon except
 * node-pty, which is rebuilt AFTERWARDS.
 *
 * That broke on 2026-09-30, when the in-process SSH transport brought in ssh2. Bundled, ssh2 pulls
 * in `cpu-features`, whose index requires `../build/Release/cpufeatures.node` unconditionally, so
 * esbuild fails on such a host; on a machine whose install scripts DID run it instead reaches
 * ssh2's own `sshcrypto.node` and fails for want of a `.node` loader. Every host's auto-update
 * then died at `server:build`, leaving the service on its last good build with nothing on screen
 * saying so, and no CI job builds the server bundle. The fix keeps ssh2 external (it is a runtime
 * dependency, and its native parts are optional and required inside a `try`). These tests build
 * the server exactly as `package.json` says, in both views of node_modules.
 */

const repo = path.resolve(__dirname, '../..')

/** `server:build`'s esbuild arguments, read from package.json so the test cannot drift from them. */
function serverBuildArgs(): { entry: string; externals: string[]; tsconfig?: string } {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  const tokens = pkg.scripts['server:build'].split(/\s+/)
  expect(tokens[0]).toBe('esbuild')
  const entry = tokens.slice(1).find((t) => !t.startsWith('--'))
  expect(entry).toBeTruthy()
  return {
    entry: entry!,
    externals: tokens.filter((t) => t.startsWith('--external:')).map((t) => t.slice('--external:'.length)),
    tsconfig: tokens.find((t) => t.startsWith('--tsconfig='))?.slice('--tsconfig='.length)
  }
}

/** Top-level packages whose native addon is compiled by an install script (a `binding.gyp`
 *  somewhere in the package, nested node_modules excluded). These are what `--ignore-scripts`
 *  leaves without their `build/` output. */
function scriptBuiltNativePackages(nodeModules: string): string[] {
  const hasGyp = (dir: string, depth: number): boolean => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    if (entries.some((e) => e.isFile() && e.name === 'binding.gyp')) return true
    if (depth === 0) return false
    return entries.some((e) => e.isDirectory() && e.name !== 'node_modules' && hasGyp(path.join(dir, e.name), depth - 1))
  }
  const out: string[] = []
  for (const name of fs.readdirSync(nodeModules)) {
    if (name.startsWith('.')) continue
    const names = name.startsWith('@') ? fs.readdirSync(path.join(nodeModules, name)).map((n) => `${name}/${n}`) : [name]
    for (const n of names) if (hasGyp(path.join(nodeModules, n), 4)) out.push(n)
  }
  return out
}

/** Copy a package without any `build/` directory holding compiled output. */
function copyWithoutBuildOutput(from: string, to: string): void {
  fs.cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      if (path.basename(src) !== 'build') return true
      return !fs.existsSync(path.join(src, 'Release')) && !fs.existsSync(path.join(src, 'Debug'))
    }
  })
}

type BuildErrors = { errors: Array<{ text: string; location?: { file?: string } | null }> }

async function buildServer(outfile: string, plugins: Plugin[]): Promise<string[]> {
  const { entry, externals, tsconfig } = serverBuildArgs()
  const result: BuildErrors = await build({
    absWorkingDir: repo,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: externals,
    tsconfig,
    logLevel: 'silent',
    plugins
  }).catch((e: { errors?: BuildErrors['errors'] }) => ({ errors: e.errors ?? [{ text: String(e) }] }))
  return result.errors.map((e) => `${e.location?.file ?? ''}: ${e.text}`)
}

describe('server:build', () => {
  it('bundles on a host installed with --ignore-scripts (no install-script-built native addon)', async () => {
    const { externals } = serverBuildArgs()
    const nodeModules = path.join(repo, 'node_modules')
    const natives = scriptBuiltNativePackages(nodeModules).filter((p) => !externals.includes(p))
    // The scan must find something, or the test checks nothing: cpu-features (reached through
    // ssh2) ships a binding.gyp today.
    expect(natives.length).toBeGreaterThan(0)

    const tmp = testTmpDir('nt-server-build-')
    const stripped = path.join(tmp, 'node_modules')
    for (const p of natives) copyWithoutBuildOutput(path.join(nodeModules, p), path.join(stripped, p))
    // A bare import of one of those packages resolves into the stripped copy, and everything inside
    // it (its own `../build/Release/x.node`) then resolves there too, exactly as on the host. Any
    // other bare import made FROM a stripped copy goes back to the real node_modules, which is
    // where the host has it.
    const packageOf = (spec: string): string => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')
    const ignoreScripts: Plugin = {
      name: 'ignore-scripts-node-modules',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.namespace !== 'file' || args.pluginData === 'stripped' || args.path.includes(':')) return undefined
          const pkg = packageOf(args.path)
          if (externals.includes(pkg)) return undefined
          if (natives.includes(pkg)) return b.resolve(args.path, { resolveDir: tmp, kind: args.kind, pluginData: 'stripped' })
          if (args.importer.startsWith(stripped + path.sep)) {
            return b.resolve(args.path, { resolveDir: repo, kind: args.kind, pluginData: 'stripped' })
          }
          return undefined
        })
      }
    }
    expect(await buildServer(path.join(tmp, 'main.cjs'), [ignoreScripts])).toEqual([])
  }, 60_000)

  // The other half: a machine whose install scripts DID run (a developer's, `server:dev`) has the
  // compiled addons, and esbuild then reaches a `.node` file it has no loader for. Whatever this
  // checkout's node_modules holds, the build must not depend on it.
  it('bundles against node_modules as installed here', async () => {
    expect(await buildServer(path.join(testTmpDir('nt-server-build-'), 'main.cjs'), [])).toEqual([])
  }, 60_000)
})
