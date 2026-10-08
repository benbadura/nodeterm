// Claude Code's native subagent hooks (`SubagentStart` / `SubagentStop`) — the pure, measured facts
// the normalizer, the lifecycle (core/claude-subagent-lifecycle.ts) and both shells' transcript
// tails share. MEASURED on Claude Code 2.1.284 (fixture: __fixtures__/claude/subagent-hook-payloads.json)
// and, for the agents of the `Workflow` tool, on 2.1.289 (fixture:
// __fixtures__/claude/workflow-hook-payloads.json); the full write-up is CLAUDE.md → Agent support →
// Subagent visualization.

/**
 * A native subagent id as the CLI prints it (measured: `a` + 16 hex, e.g. `a4809888b14b29608`).
 * Deliberately a TOKEN rule, not that exact shape: the id becomes a card key and a FILE NAME
 * (`agent-<id>.jsonl`), so what matters is that it cannot carry a separator or a traversal — and a
 * shape pinned to today's 17 characters would silently drop every card the day the format grows.
 */
export const CLAUDE_AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function isClaudeAgentId(v: unknown): v is string {
  return typeof v === 'string' && CLAUDE_AGENT_ID_RE.test(v)
}

/**
 * The `agent_type` of every agent a `Workflow` tool run spawns (MEASURED, 2.1.289). Such an agent
 * fires its own native `SubagentStart` / `SubagentStop` like any subagent, but no Agent/Task tool
 * call precedes it, and the parent's `Stop` inventory lists the WORKFLOW (`type: 'workflow'`), never
 * the agents by their own ids — so the lifecycle must not read "not listed" as "over" for these.
 */
export const CLAUDE_WORKFLOW_AGENT_TYPE = 'workflow-subagent'

/** `<parent transcript without .jsonl><sep>subagents`, or `undefined` for a non-transcript path. */
function subagentsDir(parentTranscript: string): { dir: string; sep: string } | undefined {
  if (!parentTranscript.endsWith('.jsonl')) return undefined
  const sep = parentTranscript.includes('/') ? '/' : '\\'
  return { dir: `${parentTranscript.slice(0, -'.jsonl'.length)}${sep}subagents`, sep }
}

/**
 * Where a subagent's own transcript lives, derived from the PARENT's transcript path (every
 * `SubagentStart` carries it as `transcript_path`) and the child's `agent_id`:
 *
 *   <parent transcript without .jsonl>/subagents/agent-<agent_id>.jsonl
 *
 * `SubagentStart` does not name the file; only `SubagentStop` does (`agent_transcript_path`), which
 * is too late for a live tail. The derivation is pinned against every stop in the capture, nested
 * children included (they live in the TOP session's `subagents/` directory, not in their parent
 * agent's). `undefined` for an unsafe id or a parent path that is not a transcript — the caller
 * then simply has no tail, never a guessed file.
 *
 * Separator-agnostic on purpose: the path is the one the CLI reported (POSIX on the hosts we tail
 * remotely, possibly `\` on a Windows desktop), and only its `.jsonl` suffix is replaced.
 */
export function claudeSubagentTranscriptPath(parentTranscript: string, agentId: string): string | undefined {
  const d = isClaudeAgentId(agentId) ? subagentsDir(parentTranscript) : undefined
  return d ? `${d.dir}${d.sep}agent-${agentId}.jsonl` : undefined
}

/**
 * Where a `Workflow` run keeps its agents' transcripts (MEASURED, 2.1.289):
 *
 *   <parent transcript without .jsonl>/subagents/workflows/<runId>/agent-<agent_id>.jsonl
 *
 * beside `agent-<agent_id>.meta.json` and the run's `journal.jsonl`. `SubagentStart` names neither
 * the run nor the file (the run id is in the Workflow tool's async ack, which a hook-driven tail
 * cannot pair with a given agent), so a tail RESOLVES the run directory by looking for this exact
 * agent id under it (the local tail through `claudeWorkflowAgentTranscriptPath`, the SSH locator
 * with a glob over the same layout). Separator-agnostic like
 * `claudeSubagentTranscriptPath`.
 */
export function claudeWorkflowsDir(parentTranscript: string): string | undefined {
  const d = subagentsDir(parentTranscript)
  return d ? `${d.dir}${d.sep}workflows` : undefined
}

/** One run's transcript for one agent: `<workflows dir>/<runId>/agent-<agentId>.jsonl`. Both ids
 *  must be plain tokens (`runId` is a directory name read off disk, e.g. `wf_5b923257-98d`). */
export function claudeWorkflowAgentTranscriptPath(
  parentTranscript: string,
  runId: string,
  agentId: string
): string | undefined {
  if (!isClaudeAgentId(agentId) || !isClaudeAgentId(runId)) return undefined
  const dir = claudeWorkflowsDir(parentTranscript)
  if (!dir) return undefined
  const sep = parentTranscript.includes('/') ? '/' : '\\'
  return `${dir}${sep}${runId}${sep}agent-${agentId}.jsonl`
}

/** The `.meta.json` sibling of a subagent transcript (`agent-<id>.jsonl` → `agent-<id>.meta.json`). */
export function claudeSubagentMetaPath(transcript: string): string | undefined {
  return transcript.endsWith('.jsonl') ? `${transcript.slice(0, -'.jsonl'.length)}.meta.json` : undefined
}

/** Bound on a card label read off disk, in code points. */
export const SUBAGENT_LABEL_MAX = 120

/** Bytes of a `.meta.json` either shell reads (a real one is ~200 B). The local tail and the SSH
 *  locator read the same prefix, so the two can never disagree about the same file. */
export const SUBAGENT_META_READ_MAX = 4096

/**
 * A card label from untrusted text: one line, C0/C1 controls and every format control (`\p{Cf}`:
 * bidi marks and overrides incl. U+061C, zero-width characters, soft hyphen, interlinear
 * annotation, the tag block) removed — ZWJ alone kept, so an emoji sequence still reads as one —
 * whitespace collapsed, capped at `SUBAGENT_LABEL_MAX` code points. `undefined` when nothing is
 * left. The meta.json `description` is written by the CLI from whatever a Workflow SCRIPT passed as
 * an agent label — model-authored text sitting in a file on disk.
 */
export function sanitizeSubagentLabel(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const cleaned = v
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/(?!\u200d)\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return undefined
  const cps = [...cleaned]
  return cps.length > SUBAGENT_LABEL_MAX ? `${cps.slice(0, SUBAGENT_LABEL_MAX - 1).join('')}…` : cleaned
}

/** The label a subagent's `.meta.json` carries (`description`; for a Workflow agent the `agent()`
 *  label the script gave it), sanitized — or `undefined` for anything that does not parse. */
export function labelFromSubagentMeta(text: string): string | undefined {
  try {
    const meta = JSON.parse(text) as unknown
    if (!meta || typeof meta !== 'object') return undefined
    return sanitizeSubagentLabel((meta as { description?: unknown }).description)
  } catch {
    return undefined
  }
}

/** A background-task status that says the task is OVER. A CLOSED set: any other value — including
 *  one a future release invents — reads as still running, the direction in which both consumers
 *  fail safe (Eco does not exit the CLI; the lifecycle does not end a card). */
const FINISHED_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled'])

/** Bound on what one Stop may report — the list rides every turn end to the renderer. */
const BACKGROUND_TASKS_MAX = 64

/**
 * The ids of the background tasks a `Stop` hook reports as still alive, or `undefined` when the
 * payload carries no inventory at all (an older CLI: absent through 2.1.112, present from some
 * native-binary release up to 2.1.284 — the exact first version was not bisected, so this is
 * FEATURE-detected per payload, never version-gated).
 *
 * MEASURED: `background_tasks` lists the session's running BACKGROUND tasks as
 * `{id, type, status, description, …}` — async subagents by their own agent id (nested ones
 * included, `type: 'subagent'`), background shells, and (2.1.289) a running `Workflow` tool run as
 * ONE entry of `type: 'workflow'` keyed by the workflow's task id: the agents a workflow spawns are
 * NOT listed by their own ids. A foreground subagent is never in it (a parent `Stop` cannot happen
 * while one runs).
 */
export function liveBackgroundTaskIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const t of value) {
    if (!t || typeof t !== 'object') continue
    const { id, status } = t as { id?: unknown; status?: unknown }
    if (typeof id !== 'string' || !id || id.length > 128) continue
    if (typeof status === 'string' && FINISHED_TASK_STATUSES.has(status)) continue
    out.push(id)
    if (out.length >= BACKGROUND_TASKS_MAX) break
  }
  return out
}

/**
 * The subset of `liveBackgroundTaskIds` that are background SUBAGENTS (`type: 'subagent'`, the
 * value every measured async child carries in the fixtures), or `undefined` with no inventory.
 *
 * Why a subset: plain `--after` holds a station whose turn ended with background work still
 * running (core/station-handover.ts), and only a subagent is safe to hold on. An async subagent
 * ENDS, and its `<task-notification>` wakes the parent into another turn, so a later `Stop` with
 * it gone reliably comes. A background SHELL may never end (a dev server, a file watcher,
 * `tail -f`) and does not reliably wake the station, so holding on one could hold a dependent
 * forever. Any other or unknown `type` is treated like a shell: not held on.
 */
export function liveBackgroundSubagentIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const live = new Set(liveBackgroundTaskIds(value))
  const out: string[] = []
  for (const t of value) {
    if (!t || typeof t !== 'object') continue
    const { id, type } = t as { id?: unknown; type?: unknown }
    if (type === 'subagent' && typeof id === 'string' && live.has(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * The subset of `liveBackgroundTaskIds` that are running `Workflow` tool runs (`type: 'workflow'`,
 * MEASURED 2.1.289), or `undefined` with no inventory. Each id is the workflow's TASK id
 * (`wjf20hftg`), never an agent's: while any is live, the lifecycle keeps the workflow agents' cards
 * (which the inventory cannot list by id), and plain `--after` holds the station — a workflow ends,
 * and its `<task-notification>` wakes the parent into another turn, exactly like an async subagent.
 */
export function liveBackgroundWorkflowIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const live = new Set(liveBackgroundTaskIds(value))
  const out: string[] = []
  for (const t of value) {
    if (!t || typeof t !== 'object') continue
    const { id, type } = t as { id?: unknown; type?: unknown }
    if (type === 'workflow' && typeof id === 'string' && live.has(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * The prompt Claude injects into the PARENT when a background subagent hands its result back
 * (measured, 2.1.284, via the child's `SubagentHandback` tool): `<agent-message from="<agent id>">
 * [Subagent hand-back] …`. Like `<task-notification>` it is not a genuine user turn. Matched on the
 * whole marker, not on `<agent-message` alone: that envelope may also carry messages that ARE work
 * requests, and those must keep resetting the turn.
 */
const HANDBACK_RE = /^<agent-message from="[^"]*">\s*\[Subagent hand-back\]/

export function isInjectedSubagentPrompt(prompt: string): boolean {
  const p = prompt.trimStart()
  return p.startsWith('<task-notification>') || HANDBACK_RE.test(p)
}
