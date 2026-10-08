# Saved workflows

In **Settings → your project → Workflows**, select **Add starter templates**, edit the stages,
choose a default workflow, and save. The three starters are **Fix a bug**, **Add an endpoint**,
and **Update a dependency**. Each contains analysis, implementation, tests, review, corrections,
and final verification. Starters leave the changes local and uncommitted. To include a draft PR,
add a stage whose instruction explicitly asks for it.

Every stage specifies its agent, optional model, instruction, and transition:

- **Agent reports success and finishes** requires a verified successful outcome report and a
  completed turn, with no pending questions or background work.
- **Agent finishes and I approve** waits for **Approve stage**. A failed report or errored turn
  still stops the workflow.

Use **Run <default workflow>** on a GitHub issue card or in its detail view. The adjacent selector
starts another saved template. One unfinished workflow per issue is allowed on a host; clicking
again opens its existing history. Runs also expose their history and controls on their canvas frame.
Stage attempts link to their sessions on the board and canvas.

Each run creates a fresh branch and worktree from the project's configured worktree base. Project
shared paths and setup scripts are applied through the existing trust and setup mechanisms; stages
wait for setup to exit successfully. All stages work in the same checkout. Every stage gets context
links to earlier attempts and a durable brief containing the issue reference and stage instruction.
Issue titles, descriptions, and comments are not interpolated into a launch command.

**Pause** prevents further stages from starting; the current session continues. **Resume** explicitly
authorizes continued execution. **Retry stage** starts a new session in the same worktree and keeps
the previous attempt in history. The previous agent must be idle or exited. **Cancel workflow**
stops orchestration and keeps the sessions and worktree for inspection.

Stages advance in the host process while the project, board, or window is hidden. A full host
restart restores unfinished runs as paused and sends no launch input. A launch interrupted by a
restart is marked uncertain; inspect the session and retry explicitly. A missing stage session
becomes retryable on Resume. Settings changes affect future launches; editing a template does not
change an existing run's saved stage definitions.

## Storage and host support

Definitions live in `.nodeterm/project.json` under `workflows`; opening or cloning that file never
starts a run. Execution history lives only in the host's private
`orchestration-state/workflow-runs.json`, with owner-only file permissions. Briefs live beside it in
`workflow-briefs/`. History retains every unfinished run and the latest 200 finished runs. Malformed
history is preserved and refuses execution. Each stage claim is written before creating a session
or sending terminal input; an uncertain delivery is never automatically replayed.

Desktop and Server Edition use the same core engine. Enable persistent sessions and the selected
agents' nodeterm integrations. Server Edition also requires canvas control enabled. SSH projects
and relay connections show unsupported controls. On native Windows, workflows support built-in
agents through PowerShell or Command Prompt; WSL, Git Bash, custom agents, and launch wrappers
currently require using ordinary sessions instead. Windows launches use the parser-specific agent
planner and a file brief, with no POSIX shell substitutions.

The owner-only `workflows:*` RPC namespace provides definition save, start, list, action, and change
events on Desktop and Server. Relay peers cannot invoke it or receive private run history. Stage
nodes retain ordinary canvas and Kanban session behavior; their automatic cold relaunch is disabled
because the workflow host owns stage execution. Core additions are merged into stale owner saves
until acknowledged, while explicit canvas removals remain intentional.

Mobile companion follow-up for @eneskirca: add owner workflow history, stage links, and explicit
Approve/Retry/Pause/Resume/Cancel controls to both the iOS and Android clients. Mobile UI is not
included in this repository's v1 implementation.
