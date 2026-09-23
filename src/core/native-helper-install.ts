import fs from 'node:fs'
import path from 'node:path'
import { platform } from './platform'
import { renameAtomicSync, tempNameFor } from './fs-atomic'

const quote = (v: string): string => "'" + v.replaceAll("'", "''") + "'"
export function nativeHelperScript(executable: string, bundle: string, identityRoot: string, args: string[]): string {
  // PowerShell sees the physical archive only; Electron's Node runtime resolves its contents.
  const helperContainer = bundle.match(/^.*?\.asar(?=[\\/])/i)?.[0] ?? bundle
  return '\uFEFF' + [
    '$ErrorActionPreference = "Stop"',
    `$runtime = ${quote(executable)}`,
    `$helper = ${quote(bundle)}`,
    `$helperContainer = ${quote(helperContainer)}`,
    'if (!(Test-Path -LiteralPath $runtime) -or !(Test-Path -LiteralPath $helperContainer)) {',
    ...(args[0] === 'hook' ? ['  [Console]::In.ReadToEnd() | Out-Null', '  exit 0'] : ['  Write-Error "nodeterm runtime unavailable. Reopen the application."', '  exit 1']),
    '}',
    '$previousRuntime = $env:ELECTRON_RUN_AS_NODE',
    '$previousRoot = $env:NODETERM_HELPER_IDENTITY_ROOT',
    '$previousArgs = $env:NODETERM_HELPER_ARGS',
    'try {',
    '  $env:ELECTRON_RUN_AS_NODE = "1"',
    `  $env:NODETERM_HELPER_IDENTITY_ROOT = ${quote(identityRoot)}`,
    // PowerShell 5.1's native argv marshaller drops empty strings and embedded quotes. Pass
    // the argument array as JSON data instead; only runtime + bundle appear on the command line.
    `  $env:NODETERM_HELPER_ARGS = ConvertTo-Json -InputObject (@(${args.map(quote).join(', ')}) + @($args | ForEach-Object { [string]$_ })) -Compress`,
    '  & $runtime $helper',
    '  $helperExitCode = $LASTEXITCODE',
    '} finally {',
    '  $env:ELECTRON_RUN_AS_NODE = $previousRuntime',
    '  $env:NODETERM_HELPER_IDENTITY_ROOT = $previousRoot',
    '  $env:NODETERM_HELPER_ARGS = $previousArgs',
    '}',
    'exit $helperExitCode', ''
  ].join('\r\n')
}
/** A shell-neutral command line: base64 contains no paths or shell metacharacters. */
export function nativeHookCommand(script: string): string {
  const source = `if (Test-Path -LiteralPath ${quote(script)}) { & ${quote(script)} } else { [Console]::In.ReadToEnd() | Out-Null }`
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(source, 'utf16le').toString('base64')}`
}
/** Recover our own path marker for idempotent hook migration; never execute decoded text. */
export function nativeHookMarker(command: string): string {
  const match = /^powershell\.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : command
}
export function installNativeHelper(file: string, args: string[]): string {
  const host = platform()
  const bundle = path.join(host.appPath || process.cwd(), 'out', 'helper', 'native-helper.cjs')
  if (!fs.existsSync(bundle)) throw new Error('Native helper missing: run npm run build.')
  const body = nativeHelperScript(process.execPath, bundle, path.join(host.userDataDir, 'codex-thread-nodes'), args)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = tempNameFor(file)
  try {
    fs.writeFileSync(tmp, body, { encoding: 'utf8', flag: 'wx' })
    renameAtomicSync(tmp, file)
  } finally { fs.rmSync(tmp, { force: true }) }
  return file
}
export function nativeCliInstructions(text: string, file: string): string {
  if (!file.endsWith('.ps1')) return text
  return text.replaceAll(`sh "${file}"`, `powershell.exe -NoProfile -ExecutionPolicy Bypass -File '${file.replaceAll("'", "''")}'`).replaceAll('```sh', '```powershell')
}
