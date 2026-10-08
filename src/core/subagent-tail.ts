// Streams a subagent's live transcript to the renderer while it runs.
//
// Each subagent Claude spawns gets its own transcript at
//   <parent transcript dir>/<sessionId>/subagents/agent-<agentId>.jsonl
// plus an agent-<agentId>.meta.json that carries the spawning tool_use_id. We resolve the
// file by matching that toolUseId, then tail it (offset-based) and forward formatted lines.
// All read-only — if Claude changes the format we just stream less (no crash).
//
// A native Claude child (`trackNative`, keyed by its agent_id) is RESOLVED instead: it lives at
//   <parent transcript dir>/<sessionId>/subagents/agent-<agentId>.jsonl
// for an Agent/Task subagent, or (MEASURED 2.1.289) at
//   <parent transcript dir>/<sessionId>/subagents/workflows/<runId>/agent-<agentId>.jsonl
// for an agent of the `Workflow` tool, whose run id no hook hands us.
import fs from 'fs'
import path from 'path'
import {
  claudeSubagentMetaPath,
  claudeSubagentTranscriptPath,
  claudeWorkflowAgentTranscriptPath,
  claudeWorkflowsDir,
  isClaudeAgentId,
  labelFromSubagentMeta,
  SUBAGENT_META_READ_MAX
} from '../shared/agents/claude-subagents'

// Per-tick read ceiling, the same discipline as context-tail's INITIAL_READ_CAP: without it the
// first tick after track() (or any burst) allocates the entire delta in one Buffer. Unlike
// context-tail, a capped read here loses nothing — the tail is offset-based, so the next 400ms
// tick continues where this one stopped.
export const SUBAGENT_READ_CAP = 1024 * 1024 // 1 MB

interface Tracked {
  dir: string
  file: string | null
  offset: number
  /** An async read is in flight — the next tick skips this entry instead of double-reading. */
  reading?: boolean
  /** Meta files already parsed and rejected — don't re-read them on every 400ms tick. */
  seenMetas?: Set<string>
  /**
   * Bytes past the last newline of the previous read — a line caught mid-write. Held back
   * (as raw bytes, so a torn multibyte char survives) and prepended to the next read; without
   * this the torn line's halves each fail JSON.parse and the whole line is silently lost.
   */
  carry?: Buffer | null
  /**
   * Per-entry chunk formatter (trackFile's). Deliberately per ENTRY, not per tail instance:
   * a codex formatter is STATEFUL (it suppresses the fork-replay prefix of the child rollout),
   * so two concurrent subagents sharing one closure would gate each other's output.
   */
  fmt?: (text: string) => string
  /** finish() was called: the entry is dropped when this fires, unless a re-track revives it. */
  finishing?: ReturnType<typeof setTimeout>
  /**
   * trackNative's resolution: until `file` is found, each tick stats the flat path and then looks
   * for `<workflowsDir>/<run>/agent-<agentId>.jsonl`. Never matches another id: the file name is
   * built from this entry's own (token-validated) agent id.
   */
  resolve?: { agentId: string; parent: string; flat: string; workflowsDir?: string }
  /** trackNative's label callback, fed once from the resolved file's `.meta.json`. */
  onLabel?: (label: string) => void
  /** trackNative: the file was found under `subagents/workflows/` (a Workflow agent). */
  onWorkflow?: () => void
  /** Meta reads still allowed (the meta may land a moment after the transcript). */
  metaTries?: number
}

/**
 * How many run directories one resolution tick looks into — the NEWEST by mtime (a run directory's
 * mtime moves as its agents' files are written, so the running workflow is at the front), never the
 * first entries of an unsorted readdir: those are in name order, and a run id is random, so past
 * this many runs a new one used to be missed at random.
 */
export const WORKFLOW_RUNS_SCAN_MAX = 64
/** A run listing is re-read when the workflows directory changes, else at most this often. */
const RUN_LIST_REFRESH_MS = 5000
/** Workflows directories whose listing is remembered (one per parent session). */
const RUN_LIST_CACHE_MAX = 32
/** How many ticks may try the `.meta.json` before giving up on a label. */
const META_TRIES = 5

/** How many finished entries remember where they stopped (see `resumeAt`). */
const RESUME_MEMORY = 256

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

// A short, human-readable argument for a tool call (no raw JSON), e.g.
//   Read → workspace.ts   Bash → npm test   Grep → "NODE_COLORS"
function toolArg(name: string | undefined, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  const base = (p: unknown) => (typeof p === 'string' ? p.split('/').pop() || p : '')
  const p = i.file_path ?? i.path ?? i.notebook_path
  if (p) return base(p)
  if (typeof i.command === 'string') return i.command.replace(/\s+/g, ' ').slice(0, 80)
  if (typeof i.pattern === 'string') return `"${i.pattern.slice(0, 60)}"`
  if (typeof i.url === 'string') return i.url
  if (typeof i.query === 'string') return i.query.slice(0, 60)
  const txt = i.description ?? i.prompt
  if (typeof txt === 'string') return txt.replace(/\s+/g, ' ').slice(0, 80)
  void name
  return ''
}

// Collapse a tool result to a one-line summary instead of dumping the full
// (often line-numbered) content — keeps the panel readable like an activity log.
function summarizeResult(content: unknown): string {
  const r = textOf(content).trim()
  if (!r) return ''
  const lines = r.split('\n')
  const first = (lines.find((l) => l.trim()) ?? '').trim().slice(0, 100)
  const extra = lines.length > 1 ? ` … (+${lines.length - 1} lines)` : ''
  return `  ↳ ${first}${extra}`
}

// Render one transcript line as a clean activity log: assistant prose verbatim,
// tool calls as `$ Tool arg`, tool results as a one-line summary. Skips metadata.
export function formatLine(line: string): string {
  let o: { type?: string; message?: { content?: unknown } }
  try {
    o = JSON.parse(line)
  } catch {
    return ''
  }
  const content = o.message?.content
  if (o.type === 'assistant' && Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string; name?: string; input?: unknown }) => {
        if (c.type === 'text') return c.text ?? ''
        if (c.type === 'tool_use') {
          const arg = toolArg(c.name, c.input)
          return `$ ${c.name}${arg ? ` ${arg}` : ''}`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (o.type === 'user' && Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string; content?: unknown }) => {
        if (c.type === 'text') return c.text ?? ''
        if (c.type === 'tool_result') return summarizeResult(c.content)
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

// Format a chunk of newly-read transcript bytes into the activity-log text streamed to the
// renderer: drop blank lines, format each surviving line, drop empties, join with '\n'.
// Mirrors the tail read loop exactly so local + remote streamed output stay byte-identical.
export function formatSubagentChunk(text: string): string {
  return text
    .split('\n')
    .filter(Boolean)
    .map(formatLine)
    .filter(Boolean)
    .join('\n')
}

// Split accumulated transcript bytes at the last newline: everything up to it decodes to
// complete lines, the rest is carried (still raw bytes) into the next read. Splitting at the
// byte level is what makes a mid-multibyte tear safe — '\n' (0x0a) never occurs inside a
// UTF-8 continuation, so the carry always rejoins into valid UTF-8.
export function splitCompleteLines(data: Buffer): { text: string; carry: Buffer | null } {
  const nl = data.lastIndexOf(0x0a)
  if (nl === -1) return { text: '', carry: data.length ? data : null }
  return {
    text: data.subarray(0, nl + 1).toString('utf-8'),
    // Copy the tail so the (possibly large) read buffer isn't retained by the slice.
    carry: nl + 1 < data.length ? Buffer.from(data.subarray(nl + 1)) : null
  }
}

export interface TrackNativeHooks {
  /** A parseable `.meta.json` `description`, sanitized — at most once. */
  onLabel?: (label: string) => void
  /** The transcript was found under `subagents/workflows/<run>/` — once, when it is found. */
  onWorkflow?: () => void
}

export interface SubagentTail {
  track(toolUseId: string, transcriptPath: string | undefined): void
  /**
   * Tail a NATIVE Claude child by its agent_id, resolving its transcript from the parent's: the
   * flat `subagents/agent-<id>.jsonl`, else a Workflow run's `subagents/workflows/<run>/agent-<id>
   * .jsonl` (polled each tick until one exists). Once found, a Workflow location is reported to
   * `onWorkflow`, and the sibling `.meta.json` is read (bounded) and a parseable `description` is
   * handed to `onLabel` (sanitized). Same tick, cap, carry, finish and resume-by-agent-id semantics
   * as trackFile.
   */
  trackNative(agentId: string, parentTranscript: string | undefined, hooks?: TrackNativeHooks): void
  /**
   * Tail an already-resolved transcript FILE — no meta-dir matching, no claude formatting.
   * The codex leg: SubagentStart hands us the child rollout's path directly, and `newFormatter`
   * builds that entry's (stateful) line formatter. Same 400ms tick, cap, carry and finish
   * semantics as track().
   */
  trackFile(
    toolUseId: string,
    filePath: string | undefined,
    newFormatter?: () => (text: string) => string
  ): void
  finish(toolUseId: string): void
}

export function createSubagentTail(
  send: (payload: { toolUseId: string; chunk: string }) => void
): SubagentTail {
  const tracked = new Map<string, Tracked>()
  let timer: ReturnType<typeof setInterval> | null = null
  // Where each finished entry stopped. A Claude background subagent that ends its turn while its own
  // work runs fires SubagentStop and is RESUMED later under the same agent_id (measured, 2.1.284);
  // the shells stop the tail at the stop and start it again at the resume, and re-reading the file
  // from byte 0 would print the whole first turn a second time.
  const resumeAt = new Map<string, { file: string; offset: number }>()

  /** A re-track while finish() is still in its grace window: keep the entry, cancel the drop. */
  const revive = (toolUseId: string): boolean => {
    const e = tracked.get(toolUseId)
    if (!e) return false
    if (e.finishing) {
      clearTimeout(e.finishing)
      e.finishing = undefined
    }
    return true
  }

  const emit = (toolUseId: string, chunk: string): void => {
    if (chunk) send({ toolUseId, chunk })
  }

  // Async fs throughout: this ticks every 400ms per active subagent, and the sync version's
  // readdir + per-meta reads sat on the main event loop alongside all PTY/IPC traffic.
  const readOne = async (toolUseId: string, e: Tracked): Promise<void> => {
    if (e.reading) return
    e.reading = true
    try {
      if (!e.file && e.resolve) {
        const found = await resolveNative(e.resolve)
        if (!found) return
        e.file = found
        if (found !== e.resolve.flat) e.onWorkflow?.()
      }
      if (e.file && e.onLabel && (e.metaTries ?? 0) > 0) await readMetaLabel(e)
      if (!e.file) {
        let metas: string[]
        try {
          metas = await fs.promises.readdir(e.dir)
        } catch {
          return // dir not created yet
        }
        const seen = (e.seenMetas ??= new Set())
        for (const m of metas) {
          if (!m.endsWith('.meta.json') || seen.has(m)) continue
          try {
            const meta = JSON.parse(await fs.promises.readFile(path.join(e.dir, m), 'utf-8'))
            if (meta.toolUseId === toolUseId) {
              e.file = path.join(e.dir, m.replace(/\.meta\.json$/, '.jsonl'))
              break
            }
            // Only blacklist a meta that positively names another subagent. A parseable file
            // whose toolUseId hasn't landed yet (caught mid-write) must be re-read next tick,
            // or this subagent's own meta gets skipped forever and its transcript never streams.
            if (meta.toolUseId) seen.add(m)
          } catch {
            // unparseable (possibly still being written) — retry next tick, don't blacklist
          }
        }
        if (!e.file) return
      }
      const size = (await fs.promises.stat(e.file)).size
      if (size <= e.offset) return
      const len = Math.min(size - e.offset, SUBAGENT_READ_CAP)
      const buf = Buffer.alloc(len)
      const fd = await fs.promises.open(e.file, 'r')
      try {
        await fd.read(buf, 0, len, e.offset)
      } finally {
        await fd.close()
      }
      e.offset += len
      const data = e.carry?.length ? Buffer.concat([e.carry, buf]) : buf
      const { text, carry } = splitCompleteLines(data)
      e.carry = carry
      const out = (e.fmt ?? formatSubagentChunk)(text)
      if (out) emit(toolUseId, out + '\n')
    } catch {
      // file may not exist yet / transient read error
    } finally {
      e.reading = false
    }
  }

  const exists = async (p: string): Promise<boolean> => {
    try {
      return (await fs.promises.stat(p)).isFile()
    } catch {
      return false
    }
  }

  // Run directories, newest mtime first, shared by every child of one parent session. Re-read when
  // the workflows directory's own mtime moves (a new run) and at most every RUN_LIST_REFRESH_MS
  // otherwise (an older run's directory moving to the front), so a session with hundreds of runs
  // costs one stat per run per refresh — not per tick per child.
  const runLists = new Map<string, { dirMtimeMs: number; at: number; runs: string[] }>()
  const workflowRuns = async (dir: string): Promise<string[]> => {
    let dirMtimeMs: number
    try {
      dirMtimeMs = (await fs.promises.stat(dir)).mtimeMs
    } catch {
      return [] // no workflow has run in this session (yet)
    }
    const cached = runLists.get(dir)
    const now = Date.now()
    if (cached && cached.dirMtimeMs === dirMtimeMs && now - cached.at < RUN_LIST_REFRESH_MS) return cached.runs
    let names: string[]
    try {
      names = (await fs.promises.readdir(dir)).filter((n) => isClaudeAgentId(n))
    } catch {
      return []
    }
    const stamped = await Promise.all(
      names.map(async (n) => {
        try {
          const st = await fs.promises.stat(path.join(dir, n))
          return st.isDirectory() ? { n, m: st.mtimeMs } : null
        } catch {
          return null
        }
      })
    )
    const runs = stamped
      .filter((x): x is { n: string; m: number } => !!x)
      .sort((a, b) => b.m - a.m)
      .map((x) => x.n)
    runLists.delete(dir)
    runLists.set(dir, { dirMtimeMs, at: now, runs })
    if (runLists.size > RUN_LIST_CACHE_MAX) runLists.delete(runLists.keys().next().value!)
    return runs
  }

  const resolveNative = async (r: NonNullable<Tracked['resolve']>): Promise<string | null> => {
    if (await exists(r.flat)) return r.flat
    if (!r.workflowsDir) return null
    for (const run of (await workflowRuns(r.workflowsDir)).slice(0, WORKFLOW_RUNS_SCAN_MAX)) {
      const candidate = claudeWorkflowAgentTranscriptPath(r.parent, run, r.agentId)
      if (candidate && (await exists(candidate))) return candidate
    }
    return null
  }

  // The label is cosmetic: any failure just costs a try; a meta that parses but carries no usable
  // description ends the attempts (it will not grow one).
  const readMetaLabel = async (e: Tracked): Promise<void> => {
    e.metaTries = (e.metaTries ?? 0) - 1
    const meta = e.file ? claudeSubagentMetaPath(e.file) : undefined
    if (!meta) return void (e.metaTries = 0)
    // Bounded like the SSH locator's `head -c` (SUBAGENT_META_READ_MAX), so both shells read the
    // same prefix of the same file.
    let text: string
    try {
      const fd = await fs.promises.open(meta, 'r')
      try {
        const buf = Buffer.alloc(SUBAGENT_META_READ_MAX)
        const { bytesRead } = await fd.read(buf, 0, SUBAGENT_META_READ_MAX, 0)
        text = buf.subarray(0, bytesRead).toString('utf-8')
      } finally {
        await fd.close()
      }
    } catch {
      return
    }
    let parsed = true
    try {
      JSON.parse(text)
    } catch {
      parsed = false
    }
    if (!parsed) return // mid-write: retry next tick while tries remain
    e.metaTries = 0
    const label = labelFromSubagentMeta(text)
    if (label) e.onLabel?.(label)
  }

  const tick = () => {
    for (const [toolUseId, e] of tracked) void readOne(toolUseId, e)
    if (!tracked.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    track(toolUseId, transcriptPath) {
      if (!transcriptPath || revive(toolUseId)) return
      const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents')
      tracked.set(toolUseId, { dir, file: null, offset: 0 })
      if (!timer) timer = setInterval(tick, 400) // only runs while subagents are active
    },
    trackNative(agentId, parentTranscript, hooks) {
      const onLabel = hooks?.onLabel
      const flat = parentTranscript ? claudeSubagentTranscriptPath(parentTranscript, agentId) : undefined
      if (!parentTranscript || !flat || revive(agentId)) return
      const resumed = resumeAt.get(agentId)
      resumeAt.delete(agentId)
      tracked.set(agentId, {
        dir: path.dirname(flat),
        // A resumed child: the file was already resolved under this same agent id.
        file: resumed?.file ?? null,
        offset: resumed?.offset ?? 0,
        resolve: { agentId, parent: parentTranscript, flat, workflowsDir: claudeWorkflowsDir(parentTranscript) },
        onLabel,
        onWorkflow: hooks?.onWorkflow,
        metaTries: onLabel ? META_TRIES : 0
      })
      if (!timer) timer = setInterval(tick, 400)
    },
    trackFile(toolUseId, filePath, newFormatter) {
      if (!filePath || revive(toolUseId)) return
      const resumed = resumeAt.get(toolUseId)
      resumeAt.delete(toolUseId)
      tracked.set(toolUseId, {
        dir: path.dirname(filePath),
        file: filePath,
        offset: resumed?.file === filePath ? resumed.offset : 0,
        fmt: newFormatter?.()
      })
      if (!timer) timer = setInterval(tick, 400)
    },
    finish(toolUseId) {
      // The file is complete now, so a held-back carry is a real final line that just lacks
      // its trailing newline — flush it after the final read instead of dropping it.
      const flushCarry = (e: Tracked): void => {
        if (!e.carry?.length) return
        const out = (e.fmt ?? formatSubagentChunk)(e.carry.toString('utf-8'))
        e.carry = null
        if (out) emit(toolUseId, out + '\n')
      }
      const e = tracked.get(toolUseId)
      if (!e || e.finishing) return
      void readOne(toolUseId, e).then(() => {
        if (e.finishing) flushCarry(e) // final flush (completes well within the grace delay)
      })
      e.finishing = setTimeout(() => {
        if (tracked.get(toolUseId) !== e) return
        tracked.delete(toolUseId)
        flushCarry(e) // ticks during the grace window may have re-filled the carry
        if (e.file) {
          resumeAt.set(toolUseId, { file: e.file, offset: e.offset })
          if (resumeAt.size > RESUME_MEMORY) resumeAt.delete(resumeAt.keys().next().value!)
        }
      }, 1500)
    }
  }
}
