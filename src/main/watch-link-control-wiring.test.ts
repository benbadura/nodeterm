// Source-level: a Control link's hops close over shell objects no unit test can build (PtyManager, the
// workspace store, the Electron and Server Edition platforms), and a dropped hop compiles fine while
// shipping the feature inert — no `controlSupport` and every Zellij node is offered Control; a channel
// left out of `registerWatchLinkIpc` and the owner's button answers nothing. Same remedy as
// watch-link-wiring.test.ts and hook-verified-parity.test.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8').replace(/\r\n/g, '\n')
/** The source from `marker` up to the next line that closes a block at column `indent`. */
function blockAfter(src: string, marker: string, indent: string): string {
  const start = src.indexOf(marker)
  if (start < 0) throw new Error(`not found: ${marker}`)
  const end = src.indexOf(`\n${indent}}`, start)
  return src.slice(start, end < 0 ? undefined : end)
}

const MAIN = 'src/main/index.ts'
const SERVER = 'src/server/index.ts'

const CONTROL_CHANNELS = ['watchLinkSetControl', 'watchLinkSetPassword', 'watchLinkAllowControl', 'watchLinkControlSupport']
const ALL_CHANNELS = [
  'watchLinkCreate', 'watchLinkList', 'watchLinkRevoke', 'watchLinkRevokeAll', 'watchLinkKick',
  'watchLinkChatSend', 'watchLinkChatHistory', ...CONTROL_CHANNELS
]

describe('live-link Control wiring', () => {
  for (const shell of [MAIN, SERVER]) {
    it(`${shell} hands the service PtyManager's control check, local nodes only`, () => {
      const block = blockAfter(read(shell), 'watchLinks = createWatchLinkService({', '  ')
      expect(block).toMatch(/controlSupport: \(nodeId\) =>/)
      expect(block).toMatch(/ptyManager\.nodeControlSupport\(nodeId\)/)
      // A node in a HOST's tmux (an SSH project's, or a remote-tmux node in a local project — core's
      // `watchRemoteFor`, the rule the join uses): the local backend choice says nothing about it.
      expect(block).toMatch(/watchRemote\(nodeId\)\.requireRemote \? 'ok' : ptyManager\.nodeControlSupport\(nodeId\)/)
      expect(block).toMatch(/pty: createWatchPty\(ptyManager, watchRemote\)/)
      expect(read(shell)).toMatch(/const watchRemote = \(nodeId: string\): WatchRemote =>\s*watchRemoteFor\(nodeId, watchRemoteRecords\(workspaceStore, /)
    })
  }

  it('registerWatchLinkIpc registers all eleven owner request channels, each behind the owner check', () => {
    const src = read('src/core/watch-link/service.ts')
    const reg = src.slice(src.indexOf('export function registerWatchLinkIpc('))
    for (const ch of ALL_CHANNELS) {
      const at = reg.indexOf(`p.handleWithSender(IPC.${ch},`)
      expect(at, ch).toBeGreaterThan(-1)
      // The handler's own line(s) up to the next registration ask `owner(sender)` first.
      const next = reg.indexOf('p.handleWithSender(', at + 1)
      expect(reg.slice(at, next < 0 ? undefined : next), ch).toMatch(/owner\(sender\)/)
    }
    expect(reg.match(/p\.handleWithSender\(IPC\.watchLink/g)).toHaveLength(ALL_CHANNELS.length)
  })

  it('the preload, the Server Edition bridge and the relay stub all carry the four Control members', () => {
    const preload = read('src/preload/index.ts')
    for (const ch of CONTROL_CHANNELS) expect(preload, ch).toContain(`IPC.${ch}`)
    const bridge = read('src/renderer/bridge/ws-bridge.ts')
    const api = bridge.slice(bridge.indexOf('export function buildWatchLinkApi('))
    for (const ch of CONTROL_CHANNELS) expect(api, ch).toContain(`client.request(IPC.${ch}`)
    // A dropped socket answers the safe value, never a rejection the UI did not expect.
    expect(api).toMatch(/IPC\.watchLinkControlSupport, nodeId\) as Promise<ControlSupport>\)\.catch\(\(\): ControlSupport => 'unknown'\)/)
    const stub = read('src/renderer/bridge/stubs.ts')
    const relay = stub.slice(stub.indexOf('    watchLink: {'))
    for (const m of ['setControl', 'setPassword', 'allowControl', 'controlSupport']) expect(relay, m).toMatch(new RegExp(`${m}: async`))
  })

  it('the pty seam hands joins their input route and input to the pane, from PtyManager', () => {
    const seam = read('src/core/watch-link/pty-seam.ts')
    expect(seam).toMatch(/input: pty\.watcherInputRoute\(res\.sessionId\)/)
    // The link host's `isCurrent` rides along: PtyManager asks it right before the step runs.
    expect(seam).toMatch(/input: \(sessionId, chunk, isCurrent\) => pty\.controlInput\(sessionId, chunk, isCurrent\)/)
  })
})
