import { describe, it, expect, vi } from 'vitest'
import { listTerminalProfiles, parseWslDistributions, resolveTerminalProfile, type ProfileHost } from './terminal-profiles'
const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
function host(files: string[] = [ps]): ProfileHost {
  return { env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, exists: f => files.includes(f),
    find: () => null, run: vi.fn(async () => Buffer.alloc(0)) }
}
describe('native Windows profiles', () => {
  it('auto falls back to built-in PowerShell with no tools installed', async () => {
    expect(await resolveTerminalProfile('auto', 'C:\\work', '', host())).toEqual({ executable: ps, args: ['-NoLogo'] })
  })
  it('an explicit missing profile never opens a different shell', async () => {
    await expect(resolveTerminalProfile('pwsh', 'C:\\work', '', host())).rejects.toThrow('unavailable')
    await expect(resolveTerminalProfile('invented', 'C:\\work', '', host())).rejects.toThrow('unavailable')
  })
  it('keeps paths and arguments private in the catalog', async () => {
    const profiles = await listTerminalProfiles('', host())
    expect(profiles.find(p => p.id === 'windows-powershell')?.available).toBe(true)
    expect(JSON.stringify(profiles)).not.toContain('C:\\')
    expect(profiles.every(p => !('args' in p) && !('executable' in p))).toBe(true)
  })
  it('supports custom absolute exe paths with spaces and Unicode, refuses relative/script paths', async () => {
    const custom = 'C:\\Program Files\\Żółć\\shell.exe'
    expect((await resolveTerminalProfile('custom', 'C:\\work', custom, host([custom]))).executable).toBe(custom)
    await expect(resolveTerminalProfile('custom', 'C:\\work', 'shell.exe', host(['shell.exe']))).rejects.toThrow()
    await expect(resolveTerminalProfile('custom', 'C:\\work', 'C:\\shell.cmd', host(['C:\\shell.cmd']))).rejects.toThrow()
  })
  it('decodes UTF-16 WSL enumeration and preserves a distribution name as one argument', async () => {
    expect(parseWslDistributions(Buffer.from('\uFEFFUbuntu Test\r\nDebian\r\n', 'utf16le'))).toEqual(['Ubuntu Test', 'Debian'])
    const h = host(['C:\\Windows\\System32\\wsl.exe'])
    h.run = vi.fn(async (_file, args) => args.includes('--list')
      ? Buffer.from('Ubuntu Test\r\n', 'utf16le') : Buffer.from('/mnt/c/work space\n'))
    const plan = await resolveTerminalProfile('wsl:Ubuntu Test', 'C:\\work space', '', h)
    expect(plan.args.slice(0, 4)).toEqual(['--distribution', 'Ubuntu Test', '--cd', '/mnt/c/work space'])
    expect(plan.args.at(-1)).toBe('/mnt/c/work space')
    expect(plan.args.join(' ')).toContain('cd -- "$1" || exit 1')
  })
  it('does not mask a WSL translation failure', async () => {
    const h = host(['C:\\Windows\\System32\\wsl.exe'])
    h.run = vi.fn(async (_file, args) => {
      if (args.includes('--list')) return Buffer.from('Ubuntu\r\n', 'utf16le')
      throw new Error('distribution offline')
    })
    await expect(resolveTerminalProfile('wsl:Ubuntu', 'C:\\work', '', h)).rejects.toThrow('distribution offline')
  })
})
