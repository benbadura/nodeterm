$ErrorActionPreference = 'Stop'
if (!$env:CI) { throw 'Run this installer test only on a disposable Windows CI runner.' }
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = (Resolve-Path "dist/nodeterm-Setup-$version.exe").Path
$root = Join-Path $env:TEMP ("nodeterm package żółć " + [guid]::NewGuid())
$installDir = Join-Path $root 'installed'
$zipDir = Join-Path $root 'zip'
New-Item -ItemType Directory -Path $root | Out-Null
$oldRunAsNode = $env:ELECTRON_RUN_AS_NODE
$oldPath = $env:PATH
$guard = $null
function Invoke-PackageSmoke([string]$executable, [string]$label) {
  $scriptPath = Join-Path $PSScriptRoot 'package-smoke.cjs'
  $stdout = Join-Path $root "$label.stdout.log"
  $stderr = Join-Path $root "$label.stderr.log"
  # PowerShell can return from a GUI-subsystem .exe before it exits, leaving $LASTEXITCODE
  # from an earlier command. Wait for this exact Electron process and read its exit code.
  $smoke = Start-Process -FilePath $executable -ArgumentList @('"' + $scriptPath + '"') -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $smoke.WaitForExit()
  if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout }
  if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr }
  if ($smoke.ExitCode -ne 0) { throw "$label package smoke failed: $($smoke.ExitCode)" }
}
try {
  $install = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Installer failed: $($install.ExitCode)" }
  $env:ELECTRON_RUN_AS_NODE = '1'
  # Prove that installed runtime/helper paths do not depend on Node, Git Bash or curl on PATH.
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  Invoke-PackageSmoke "$installDir/nodeterm.exe" 'installed'
  $holdScript = Join-Path $root 'hold.cjs'
  Set-Content -LiteralPath $holdScript -Value 'setInterval(() => {}, 1000)' -Encoding ascii
  $guard = Start-Process -FilePath "$installDir/nodeterm.exe" -ArgumentList @('"' + $holdScript + '"') -PassThru
  Start-Sleep -Seconds 1
  if ($guard.HasExited) { throw 'Guard fixture did not start' }
  $blocked = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
  if ($blocked.ExitCode -eq 0 -or $guard.HasExited) { throw 'Installer did not preserve the live runtime' }
  Stop-Process -Id $guard.Id
  $guard.WaitForExit()
  $guard = $null
  $upgrade = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
  if ($upgrade.ExitCode -ne 0) { throw 'Reinstall after closing sessions failed' }
  Invoke-PackageSmoke "$installDir/nodeterm.exe" 'upgraded'
  $zip = @(Get-ChildItem 'dist/nodeterm-*-win.zip')
  if ($zip.Count -ne 1) { throw 'Expected exactly one Windows ZIP' }
  Expand-Archive -LiteralPath $zip[0].FullName -DestinationPath $zipDir
  Invoke-PackageSmoke "$zipDir/nodeterm.exe" 'zip'
} finally {
  if ($guard -and !$guard.HasExited) { Stop-Process -Id $guard.Id; $guard.WaitForExit() }
  $env:ELECTRON_RUN_AS_NODE = $oldRunAsNode
  $env:PATH = $oldPath
  $uninstaller = Join-Path $installDir 'Uninstall nodeterm.exe'
  if (Test-Path -LiteralPath $uninstaller) {
    $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited $($uninstall.ExitCode)" }
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
