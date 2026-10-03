// Source-level parity for the mirror identity seed (`agent:seed-identity`). Every hop is optional
// at the type level — a preload member that is never called, a ws-bridge forward to a channel no
// server handles, a shell that never registers the handler — and each of those compiles, passes
// every unit test, and ships the seed INERT on one surface. Same remedy as
// `hook-verified-parity.test.ts`: read the wiring as text.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = (p: string): string =>
  readFileSync(resolve(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')

describe('agent:seed-identity wiring', () => {
  it('names the channel once, in shared/ipc.ts', () => {
    expect(src('shared/ipc.ts')).toMatch(/agentSeedIdentity:\s*'agent:seed-identity'/)
  })

  it('desktop main registers the handler and feeds the mirror seed', () => {
    const main = src('main/index.ts')
    expect(main).toMatch(/ipcMain\.on\(IPC\.agentSeedIdentity,[\s\S]{0,200}seedNodeIdentities\(/)
  })

  it('Server Edition registers the handler and feeds the mirror seed', () => {
    const server = src('server/index.ts')
    expect(server).toMatch(/platform\.handle\(IPC\.agentSeedIdentity,[\s\S]{0,200}seedNodeIdentities\(/)
  })

  it('both renderer bridges forward to the channel', () => {
    expect(src('preload/index.ts')).toMatch(/seedAgentIdentity:[\s\S]{0,120}IPC\.agentSeedIdentity/)
    expect(src('renderer/bridge/ws-bridge.ts')).toMatch(
      /seedAgentIdentity:[\s\S]{0,200}IPC\.agentSeedIdentity/
    )
  })

  it('the relay tab deliberately does not seed another core', () => {
    expect(src('renderer/bridge/relay-api.ts')).toMatch(/seedAgentIdentity:\s*\(\)\s*=>\s*undefined/)
  })

  it('the canvas mounts the seeder', () => {
    expect(src('renderer/canvas/Canvas.tsx')).toMatch(/useMirrorIdentitySeed\(\)/)
  })
})
