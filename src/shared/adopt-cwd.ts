// Making an SSH project's canvas fit for a LOCAL core. When a project moves from a desktop's SSH
// project to the nodeterm-server running on that same host, as that same user, its nodes still
// carry the SSH project's view of the world:
//  - a cwd (or an editor/video `filePath`) of `~/x`, because an SSH project's paths are the remote
//    shell's, which expanded `~` itself;
//  - `sshRemoteTmux`, which makes a core REFUSE to spawn locally (`requireRemote`);
//  - `sshFs`, which routes an editor or video node's reads to the SSH project's filesystem, which a
//    local core does not have (the files are on its own disk now).
// All three are rewritten here. The server runs as the SSH login user, so `~` is that user's home.
import type { CanvasNodeState } from './types'

export function expandHomeCwd(cwd: string, home: string): string {
  if (cwd === '~' || cwd === '~/') return home
  if (cwd.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${cwd.slice(2)}`
  return cwd
}

export function localizeAdoptedNode(node: CanvasNodeState, home: string): CanvasNodeState {
  const cwd = typeof node.cwd === 'string' ? expandHomeCwd(node.cwd, home) : node.cwd
  const filePath = typeof node.filePath === 'string' ? expandHomeCwd(node.filePath, home) : node.filePath
  const remoteSession = node.sshRemoteTmux === true
  const remoteFs = node.sshFs !== undefined
  if (cwd === node.cwd && filePath === node.filePath && !remoteSession && !remoteFs) return node
  // A remote-session node's `ssh` names the host its tmux ran on, and that host is now this one.
  // A plain `ssh <host>` terminal (no `sshRemoteTmux`) keeps its `ssh`: there it is the program the
  // local pty runs, which is just as valid on the server.
  const { sshRemoteTmux: _flag, sshFs: _fs, ssh, ...rest } = node
  return {
    ...rest,
    ...(remoteSession || ssh === undefined ? {} : { ssh }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(filePath === undefined ? {} : { filePath })
  }
}
