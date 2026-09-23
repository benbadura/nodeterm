# Never kill live agents implicitly during installation, update or removal.
!macro customCheckAppRunning
  System::Call 'kernel32::SetEnvironmentVariableW(w "NODETERM_INSTALL_DIR", w "$INSTDIR")'
  ${Do}
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "try { $$p = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { ($$_.Name -eq 'nodeterm.exe' -or $$_.Name -eq 'nodeterm-session-host.exe') -and ($$null -eq $$_.ExecutablePath -or [IO.Path]::GetDirectoryName($$_.ExecutablePath) -eq $$env:NODETERM_INSTALL_DIR) }); if ($$p.Count) { exit 10 }; exit 0 } catch { exit 20 }"`
    Pop $0
    Pop $1
    ${If} $0 == 0
      ${ExitDo}
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Close nodeterm and end its running terminal sessions before installing or uninstalling. No processes have been stopped. Retry after closing them, or cancel to keep working. If they are already closed, Windows could not verify their state." /SD IDCANCEL IDRETRY +3
    SetErrorLevel 10
    Quit
  ${Loop}
  System::Call 'kernel32::SetEnvironmentVariableW(w "NODETERM_INSTALL_DIR", w "")'
!macroend
