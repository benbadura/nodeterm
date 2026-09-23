# Desktop targets

The desktop application shares Electron, React, TypeScript and its IPC contract. Platform
adapters handle processes, shell discovery and installers; this is not a separate Windows app.
Server Edition and iOS retain their existing delivery paths.

| Target | Packages | Persistent terminals | Updates |
| --- | --- | --- | --- |
| macOS arm64, x64 | DMG, ZIP | System/bundled tmux, session-host fallback | Manual; unsigned |
| Windows x64 | Per-user NSIS EXE, ZIP | Bundled ConPTY session host | Manual; unsigned beta |
| Linux x64 | AppImage, DEB, RPM | tmux, session-host fallback | Manual |

These are desktop OS/architecture targets, not a promise to run on every OS version, CPU,
Linux distribution or mobile system. The OS must support the pinned Electron/node-pty versions.
Windows ARM64/32-bit and Linux ARM64 are not release artifacts in this rollout.

## Windows installation and shells

Install the EXE as the current user, or extract the entire ZIP into a writable directory.
Node, Git Bash, WSL, curl and jq are not prerequisites for the packaged application. Agent CLIs
and tools such as Git still need their own installation. Unsigned Windows builds can trigger
SmartScreen; verify the source and the release's `SHA256SUMS-win.txt` before running them.
The ZIP is an unpacked application, not an isolated portable user-data profile.

Settings → Shell lists Automatic, PowerShell 7, Windows PowerShell, Command Prompt, Git Bash,
a custom absolute `.exe`, and installed WSL distributions. Automatic tries PowerShell 7,
Windows PowerShell, then Command Prompt. An explicitly unavailable selection fails instead
of switching shells. An existing default-shell path is preserved as the custom selection.
Project-specific and explicitly supplied shell overrides retain precedence.

Profiles apply to **new** sessions. A warm reconnect attaches to the existing session before
resolving current profile settings. Stop a terminal explicitly to change its shell. Profile
selection is machine-local; the relay cannot enumerate executable paths or choose a profile.
WSL is optional: its adapter enumerates distributions, translates the Windows cwd with
`wslpath`, and refuses to enter a different directory when translation or `cd` fails.

Shell commands are interpreted by the selected shell. Custom agent launch commands and shell
snippets must use that shell's syntax. The existing POSIX agent-command assembler (including
`--prompt-file` expansion and complex quoting) has not yet been replaced by the prepared
semantic launch API in `core/agent-launch.ts`; those launch paths still need native Windows
integration. WSL/Git Bash profiles are optional shell environments, not a guarantee that
Windows-managed agent installations, hooks and paths work inside a Linux distribution.

## Native helper runtime

`npm run build` includes `out/helper/native-helper.cjs`, the session host and the Codex relay.
Windows installs `.ps1` launchers for status hooks, linked context and canvas control. They use
the installed Electron executable in Node mode, not Node from PATH. Argument arrays travel as
JSON data to preserve quotes, Unicode and empty strings under Windows PowerShell 5.1.
Hook stdin is streamed separately and drained even for stale sessions or a missing runtime.
Copilot uses its [documented PowerShell hook field](https://docs.github.com/en/copilot/reference/hooks-reference).

Credentials are read from the endpoint and per-node token files for each request and sent in
HTTP headers. Clients try the advertised local socket/named pipe before loopback TCP. An HTTP
refusal is final; a control mutation is retried only after a definite connection refusal or
missing socket, never after an ambiguous response loss. Hooks fail open. Permission-request
answers use the existing bounded pending-file protocol.

The POSIX helper scripts and remote SSH installation remain available unchanged. Windows
file permissions inherit the owning user's profile ACLs; POSIX mode `0600` alone is not a
Windows ACL guarantee. Testing access from a separate Windows account is still a manual
release check.

## Build and verification

Use Node 22.22.2 for reproducible CI. `npm ci` applies the existing node-pty patches and rebuilds
native modules for Electron. `npm run dist` dispatches to the current OS's packaging script;
`dist:mac`, `dist:win` and `dist:linux` are explicit alternatives. Build on the target OS.
macOS packaging builds the bundled universal tmux; Linux RPM packaging needs `rpmbuild`.

`scripts/package-smoke.cjs` must run with the **packaged executable** and
`ELECTRON_RUN_AS_NODE=1`. It checks every runtime bundle, loads node-pty/smart-whisper/sharp,
opens a real PTY in temporary state, verifies authenticated input/output, resize, disconnect,
reattach to the same generation, capture and termination. It never uses the user's tmux server.

Windows CI runs `scripts/smoke-windows.ps1` on a disposable runner: silent per-user installation,
runtime verification without developer tools on PATH, refusal to replace a live runtime,
reinstallation after it exits, ZIP verification and uninstallation. The script refuses to run
outside CI because installation changes Windows' application registry.
Native helper process tests also run on Windows PowerShell 5.1. macOS and Linux CI exercise
packaged directories; release jobs exercise the macOS arm64 app, Linux AppImage payload and
Windows installed/ZIP runtime before uploading. The macOS x64 artifact is built, but the
release runner only executes its native arm64 artifact.

## GitHub releases

The [Release workflow](../.github/workflows/release.yml) runs on `release.published`, for both
stable releases and prereleases. Commit the workflow and packaging scripts before tagging the
release. Set `package.json` and `package-lock.json` to the release version; the tag must be that
version with an optional `v` prefix (for example `v0.3.9`). Publish the release through GitHub's
UI or `gh release create`. A tag push or saving a draft alone does not start packaging.

GitHub-hosted macOS, Windows and Linux runners build the tagged source, exercise the packaged
runtime and attach the following files directly to **that existing release**:

- macOS: arm64 and x64 DMG/ZIP files, plus `SHA256SUMS-mac.txt`.
- Windows x64: NSIS installer and ZIP, plus `SHA256SUMS-win.txt`.
- Linux x64: AppImage, DEB and RPM, plus `SHA256SUMS-linux.txt`.

All builds are unsigned, macOS notarization is disabled, and no signing secrets or self-hosted
runner are required. The workflow uses only the automatic `GITHUB_TOKEN` with `contents: write`.
These packages disable automatic update checks; install future versions manually. No update-feed
metadata or blockmaps are uploaded. The legacy local `npm run release` command remains a separate
signed macOS build path and is not used by this workflow.

Each platform uploads only after its smoke checks pass. The release is already public while
builds run, so assets appear incrementally; check all three matrix jobs before announcing it.
Release notes, prerelease status and the author's `latest` selection are preserved. A failed
platform does not cancel the others. Use **Re-run failed jobs**, or **Actions → Release → Run
workflow** with the existing release's `tag`, to retry; same-name assets are replaced. No extra
copy is stored in Actions artifacts.

If another workflow creates releases using `GITHUB_TOKEN`, GitHub suppresses the resulting
`release` workflow trigger. Use the manual dispatch above, or create the release with a PAT/GitHub
App token. See [GitHub's trigger documentation](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow).

Keep the Windows label as beta until the native launch integration above and real-machine
GUI checks are complete: clipboard, shortcuts, browser nodes, tray, installer cancellation,
agent CLIs, and a second-user ACL check are not proven by the runtime smoke alone.
