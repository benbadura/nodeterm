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
try {
  $install = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Installer failed: $($install.ExitCode)" }
  $env:ELECTRON_RUN_AS_NODE = '1'
  # Prove that installed runtime/helper paths do not depend on Node, Git Bash or curl on PATH.
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  & "$installDir/nodeterm.exe" "$PSScriptRoot/package-smoke.cjs"
  if ($LASTEXITCODE -ne 0) { throw 'Installed package smoke failed' }
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
  & "$installDir/nodeterm.exe" "$PSScriptRoot/package-smoke.cjs"
  if ($LASTEXITCODE -ne 0) { throw 'Upgraded package smoke failed' }
  $zip = @(Get-ChildItem 'dist/nodeterm-*-win.zip')
  if ($zip.Count -ne 1) { throw 'Expected exactly one Windows ZIP' }
  Expand-Archive -LiteralPath $zip[0].FullName -DestinationPath $zipDir
  & "$zipDir/nodeterm.exe" "$PSScriptRoot/package-smoke.cjs"
  if ($LASTEXITCODE -ne 0) { throw 'ZIP package smoke failed' }
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
