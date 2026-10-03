// A leaf module, so the workspace store and the bootstrap verb can raise coded errors without
// importing the admin socket (team-admin.ts re-exports all three).

/** The shape of a stable admin error code (`E_BAD_CWD`, `E_HOSTING_OFF`, …). A remote caller — the
 *  desktop's Share with team, over ssh — branches on the code, never on the English sentence. */
export const ADMIN_ERROR_CODE_RE = /^E_[A-Z][A-Z0-9_]{0,40}$/

/** An Error carrying a stable admin code. */
export function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

/** The stable code a thrown error carries, if it carries one of OURS. Node's own errno codes
 *  (`ENOENT`, `EACCES`) never match, so a filesystem failure is reported by its message only. */
export function adminErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && ADMIN_ERROR_CODE_RE.test(code) ? code : undefined
}
