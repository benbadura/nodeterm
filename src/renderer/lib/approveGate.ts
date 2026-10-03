import {
  ASK_USER_QUESTION_TOOL,
  type AnswerPermissionPayload,
  type HeldPermission
} from '@shared/agents/permission-answer'

/**
 * Whether the node header may offer ✓ Approve (a plain `allow`) for the node's current ticket.
 *
 * A plain allow cannot answer a held AskUserQuestion: Claude drops it, the managed hook consumes it
 * and keeps holding, and core refuses to write it. Normally the mirror strips `pendingId` from a
 * question, so the buttons never render at all — but a picker whose PreToolUse stash is missing
 * (hook lost, stash expired) is classified as an APPROVAL and keeps its `pendingId`. That is the
 * case this gate exists for. It compares the ticket, so a concurrent child approval (a different
 * `pendingId`) keeps its own Approve while a question is held.
 */
export function canPlainApprove(status: { pendingId?: string; held?: HeldPermission } | undefined): boolean {
  if (!status?.pendingId) return false
  return !(status.held?.toolName === ASK_USER_QUESTION_TOOL && status.held.pendingId === status.pendingId)
}

/** Where a failed header answer is reported: the app's error toast (the only kind Canvas renders). */
function errorToast(message: string): void {
  window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message } }))
}

/**
 * Send the node header's ✓ Approve / ✕ Deny and say so when it did not land. `answerPermission`
 * resolves `false` when core refuses (an expired hold, a ticket it has no record of, a plain allow a
 * hook script too old to honour it would drop) — the header used to drop that silently, leaving a
 * NEEDS YOU badge the user believed they had just answered. A rejected call is the same refusal.
 * Success says nothing: the badge leaving NEEDS YOU is the receipt. The TUI prompt is untouched either
 * way, so the message points there.
 */
export async function sendHeaderAnswer(
  send: (payload: AnswerPermissionPayload) => Promise<boolean>,
  payload: AnswerPermissionPayload & { decision: 'allow' | 'deny' },
  toast: (message: string) => void = errorToast
): Promise<boolean> {
  let ok = false
  try {
    ok = (await send(payload)) === true
  } catch {
    ok = false
  }
  if (!ok) toast(`Couldn't ${payload.decision === 'allow' ? 'approve' : 'deny'} — answer in the terminal`)
  return ok
}
