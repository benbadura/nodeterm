/**
 * THE safe agent session-id alphabet: a leading alphanumeric, then `[A-Za-z0-9._-]` — covers every
 * id the agent CLIs mint (UUIDs, codex/grok thread ids) and refuses a flag-like (`-x`), dot-led or
 * metacharacter-bearing value. Session ids are interpolated into shell command lines
 * (`--resume <id>`), so every site re-validates against this, never by type. No imports: usable
 * from core, main, renderer and the server shell alike.
 *
 * Two forms, because the three sites that used to re-type it disagreed on the bound and unifying
 * would change behaviour:
 *  - `SAFE_SESSION_ID` — bounded to SESSION_ID_MAX. Input-boundary checks (the launch intent in
 *    `core/agent-launch.ts`, the renderer's identity seed) use it.
 *  - `SAFE_SESSION_ID_UNBOUNDED` — no length cap. `shared/agents/config.ts`'s resume / minted-id
 *    helpers have always used it; bounding them would silently stop resuming a (hypothetical) id
 *    longer than 256 characters that works today, so their semantics are kept explicit instead.
 */
export const SESSION_ID_MAX = 256
export const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/
export const SAFE_SESSION_ID_UNBOUNDED = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
