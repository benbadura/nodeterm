import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..')
const script = path.join(root, 'scripts/windows-update-preflight.ps1')
const include = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8')
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const available = spawnSync(powershell, ['-NoProfile', '-Command', 'exit 0']).status === 0
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-update-fixture-'))
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }))

type Process = { Name: string; ExecutablePath: string | null }
const app: Process = { Name: 'nodeterm.exe', ExecutablePath: 'C:\\Apps\\nodeterm\\nodeterm.exe' }
const host: Process = {
  Name: 'nodeterm-session-host.exe',
  ExecutablePath: 'C:\\Apps\\nodeterm\\nodeterm-session-host.exe'
}
const staged: Process = {
  Name: 'nodeterm-sessionhost-v2.exe',
  ExecutablePath: 'C:\\Users\\me\\AppData\\Local\\nodeterm\\session-host\\0.4.0-0123456789abcdef\\nodeterm-sessionhost-v2.exe'
}
function probe(processes: Process[], fail = false, directory = 'C:\\Apps\\nodeterm'): number | null {
  // Override only the query, in a fresh PowerShell process. Never enumerate or stop real sessions.
  // Emit the parsed rows through a variable: Windows PowerShell 5.1's ConvertFrom-Json writes a
  // JSON array as ONE pipeline object, so a multi-process fixture reached the script as a single
  // array-valued "process" (real Get-CimInstance emits one object per process).
  const fixture = path.join(temp, 'processes.json')
  fs.writeFileSync(fixture, JSON.stringify(processes))
  const quote = (s: string): string => "'" + s.replace(/'/g, "''") + "'"
  const command = `function Get-CimInstance { param($ClassName, $ErrorAction)
    ${fail ? "throw 'fixture query denied'" : `$rows = Get-Content -Raw ${quote(fixture)} | ConvertFrom-Json; $rows`}
  }; & ${quote(script)} -InstallDirectory ${quote(directory)}; exit $LASTEXITCODE`
  return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    timeout: 15000
  }).status
}

describe.skipIf(!available)('installer preflight with disposable process-query fixtures', { timeout: 30000 }, () => {
  it.each([
    ['app closed / host live', [host], 10],
    ['app live / host live', [app, host], 10],
    ['app live / no host', [app], 10],
    ['app closed / host exited', [], 0],
    ['host fallback to original executable', [app], 10],
    ['host in another installation still blocks the old uninstaller', [{ ...host, ExecutablePath: 'D:\\Other\\nodeterm-session-host.exe' }], 10],
    ['case-insensitive Windows path', [{ ...host, ExecutablePath: host.ExecutablePath!.toUpperCase() }], 10],
    ['unknown host owner/path', [{ ...host, ExecutablePath: null }], 20],
    ['unknown app owner/path', [{ ...app, ExecutablePath: '' }], 20],
    ['uninstaller copied to temp is clear', [{ Name: 'Uninstall nodeterm.exe', ExecutablePath: 'C:\\Temp\\Uninstall nodeterm.exe' }], 0],
    ['legacy prefix-matched process blocks', [{ Name: 'helper.exe', ExecutablePath: 'C:\\Apps\\nodeterm-other\\helper.exe' }], 10],
    ['unrelated process outside installation is clear', [{ Name: 'helper.exe', ExecutablePath: 'C:\\Other\\helper.exe' }], 0],
    // Issue #829 step 3: a host running from its staged runtime outside the install directory
    // maps none of the installed files and must not block the update.
    ['staged host outside the installation is clear', [staged], 0],
    ['app closed / staged host live / legacy host gone is clear', [staged, { Name: 'svchost.exe', ExecutablePath: null }], 0],
    ['staged host plus the legacy host still blocks', [staged, host], 10],
    ['staged host plus the app still blocks', [staged, app], 10],
    ['staged image name inside the installation blocks by path', [{ ...staged, ExecutablePath: 'C:\\Apps\\nodeterm\\nodeterm-sessionhost-v2.exe' }], 10],
    ["another user's staged host with an unreadable path is clear", [{ ...staged, ExecutablePath: null }], 0]
  ] as const)('%s', (_name, processes, result) => {
    expect(probe([...processes])).toBe(result)
  })
  it('refuses failed queries and invalid installation paths', () => {
    expect(probe([], true)).toBe(20)
    expect(probe([], false, 'relative')).toBe(20)
  })
  it('supports spaces, apostrophes, trailing separators and UNC installations', () => {
    for (const directory of ["C:\\User's Apps\\nodeterm", '\\\\server\\share\\nodeterm', 'C:\\Apps\\nodeterm\\']) {
      expect(probe([{ ...host, ExecutablePath: directory.replace(/\\$/, '') + '\\nodeterm-session-host.exe' }], false, directory)).toBe(10)
    }
  })
})

describe('NSIS safety wiring', () => {
  it.skipIf(process.platform !== 'win32')('requires PowerShell fixtures on Windows CI', () => {
    expect(available).toBe(true)
  })
  it('replaces the stock destructive check in both installer and uninstaller', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    expect(pkg.build.nsis.include).toBe('build/installer.nsh')
    expect(include).toContain('!macro customCheckAppRunning')
    const templates = path.dirname(require.resolve('app-builder-lib/package.json')) + '/templates/nsis/'
    const running = fs.readFileSync(templates + 'include/allowOnlyOneInstallerInstance.nsh', 'utf8')
    expect(running).toMatch(/!ifmacrodef customCheckAppRunning\s+!insertmacro customCheckAppRunning\s+!else/)
    const install = fs.readFileSync(templates + 'installSection.nsh', 'utf8')
    const check = install.indexOf('!insertmacro CHECK_APP_RUNNING')
    expect(check).toBeGreaterThanOrEqual(0)
    expect(check).toBeLessThan(install.indexOf('!insertmacro uninstallOldVersion SHELL_CONTEXT'))
    expect(fs.readFileSync(templates + 'uninstaller.nsh', 'utf8')).toContain('!insertmacro CHECK_APP_RUNNING')
    expect(include).toContain('"${PROJECT_DIR}\\scripts\\windows-update-preflight.ps1"')
  })
  it('only proceeds on proven clear; silent, error and cancellation paths quit nonzero', () => {
    expect(include).toMatch(/\$R0 == 0\s+Goto nodeterm_preflight_clear/)
    expect(include).toMatch(/SetErrorLevel 2\s+IfSilent nodeterm_preflight_cancel/)
    expect(include).toMatch(/nodeterm_preflight_cancel:\s+Quit/)
    expect(include.match(/\/SD IDCANCEL/g)).toHaveLength(2)
    const production = include + fs.readFileSync(script, 'utf8')
    expect(production).not.toMatch(/\b(?:Stop-Process|taskkill|KILL_PROCESS|_CHECK_APP_RUNNING|Set-ExecutionPolicy)\b/i)
  })
})
