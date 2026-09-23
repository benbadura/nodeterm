import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TerminalProfile } from '../shared/terminal-profile'
import { findInPathString } from './exec-path'

const exec = promisify(execFile)
export interface TerminalLaunchPlan { executable: string; args: string[] }
export interface ProfileHost {
  env: NodeJS.ProcessEnv
  exists(file: string): boolean
  find(name: string): string | null
  run(file: string, args: string[]): Promise<Buffer>
}
const systemHost: ProfileHost = {
  env: process.env,
  exists: (file) => { try { return fs.statSync(file).isFile() } catch { return false } },
  find: (name) => findInPathString(name, process.env.PATH ?? process.env.Path ?? ''),
  run: async (file, args) => (await exec(file, args, {
    encoding: 'buffer', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024
  })).stdout
}
function executable(id: string, host: ProfileHost, custom = ''): string | undefined {
  const root = host.env.SystemRoot || 'C:\\Windows'
  const pf = host.env.ProgramFiles || 'C:\\Program Files'
  const candidates: Record<string, (string | null | undefined)[]> = {
    pwsh: [host.find('pwsh.exe'), path.win32.join(pf, 'PowerShell', '7', 'pwsh.exe')],
    'windows-powershell': [path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
    cmd: [host.env.COMSPEC, path.win32.join(root, 'System32', 'cmd.exe')],
    'git-bash': [path.win32.join(pf, 'Git', 'bin', 'bash.exe'),
      ...(host.env.LOCALAPPDATA ? [path.win32.join(host.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')] : [])],
    custom: [custom],
    wsl: [path.win32.join(root, 'System32', 'wsl.exe')]
  }
  return candidates[id]?.find((v): v is string => !!v && path.win32.isAbsolute(v) &&
    !/[\0\r\n]/.test(v) && /\.exe$/i.test(v) && host.exists(v))
}
export function parseWslDistributions(bytes: Buffer): string[] {
  const text = bytes.includes(0) ? bytes.toString('utf16le') : bytes.toString('utf8')
  return [...new Set(text.replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(
    s => !!s && !/[\x00-\x1f]/.test(s)
  ))]
}
async function distributions(host: ProfileHost): Promise<string[]> {
  const wsl = executable('wsl', host)
  return wsl ? parseWslDistributions(await host.run(wsl, ['--list', '--quiet'])) : []
}
export async function listTerminalProfiles(custom = '', host = systemHost): Promise<TerminalProfile[]> {
  const choices = [
    ['auto', 'Automatic', 'native'], ['pwsh', 'PowerShell 7', 'native'],
    ['windows-powershell', 'Windows PowerShell', 'native'], ['cmd', 'Command Prompt', 'native'],
    ['git-bash', 'Git Bash', 'posix'], ['custom', 'Custom executable', 'custom']
  ] as const
  const profiles: TerminalProfile[] = choices.map(([id, label, kind]) => {
    const available = id === 'auto' ? ['pwsh', 'windows-powershell', 'cmd'].some(p => executable(p, host)) : !!executable(id, host, custom)
    return { id, label, kind, available, ...(!available ? { unavailableReason: 'Executable not installed or unavailable.' } : {}) }
  })
  try {
    for (const name of await distributions(host)) profiles.push({ id: `wsl:${name}`, label: `WSL: ${name}`, kind: 'wsl', available: true })
  } catch {
    profiles.push({ id: 'wsl:unavailable', label: 'WSL', kind: 'wsl', available: false, unavailableReason: 'Could not enumerate WSL distributions.' })
  }
  return profiles
}
export async function resolveTerminalProfile(id: string, cwd: string, custom = '', host = systemHost): Promise<TerminalLaunchPlan> {
  if (typeof id !== 'string' || /[\x00-\x1f]/.test(id)) throw new Error('Invalid terminal profile.')
  if (id.startsWith('wsl:')) {
    const distribution = id.slice(4)
    const wsl = executable('wsl', host)
    if (!wsl || !(await distributions(host)).includes(distribution)) throw new Error(`WSL distribution unavailable: ${distribution}`)
    const bytes = await host.run(wsl, ['--distribution', distribution, '--exec', 'wslpath', '-a', '-u', cwd])
    const linuxCwd = bytes.toString('utf8').trim()
    if (!linuxCwd.startsWith('/') || /[\0\r\n]/.test(linuxCwd)) throw new Error('WSL could not translate the project directory.')
    return { executable: wsl, args: ['--distribution', distribution, '--cd', linuxCwd, '--exec', '/bin/sh', '-c',
      'cd -- "$1" || exit 1; exec "${SHELL:-/bin/sh}" -l', 'nodeterm', linuxCwd] }
  }
  if (id === 'auto') {
    for (const candidate of ['pwsh', 'windows-powershell', 'cmd']) {
      const file = executable(candidate, host)
      if (file) return { executable: file, args: candidate === 'cmd' ? ['/d'] : ['-NoLogo'] }
    }
    throw new Error('No Windows terminal profile is available.')
  }
  const file = executable(id, host, custom)
  if (!file) throw new Error(`Terminal profile unavailable: ${id}`)
  return { executable: file, args: id === 'git-bash' ? ['--login', '-i'] : id === 'cmd' ? ['/d'] : [] }
}
