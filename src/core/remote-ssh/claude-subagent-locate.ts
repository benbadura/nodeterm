// Locate a NATIVE Claude child's transcript on an SSH host — the remote counterpart of
// `SubagentTail.trackNative` (core/subagent-tail.ts). One bounded remote command per attempt:
//
//   <parent transcript without .jsonl>/subagents/agent-<agent_id>.jsonl            (Agent / Task)
//   <parent transcript without .jsonl>/subagents/workflows/<run>/agent-<id>.jsonl  (Workflow, 2.1.289)
//
// SubagentStart names neither file, and for a Workflow agent nothing a hook carries names the run,
// so the host is asked which one exists. The same round trip prints (at most 4 KB of) the sibling
// `.meta.json`, whose `description` is the card's label for a Workflow agent.
//
// Generated shell no compiler checks: `claude-subagent-locate.realsh.test.ts` runs it under a real
// /bin/sh against a fake host tree.
import { posixQuote } from '../../shared/ssh'
import {
  claudeSubagentMetaPath,
  isClaudeAgentId,
  labelFromSubagentMeta,
  SUBAGENT_META_READ_MAX
} from '../../shared/agents/claude-subagents'

export { SUBAGENT_META_READ_MAX }

/** `<parent transcript without .jsonl>/subagents` on a POSIX host, or `undefined`. */
export function remoteSubagentsDir(parentTranscript: string): string | undefined {
  return parentTranscript.endsWith('.jsonl') ? `${parentTranscript.slice(0, -'.jsonl'.length)}/subagents` : undefined
}

/**
 * The command, or `undefined` for an unsafe id or a parent that is not a transcript. The id is a
 * validated token interpolated bare (it is the only unquoted text next to the unquoted glob);
 * everything else goes through `posixQuote`. A clean miss prints nothing and exits 0.
 */
export function remoteSubagentLocateCommand(parentTranscript: string, agentId: string): string | undefined {
  const dir = remoteSubagentsDir(parentTranscript)
  if (!dir || !isClaudeAgentId(agentId)) return undefined
  const leaf = `agent-${agentId}.jsonl`
  return [
    `d=${posixQuote(dir)}`,
    `f="$d"/${leaf}`,
    `if [ ! -f "$f" ]; then f=; for g in "$d"/workflows/*/${leaf}; do if [ -f "$g" ]; then f=$g; break; fi; done; fi`,
    `[ -n "$f" ] || exit 0`,
    `printf '%s\\n' "$f"`,
    `m="\${f%.jsonl}.meta.json"`,
    `if [ -f "$m" ]; then head -c ${SUBAGENT_META_READ_MAX} "$m" 2>/dev/null; fi`,
    `exit 0`
  ].join('\n')
}

export interface RemoteSubagentLocation {
  path: string
  /** Found under `subagents/workflows/<run>/` — a Workflow agent, whatever its `agent_type`. */
  workflow: boolean
  label?: string
}

/**
 * Read the command's answer. The path must be one of the two layouts for THIS id under THIS
 * parent's `subagents/` directory (jailed: a reply is another machine's output), else
 * `undefined` — which is also the answer for a clean miss.
 */
export function parseRemoteSubagentLocate(
  stdout: string,
  parentTranscript: string,
  agentId: string
): RemoteSubagentLocation | undefined {
  const dir = remoteSubagentsDir(parentTranscript)
  if (!dir || !isClaudeAgentId(agentId)) return undefined
  const nl = stdout.indexOf('\n')
  const first = nl < 0 ? stdout : stdout.slice(0, nl)
  if (!first.startsWith(`${dir}/`)) return undefined
  const rest = first.slice(dir.length + 1).split('/')
  const leaf = `agent-${agentId}.jsonl`
  const ok =
    (rest.length === 1 && rest[0] === leaf) ||
    (rest.length === 3 && rest[0] === 'workflows' && isClaudeAgentId(rest[1]) && rest[2] === leaf)
  if (!ok) return undefined
  const label = nl < 0 ? undefined : labelFromSubagentMeta(stdout.slice(nl + 1))
  return { path: first, workflow: rest.length === 3, ...(label ? { label } : {}) }
}

/**
 * A follow-up read of just the `.meta.json` beside a transcript `parseRemoteSubagentLocate`
 * returned (the meta can land a moment after the transcript, and the locate printed none). The
 * path is the jailed reply, quoted whole. A missing meta prints nothing and exits 0.
 */
export function remoteSubagentMetaCommand(located: RemoteSubagentLocation): string | undefined {
  const meta = claudeSubagentMetaPath(located.path)
  if (!meta) return undefined
  return [
    `m=${posixQuote(meta)}`,
    `if [ -f "$m" ]; then head -c ${SUBAGENT_META_READ_MAX} "$m" 2>/dev/null; fi`,
    `exit 0`
  ].join('\n')
}
