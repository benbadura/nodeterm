import { expect, it, vi } from 'vitest'
import { fakePlatform } from './platform-fake'
import { registerIntegrationPreviewHandlers } from './integration-preview-handlers'
import type { IntegrationPreviewService } from './integration-preview-service'
import { IPC } from '../shared/ipc'
import { isHostOnlyChannel } from '../shared/host-control'

it('accepts only the Desktop client and guards every preview channel from relay peers', async () => {
  const platform = fakePlatform({ isLocalClient: (id) => id === 1 })
  const service = {
    inspect: vi.fn(async () => ({ available: true })), start: vi.fn(async () => ({ ok: true })),
    get: vi.fn(), listReports: vi.fn(), cancel: vi.fn(), retryCleanup: vi.fn()
  }
  registerIntegrationPreviewHandlers(platform, service as unknown as IntegrationPreviewService)
  expect(await platform.handlers[IPC.integrationPreviewInspect](2, 'p')).toMatchObject({ available: false })
  expect(await platform.handlers[IPC.integrationPreviewStart](2, 'p', {})).toMatchObject({ ok: false })
  expect(await platform.handlers[IPC.integrationPreviewGet](2, 'p')).toBeNull()
  expect(await platform.handlers[IPC.integrationPreviewList](2, 'p')).toEqual([])
  expect(await platform.handlers[IPC.integrationPreviewCancel](2, 'p', 'r')).toBe(false)
  expect(await platform.handlers[IPC.integrationPreviewCleanup](2, 'p', 'r')).toBe(false)
  expect(service.start).not.toHaveBeenCalled()
  await platform.handlers[IPC.integrationPreviewInspect](1, 'p', 'main')
  expect(service.inspect).toHaveBeenCalledWith('p', 'main')
  for (const channel of [IPC.integrationPreviewInspect, IPC.integrationPreviewStart, IPC.integrationPreviewGet,
    IPC.integrationPreviewList, IPC.integrationPreviewCancel, IPC.integrationPreviewCleanup, IPC.integrationPreviewEvent('p')]) {
    expect(isHostOnlyChannel(channel)).toBe(true)
  }
})
