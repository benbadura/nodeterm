# Project decisions and task handoff

Local folder projects in Desktop can retain approved decisions and task checkpoints. Open **Project memory…** from the project tab menu, or **Memory** in a task's kanban card. SSH, Server Edition, relay clients and canvases without a folder are unsupported in this first version.

## Record and review

A decision records the solution, rationale, constraints, alternatives/failed attempts and at least one source. Choose project scope for decisions shared by new sessions, or task scope for decisions relevant only to that task.

Agents submit proposals; the user approves or rejects them in Desktop. A proposed revision leaves the existing approval active until the replacement is approved. Rejected, superseded and withdrawn decisions remain in history. Only approved decisions enter startup packets.

Task checkpoints record the goal, completed work, remaining work, blockers, attempts and next step. They are attributed reports, not proof that work passed review. Each save adds a checkpoint; old checkpoints remain readable. Concurrent edits check the stored revision and reject stale saves without overwriting newer work. On a conflict, retain any draft text, reload the record and start the edit again.

Sources support a project-relative file path (optionally `:line` or `#Lline`), an optional full Git commit hash, an HTTP(S) URL, or a session node ID. Each source retains an author-supplied excerpt. File previews are limited to 64 KiB, committed files are read from Git, and file paths cannot escape the project through traversal or symlinks. Missing files, commits or sessions leave the saved excerpt available. Excerpts are not independently verified.

## Fresh sessions and transfers

A fresh local agent session receives a short packet with approved project decisions and, when it is bound to a task, that task's latest checkpoint and approved decisions. The packet is prepared at delivery time, so a queued session receives current memory when it actually starts. Existing/resumed conversations do not receive duplicate packets. Empty projects retain their original launch command. Desktop workflow stages receive project memory with their workflow brief.

**Preview startup packet** shows the generated context. It prioritizes goal, current state and next step, limits the brief to 12,000 characters, labels missing information and links the full records when details are omitted.

**Transfer task…** opens a fresh session with the selected agent/model and binds it to the same task before launch. The new agent is instructed to read the packet, summarize the state, then wait for the user's next instruction. This waiting behavior is a prompt instruction, not a separate execution permission mode. The existing conversation-transfer action continues to export the original transcript independently.

Memory is context, not authorization to run commands. A corrupt/unreadable packet stops launch preparation and reports an error; it does not silently start the agent without the requested context.

## Agent CLI

From a verified local nodeterm agent node, use the installed canvas-control CLI:

```sh
memory_control_script="/path/from/your/agent/instructions/canvas-control/nodeterm.sh"
sh "$memory_control_script" memory --action read
sh "$memory_control_script" memory --action propose --file /absolute/path/proposal.json
sh "$memory_control_script" memory --action checkpoint --file /absolute/path/checkpoint.json
sh "$memory_control_script" memory --action packet
```

Set `memory_control_script` to the installed `canvas-control/nodeterm.sh` path shown in the agent's nodeterm instructions. Read first to obtain `project.revision` and `task.revision` (zero before a task exists). The CLI selects the caller's own project and task; it has no approval action.

Example proposal (use the current project revision):

```json
{
  "expectedRevision": 0,
  "decision": {
    "scope": "project",
    "title": "Store decisions with the project",
    "decision": "Keep records in .nodeterm/memory.",
    "rationale": "The context should move with the checkout.",
    "constraints": "Local Desktop projects in v1.",
    "alternatives": "An application-private database would not move with the folder.",
    "sources": [{
      "kind": "file",
      "location": "docs/design.md:12",
      "label": "Design discussion",
      "excerpt": "Keep approved decisions beside the project."
    }]
  }
}
```

Example checkpoint (use the current task revision):

```json
{
  "expectedRevision": 0,
  "checkpoint": {
    "goal": "Implement project memory",
    "completed": "Storage and review panel implemented",
    "remaining": "Verify session handoff",
    "blockers": "",
    "attempts": "An in-memory prototype lost its state on restart.",
    "nextStep": "Transfer the task to a fresh session and inspect its recap.",
    "sources": []
  }
}
```

JSON input is limited to 256 KiB. Proposal authors and checkpoint authors come from the verified session, regardless of author/status fields in the submitted JSON. Propose meaningful decisions during work and update the checkpoint before handing the task back; there is no separate model invocation or automatic transcript summarizer.

## Storage and recovery

Records live under the project's `.nodeterm/memory/`:

- `project.json`: approved/proposed project decisions and node-to-task bindings.
- `tasks/<task-id>.json`: task decisions and append-only checkpoint history.
- `packets/<uuid>.md`: immutable briefs generated for previews and session launches.
- `write.lock`: an exclusive lock held during writes.

Task identity survives closing its original node. Copying the project folder copies its memory; project file sources remain relative to that folder. Nodeterm neither commits nor publishes these files automatically. Files in the project are editable by anyone with filesystem access; Desktop approval is a review workflow, not protection from direct disk edits.

Writes are atomic per record. Invalid records are reported and left untouched. A writer crash can leave `write.lock`; close all writers, then remove only that stale lock before retrying. Records stop accepting writes at 64 MiB instead of deleting history. Packets are retained because queued sessions can still reference them.

Implementation: [storage and CLI](../src/core/project-memory.ts), [record schema and packet rendering](../src/shared/project-memory.ts), [launch preparation](../src/shared/memory-launch.ts), [review panel](../src/renderer/components/ProjectMemoryPanel.tsx).
