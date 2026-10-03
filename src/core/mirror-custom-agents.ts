// The custom-agent list the agent-status mirror advertises to the phone (MirrorSettings.customAgents).
//
// One definition consumed by every settings provider — the desktop's local file, each SSH project's
// slice (`settingsFor`), and the Server Edition — so the surfaces cannot drift. The local file is
// also what the relay's `projects.list` serves, so that surface needs no wiring of its own.
//
// SECURITY: a `CustomAgent` carries `launchCmd`, `args` and `env`, and all three routinely hold
// secrets (an `ANTHROPIC_AUTH_TOKEN`, a `--api-key`, a proxy URL). The mirror is a plain file on
// this machine AND on every SSH host a project runs on. So this builds each row field by field from
// an allowlist and publishes only DERIVED binary basenames, never the command they came from —
// and only names in a strict plain alphabet (`PLAIN_BINARY`), because a derived "name" can itself
// be a slice of a secret-bearing URL or env value.

import type { CustomAgent } from '@shared/types'
import { AGENT_CONFIG } from '@shared/agents/config'
import { binariesFor } from '@shared/agents/pane-owner-predicate'
import type { MirrorCustomAgent } from './agent-status-mirror'

/**
 * The only shape a published binary name may have. `binaryFromLaunchCmd` is a best-effort
 * tokenizer over free text, so what it names can itself be a secret: measured,
 * `uvx --from git+https://oauth2:ghp_…@github.com agent` names `oauth2:ghp_…`, a quoted env value
 * names `sk-ant-…"`, and `${env:AGENT_BIN}` names the template. A real program basename fits this
 * alphabet (no `@`, `:`, `/`, quotes, `$`); anything else publishes `[]` — "cannot be named", which
 * the phone must refuse — rather than a substring of the command.
 */
const PLAIN_BINARY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Credential SHAPES that still fit the alphabet. `binaryFromLaunchCmd` cannot tell an option's
 * VALUE from the program (`npx --registry-token ghp_… my-agent` names the token), so the builder
 * also refuses anything that looks like a known token prefix, or a long high-entropy string. A
 * heuristic, not a proof: its failure mode on a real binary is `[]` (the phone refuses), which is
 * the safe direction.
 */
const TOKEN_PREFIXES = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'AIza', 'sk-', 'xai-', 'glpat-']

function looksLikeCredential(name: string): boolean {
  if (TOKEN_PREFIXES.some((p) => name.startsWith(p))) return true
  if (name.length < 32) return false
  const alnum = name.replace(/[^A-Za-z0-9]/g, '').length
  return alnum / name.length >= 0.8 && /[A-Za-z]/.test(name) && /[0-9]/.test(name)
}

/** Longest label we republish — a label is display text, not a payload. */
const LABEL_MAX = 200

export function mirrorCustomAgents(customAgents: readonly CustomAgent[] | null | undefined): MirrorCustomAgent[] {
  if (!Array.isArray(customAgents)) return []
  // Settings are hand-editable JSON: never trust the static type.
  const valid = customAgents.filter(
    (c): c is CustomAgent =>
      !!c && typeof c === 'object' && typeof c.id === 'string' && c.id.startsWith('custom:')
  )
  const out: MirrorCustomAgent[] = []
  const seen = new Set<string>()
  for (const c of valid) {
    // The desktop's predicate resolves an id to its FIRST record; a duplicate must not advertise a
    // second, different binary for the same id.
    if (seen.has(c.id)) continue
    seen.add(c.id)
    const base =
      typeof c.baseAgent === 'string' && Object.prototype.hasOwnProperty.call(AGENT_CONFIG, c.baseAgent)
        ? c.baseAgent
        : undefined
    const launchCmd = typeof c.launchCmd === 'string' ? c.launchCmd : ''
    const binaries = binariesFor(c.id, [{ id: c.id, launchCmd, ...(base ? { baseAgent: base } : {}) }])
    const label = typeof c.label === 'string' && c.label.trim() ? c.label.slice(0, LABEL_MAX) : c.id
    // All-or-nothing: one unpublishable name means the derivation is not trustworthy as a whole.
    const plain = !!binaries && binaries.length > 0 && binaries.every((b) => PLAIN_BINARY.test(b) && !looksLikeCredential(b))
    out.push({ id: c.id, label, ...(base ? { baseAgent: base } : {}), binaries: plain ? [...binaries] : [] })
  }
  return out
}
