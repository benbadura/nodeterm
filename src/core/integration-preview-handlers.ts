import { IPC } from '../shared/ipc'
import { PREVIEW_UNAVAILABLE, type PreviewOptions } from '../shared/integration-preview'
import type { CorePlatform } from './platform'
import type { IntegrationPreviewService } from './integration-preview-service'

export function registerIntegrationPreviewHandlers(platform: CorePlatform, service: IntegrationPreviewService): void {
  const allowed = (sender: number, projectId: unknown): projectId is string =>
    platform.isLocalClient?.(sender) === true && typeof projectId === 'string' && projectId.length > 0
  platform.handleWithSender(IPC.integrationPreviewInspect, (sender, id, base) => {
    if (!allowed(sender, id) || (base !== undefined && typeof base !== 'string')) {
      return { available: false, reason: PREVIEW_UNAVAILABLE, branches: [], defaultBaseRef: '', suggestions: [] }
    }
    return service.inspect(id, base)
  })
  platform.handleWithSender(IPC.integrationPreviewStart, (sender, id, options: PreviewOptions) =>
    allowed(sender, id) ? service.start(id, options) : { ok: false, message: PREVIEW_UNAVAILABLE })
  platform.handleWithSender(IPC.integrationPreviewGet, (sender, id) => allowed(sender, id) ? service.get(id) : null)
  platform.handleWithSender(IPC.integrationPreviewList, (sender, id) => allowed(sender, id) ? service.listReports(id) : [])
  platform.handleWithSender(IPC.integrationPreviewCancel, (sender, id, runId) =>
    allowed(sender, id) && typeof runId === 'string' ? service.cancel(id, runId) : false)
  platform.handleWithSender(IPC.integrationPreviewCleanup, (sender, id, runId) =>
    allowed(sender, id) && typeof runId === 'string' ? service.retryCleanup(id, runId) : false)
}
