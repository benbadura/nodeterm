import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { ShareTeamHandlers } from './share-team'

/** Raw `ipcMain` handlers, never on the platform: a relay peer can never reach them. Every argument
 *  is coerced here, and the handlers re-validate what they use (the resume list included). */
export function registerShareTeamIpc(h: ShareTeamHandlers, send: (channel: string, ...args: unknown[]) => void): void {
  ipcMain.handle(IPC.shareTeamProbe, (_e, projectId: string, nodeIds: unknown) =>
    h.probe(String(projectId), Array.isArray(nodeIds) ? nodeIds.map(String) : [])
  )
  ipcMain.handle(IPC.shareTeamInstall, (_e, projectId: string) =>
    h.install(String(projectId), (text) => send(IPC.shareTeamInstallOutput, { projectId: String(projectId), text }))
  )
  ipcMain.handle(IPC.shareTeamCancelInstall, (_e, projectId: string) => h.cancelInstall(String(projectId)))
  ipcMain.handle(IPC.shareTeamFlushMirror, (_e, projectId: string) => h.flushMirror(String(projectId)))
  ipcMain.handle(IPC.shareTeamBootstrap, (_e, projectId: string) => h.bootstrap(String(projectId)))
  ipcMain.handle(IPC.shareTeamKillSessions, (_e, projectId: string, nodeIds: unknown) =>
    h.killSessions(String(projectId), Array.isArray(nodeIds) ? nodeIds.map(String) : [])
  )
  ipcMain.handle(IPC.shareTeamResume, (_e, projectId: string, serverProjectId: string, sessions: unknown) =>
    h.resume(String(projectId), String(serverProjectId), sessions as never)
  )
  ipcMain.handle(IPC.shareTeamSeedBookmark, (_e, joinCode: string) => h.seedBookmark(String(joinCode)))
}
