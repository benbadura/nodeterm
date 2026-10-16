# Task board (Desktop, opt in)

Enable **Project settings → Task board** for each local project. The existing board shortcut
(Cmd/Ctrl+Shift+B) then opens Tasks. **Session view** opens the original board, with its custom
columns, saved views, comments and per-session readiness reports. Turning the feature off leaves
task files and sessions intact. SSH, relay, Server Edition and iOS retain the session workflow.

A task is an outcome, independent of a terminal. Its fixed stages are **To do → In progress →
Ready to accept → Done**. Questions, errors, pending plans and missing reports are annotations;
**Needs attention** displays one row per task, prioritizing questions, failures, plans and results.
The all-project scope includes enabled local projects.

## Working with a task

1. Create a brief and observable acceptance criteria. Optionally require plan approval or an
   automatic review. The defaults are direct implementation and review on demand.
2. Choose an agent and, for Claude, a local account. Git projects default to a separate branch
   and worktree. Choose **Current checkout** to work there instead. Non-Git projects use the
   current folder and cannot provide Git snapshot verification.
3. Start the task. The host launches a persistent session in the background; hiding the board
   does not stop it. A project runs one task at a time by default (configurable from 1 to 8).
   Later starts queue. Queued runs can be cancelled before launch.
4. If planning is enabled, inspect the submitted plan and select **Approve plan & implement**.
   Implementation gets its own run and session, in the same checkout. **Request revised plan**
   starts another planning run with your instructions.
5. Inspect the explicit implementation result, **Changes & checks**, live diff, frozen reports,
   preview links and any requested review. Request corrections or a separate review as needed.
   Ending an agent turn alone never delivers or accepts a task.
6. Select **Accept result**. Missing, failing, unknown or stale verification requires checking
   the acknowledgement and selecting **Accept despite gaps**. Acceptance records the exact
   result and snapshot, the named author, time and outstanding warnings. It waits for active
   sessions to settle. Reopening preserves earlier decisions and reports.

Results are declarations by their named authors. A snapshot fingerprints HEAD, index, tracked
files and non-ignored untracked files. Changing code or the brief marks evidence stale. Evidence
cannot be resubmitted using a consumed capture or an obsolete run. Worktree setup uses the
project's approved setup and shared-path settings; it does not copy uncommitted main-checkout work.

Existing sessions are imported or attached deliberately. Import copies the title, issue reference
and existing board metadata, and links the original session history. Attachment sends no prompt.
Import can optionally map the session column's lifecycle category; completed sessions become
ready for acceptance and still require an explicit decision.
One session can belong to only one active task, and additional attached sessions must use the
task's checkout. Original readiness files and comments remain in the session view.

## Restart and recovery

Restart restores session associations, without replaying launch commands. Queued runs stay
paused until **Resume queue**. A recovered session without a verified current state is shown as
unknown. Open it and inspect its actual state before confirming that its turn has ended. This
confirmation is recorded in task history. A known working session or outstanding question cannot
be confirmed idle. A setup or launch failure records the error; retry creates a new run id and
reuses the task checkout. Checkout deletion or a changed branch is a visible refusal.

## GitHub and Git

Import uses the existing project repository configuration and cache. Imports deduplicate by
canonical owner/repository/issue number. Title and body are copied initially; later updates
require **Refresh brief from GitHub**, which also invalidates the previous scope verification.
Linked PR and CI badges are read-only and show the host's last known status.

Local acceptance does not merge, push, close an issue or delete a worktree. **Close GitHub issue**
is a separate action after acceptance, using the project's approved completion-column mapping
and optimistic GitHub update timestamp. If the mapping is absent, use the issue link or configure
the mapping in Session view. A failed close leaves local acceptance intact.

## Agent reporting

The verified canvas-control CLI exposes `task` for the caller's own current run. Agents cannot
create or accept tasks, approve plans, launch another run, or report for someone else's session.
Use the canvas-control script path supplied in the agent instructions:

```sh
sh "$taskControl" task --action read
sh "$taskControl" task --action plan --file /tmp/task-plan.json
sh "$taskControl" task --action snapshot
# Run checks against the captured code, then submit its snapshot id:
sh "$taskControl" task --action report --file /tmp/task-report.json
sh "$taskControl" task --action block --file /tmp/task-blocker.json
```

Plan input is `{"plan":"Concrete plan"}`; blocker input is `{"reason":"What is blocking work"}`.
Result input is `{"summary":"Changes, checks, issues and manual test steps","evidence":{...}}`.
`evidence` uses the [readiness report schema](task-readiness.md), including the capture's id as
`snapshotId`. A summary without evidence is allowed and visibly incomplete. Keep report inputs
in a temporary directory or `.nodeterm/task-input/` so creating them does not alter the snapshot.
Only the user approves plans and accepts results; a planning run cannot skip approval by
submitting an implementation report. Brief changes require a fresh run against the new scope.

## Storage and compatibility

Each owning project stores one versioned `.nodeterm/tasks/<taskId>.json` with revision-checked
atomic writes and an exclusive process lock. The owning directory remains the primary project
when agents use another worktree. Runs, immutable results, acceptances and activity are retained.
Do not commit `write.lock`. If a process dies while holding it, verify that the writer has stopped
before removing that lock; corrupt or symlinked history is refused rather than overwritten.

The installation's private `task-host-id` prevents adopting another host's saved sessions. Every
launch resolves the agent, account and permission settings on the current host. Renderer APIs
are local-client-only; remote bridges return explicit unsupported replies. The legacy `readiness`
API and all session-board assignments remain unchanged.

## Manual release check

Use a disposable local project and inspect the board in these five states:

- New task with no run: create criteria, choose current checkout or worktree, verify keyboard focus.
- Working / needs an answer: hide the board, reopen it, answer in the linked session.
- Plan awaiting approval: request a revision, approve it, verify a new implementation session.
- Result awaiting acceptance: inspect current and stale evidence, request review/corrections,
  explicitly accept gaps, and verify GitHub closure remains a separate action.
- Restart / failure: queue a second task, restart, verify no automatic launch, inspect unknown
  sessions, resume or cancel queued work, and retry a failed setup in the same worktree.

Automated coverage is in `task-service.test.ts`, `task-runtime.test.ts` and `TaskBoard.test.tsx`,
alongside the existing readiness, hook verification, CLI, bridge and session-board regression tests.
