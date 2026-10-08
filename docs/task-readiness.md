# Task readiness

Open a terminal card in Kanban and select **Readiness**, or click its readiness
chip on the board or canvas. The panel collects acceptance criteria, checkout
changes, test results, review findings, and preview links in one place.

Readiness is informational. It does not move a card to Done, start a command,
release a dependent station, or approve an agent's work. Test and review results
are declarations by the author shown on the report; nodeterm measures the code
version and changed files itself.

## Record and assess a task

1. Add acceptance criteria and save them. Existing cards default to the current
   HEAD as their comparison base. New local sessions capture their initial HEAD
   before launch. You can choose another full local commit SHA.
2. Capture the code **before** running tests, reviewing, or checking the preview.
3. Record the results against that snapshot and save the report. New reports
   start with unassessed criteria and missing evidence.
4. Reopen the card to inspect the latest report and previous reports. Creating a
   new report preserves older results and their original criteria and snapshots.

Each evidence section is Recorded, Missing, or Not applicable. Not applicable
requires a reason. Missing or skipped checks do not count as passing. Failed
tests, unmet criteria, and review issues remain visible.

## Code versions and freshness

A snapshot includes HEAD, the index, tracked working-file contents, nonignored
untracked contents, the checkout location, and the acceptance-criteria revision.
The app checks that the checkout remains stable while reading it. File names
alone never serve as proof that earlier checks still apply.

Any code, staging, commit, checkout, or criteria change makes the latest report
**Needs refresh**. Changes made while checks run do not restamp their results:
submitting the report keeps its original snapshot. Checking freshness only reads
the current code; it never updates the report's version. Reverting to exactly the
captured state can make a report current again.

All `.nodeterm` directories and Git-ignored untracked output are excluded.
The changed-file list compares the whole checkout against the task's base; it
can include other work in a shared checkout. Worktrees are measured independently.
Visible cards check periodically (five seconds), on window focus, and after a
report or criteria save.

If Git, files, or the worktree are unavailable, freshness becomes **Cannot
verify**, never Current. This version also refuses unresolved merges, submodules,
sparse/assume-unchanged entries, over 64 MiB of untracked files, or over 256 MiB
of measured contents. These limits are reported explicitly.

## Structured reports from an agent

The canvas-control CLI exposes `readiness` for the verified caller's own card
in a saved local Desktop project. It cannot submit results to another card.

```sh
taskControl="/path/from/agent-instructions/canvas-control/nodeterm.sh"
sh "$taskControl" readiness --action read
sh "$taskControl" readiness --action criteria --file /tmp/criteria.json
sh "$taskControl" readiness --action snapshot
# Run checks against the captured code, then submit their results:
sh "$taskControl" readiness --action report --file /tmp/report.json
```

Replace `taskControl` with the canvas-control `nodeterm.sh` path supplied in the
agent's generated instructions. Save input JSON in a temporary directory
or `.nodeterm/readiness-input/`, so preparing it does not change the code snapshot.

Criteria input uses the `criteriaRevision` from `read` as `expectedRevision`:

```json
{
  "expectedRevision": 0,
  "criteria": [{ "id": "c1", "text": "The submitted form retains its values." }]
}
```

A snapshot reply supplies its `id`, frozen `acceptance` criteria, HEAD,
fingerprint, and changed files. Use the returned id in the report:

```json
{
  "snapshotId": "<id from snapshot>",
  "criteria": [{ "id": "c1", "status": "met", "note": "Checked in the browser." }],
  "tests": {
    "status": "recorded",
    "items": [{ "command": "npm test", "status": "passed", "exitCode": 0, "summary": "12 tests passed." }]
  },
  "review": {
    "status": "recorded",
    "items": [{ "summary": "No blocking findings.", "outcome": "passed", "findings": [] }]
  },
  "preview": {
    "status": "recorded",
    "items": [{ "label": "Local preview", "url": "http://localhost:3000/" }]
  }
}
```

Criterion statuses: `met`, `unmet`, `unknown`. Test statuses: `passed`, `failed`,
`skipped`, `unknown`. Review outcomes: `passed`, `issues`. Findings have `summary`,
`severity` (`info`, `warning`, `blocking`), and optional `file` and `line`.
A review can include `sourceNodeId`. Preview links must be HTTP(S) without
embedded credentials. A section with no evidence uses either
`{"status":"missing","items":[]}` or
`{"status":"not-applicable","reason":"Explanation","items":[]}`.

Inputs are limited to 256 KiB. Commands mentioned in a report are displayed,
never executed. Editing criteria invalidates pending snapshots; capture again
and assess the new criteria. A submitted snapshot cannot be reused.

## Storage and scope

Criteria, pending captures, and immutable report history are stored atomically in
the owning project's `.nodeterm/readiness/<nodeId>.json`. History is displayed in
pages of 20; old reports are not silently discarded. Corrupt or oversized history
is refused without overwriting it. A history file is limited to 64 MiB.

Version one supports local Git checkouts and worktrees in Desktop. SSH projects,
Server Edition, relay sessions, and non-Git directories cannot provide verified
freshness. Remote clients cannot read or write the host's readiness sidecars.
