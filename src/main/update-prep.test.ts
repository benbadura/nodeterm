import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

import { updatePrepApplies } from './update-prep'
import { HOST_ONLY_CHANNELS } from '../shared/host-control'
import { IPC } from '../shared/ipc'

describe('prepare-for-update gating (issue #829)', () => {
  it('applies only on Windows with persistent sessions and the host bundle present', () => {
    expect(updatePrepApplies({ platform: 'win32', persistentSessions: true, bundleAvailable: true })).toBe(true)
    expect(updatePrepApplies({ platform: 'linux', persistentSessions: true, bundleAvailable: true })).toBe(false)
    expect(updatePrepApplies({ platform: 'darwin', persistentSessions: true, bundleAvailable: true })).toBe(false)
    expect(updatePrepApplies({ platform: 'win32', persistentSessions: false, bundleAvailable: true })).toBe(false)
    expect(updatePrepApplies({ platform: 'win32', persistentSessions: true, bundleAvailable: false })).toBe(false)
  })

  it('no relay peer may inspect, shut down the host, or quit the app', () => {
    expect(HOST_ONLY_CHANNELS.has(IPC.appUpdatePrepInspect)).toBe(true)
    expect(HOST_ONLY_CHANNELS.has(IPC.appUpdatePrepShutdown)).toBe(true)
    expect(HOST_ONLY_CHANNELS.has(IPC.appUpdatePrepQuit)).toBe(true)
  })
})
