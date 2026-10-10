import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'
import { BranchSelect } from './BranchSelect'
import type { AgentWorkspaceMode } from '@shared/agent-workspace'
import {
  filterWorktrees,
  isValidGitRef,
  type WorktreeCreateValue,
  type WorktreeEntry
} from '@shared/worktree'

interface Props {
  /** 'create' = the pane/palette entry point (a new group frame); 'bind' = an existing group's
   *  "Bind to worktree…". Only the wording differs — both can create or adopt a worktree. */
  intent: 'create' | 'bind'
  /** Repo root, resolved from the project cwd. Empty only when the project is not a git repo. */
  repoPath: string
  /** Worktrees that already exist for this repo, excluding the main checkout and bound ones. */
  existing: WorktreeEntry[]
  /** The repo's default branch (the main checkout's), used as the Base default. */
  defaultBaseRef: string
  /** The repo's local branch names. Base and the "existing branch" field pick from these with a
   *  custom dropdown (`BranchSelect`). Base's dropdown also carries a free-text field so a base can
   *  be any ref (a tag / SHA / `origin/x`), not just a local branch. Empty ⇒ plain text inputs. */
  branches: string[]
  /** Suggested worktree path. Returns '' when no writable base dir is known — see `pathUnknown`. */
  defaultPath: (repoPath: string, branch: string) => string
  busy: boolean
  error: string | null
  onCreate: (v: WorktreeCreateValue) => void
  onBindExisting: (e: WorktreeEntry) => void
  onCancel: () => void
  /** Manual agent creation shares the worktree fields but always creates a new branch. */
  agent?: {
    label: string
    accountLabel?: string
    currentCwd: string
    initialMode: AgentWorkspaceMode
    worktreeUnavailable: string | null
    onCurrent: () => void
  }
}

/** Create a worktree (and the group frame around it), or bind a group to one that already exists. */
export function WorktreeDialog({
  intent,
  repoPath,
  existing,
  defaultBaseRef,
  branches,
  defaultPath,
  busy,
  error,
  onCreate,
  onBindExisting,
  onCancel,
  agent
}: Props) {
  const [workspaceMode, setWorkspaceMode] = useState<AgentWorkspaceMode>(agent?.initialMode ?? 'current')
  // Keep a remembered worktree choice while the repository is still being resolved. An
  // unavailable repository temporarily shows Current directory without overwriting the choice.
  const currentWorkspace = !!agent && (workspaceMode === 'current' || !!agent.worktreeUnavailable)
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [branch, setBranch] = useState('feature/')
  // `feature/` is a head-start for typing, not a submittable value — it fails `isValidGitRef`
  // (trailing slash). Showing the red "not a valid branch name" error on an untouched dialog reads
  // as the app yelling before the user has done anything, so the error waits until the field is
  // touched. (Create stays disabled meanwhile — see `valid` — so an unfinished `feature/` can't
  // slip through either way.)
  const [branchEdited, setBranchEdited] = useState(false)
  const [baseRef, setBaseRef] = useState(defaultBaseRef)
  const [path, setPath] = useState(() => defaultPath(repoPath, 'feature/'))
  const [pathEdited, setPathEdited] = useState(false)
  const [existingQuery, setExistingQuery] = useState('')

  // Keep the path in sync with the branch until the user edits it by hand.
  useEffect(() => {
    if (!pathEdited) setPath(defaultPath(repoPath, branch || 'work'))
  }, [repoPath, branch, pathEdited, defaultPath])

  // The repo's default branch resolves asynchronously (the store fills after the first render);
  // adopt it as long as the user has not typed a base of their own.
  const [baseEdited, setBaseEdited] = useState(false)
  useEffect(() => {
    if (!baseEdited) setBaseRef(defaultBaseRef)
  }, [defaultBaseRef, baseEdited])

  const hasBranches = branches.length > 0
  const filteredExisting = filterWorktrees(existing, existingQuery)

  // Only the topmost modal answers a key (./dialog-stack): this dialog and a ConfirmDialog can be
  // open at the same time, and one Escape must not close both.
  const isTop = useDialogStack()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!busy) onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop, onCancel, busy])

  // No writable base dir is known, so we refuse to *suggest* a path — an empty base would
  // otherwise propose `/worktrees/…` at the filesystem root. The user can still type one. The hint
  // tracks the FIELD, not `pathEdited`: clearing the box after editing it also leaves Create
  // disabled, and a disabled button with no explanation is a dead end.
  const pathUnknown = !path.trim()
  // Gate Create on the same validator the ops layer uses, so "clickable" always means "will not be
  // rejected for this reason" — the button reflects the REAL validity (so an untouched `feature/`
  // can't be submitted). The red error, by contrast, only appears once the user has touched the
  // field (`branchEdited`): a fresh dialog must not accuse the user of a bad name they never typed.
  const branchInvalid = !!branch.trim() && !isValidGitRef(branch)
  const valid =
    !busy &&
    (currentWorkspace ||
      (!!repoPath.trim() &&
        !!branch.trim() &&
        !branchInvalid &&
        !!path.trim() &&
        (!agent || isValidGitRef(baseRef))))
  const title = agent ? `New ${agent.label}` : intent === 'bind' ? 'Bind to worktree' : 'New worktree'
  const createLabel = agent
    ? currentWorkspace
      ? 'Start agent'
      : 'Create worktree & start agent'
    : intent === 'bind'
      ? 'Create & bind'
      : 'Create'

  return createPortal(
    <div
      className="confirm-overlay"
      onClick={() => {
        if (!busy) onCancel()
      }}
    >
      <form
        className="confirm bind-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (!isTop() || !valid) return
          if (currentWorkspace) agent!.onCurrent()
          else {
            onCreate({
              repoPath: repoPath.trim(),
              mode: agent ? 'new' : mode,
              branch: branch.trim(),
              baseRef: baseRef.trim(),
              path: path.trim()
            })
          }
        }}
      >
        <p className="confirm__msg">{title}</p>

        {agent?.accountLabel && <p className="bind-hint">Account: {agent.accountLabel}</p>}
        <fieldset className="bind-fields" disabled={busy}>
          {agent && (
            <>
              <div className="bind-mode" role="radiogroup" aria-label="Agent workspace">
                <label>
                  <input
                    type="radio"
                    name="agent-workspace"
                    checked={currentWorkspace}
                    onChange={() => setWorkspaceMode('current')}
                  />{' '}
                  Current directory
                </label>
                <label title={agent.worktreeUnavailable ?? undefined}>
                  <input
                    type="radio"
                    name="agent-workspace"
                    checked={!currentWorkspace}
                    disabled={!!agent.worktreeUnavailable}
                    onChange={() => setWorkspaceMode('new-worktree')}
                  />{' '}
                  New worktree
                </label>
              </div>
              {agent.worktreeUnavailable && <p className="bind-hint">{agent.worktreeUnavailable}</p>}
            </>
          )}

          <div className="bind-repo" title={currentWorkspace ? agent!.currentCwd : repoPath}>
            {currentWorkspace ? agent!.currentCwd : repoPath || 'This project is not a git repository.'}
          </div>

          {!agent && existing.length > 0 && (
            <div className="bind-existing">
              <div className="bind-existing__title">Existing worktrees</div>
              <input
                className="bind-existing__search"
                type="search"
                aria-label="Search existing worktrees"
                placeholder="Search branch or path…"
                value={existingQuery}
                onChange={(e) => setExistingQuery(e.target.value)}
              />
              <div className="bind-existing__list">
                {filteredExisting.map((e) => (
                  // A detached-HEAD worktree cannot be bound (there is no branch to merge or name the
                  // group after), so the row is DISABLED and says why — clicking it used to be a
                  // silent no-op.
                  <button
                    type="button"
                    key={e.path}
                    className="bind-existing__row"
                    disabled={busy || !e.branch}
                    onClick={() => onBindExisting(e)}
                    title={
                      e.branch
                        ? e.path
                        : `${e.path}\nDetached HEAD — check out a branch in this worktree first.`
                    }
                  >
                    <span className="bind-existing__branch">
                      {e.branch ? `⎇ ${e.branch}` : '⎇ (detached HEAD — check out a branch first)'}
                    </span>
                    <span className="bind-existing__path">{e.path}</span>
                  </button>
                ))}
                {filteredExisting.length === 0 && (
                  <div className="bind-existing__empty">No matching worktrees</div>
                )}
              </div>
            </div>
          )}

          {!currentWorkspace && (
            <>
              {!agent && (
                <div className="bind-mode">
                  <label>
                    <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> New branch
                  </label>
                  <label>
                    <input
                      type="radio"
                      checked={mode === 'existing'}
                      onChange={() => setMode('existing')}
                    />{' '}
                    Existing branch
                  </label>
                </div>
              )}

              {/* New branch = a name that must NOT exist yet, so free text. Existing branch = check out
                  one that DOES exist, so pick it from the dropdown (falls back to text if none were read). */}
              {mode === 'existing' && hasBranches ? (
                <div className="bind-field">
                  Branch
                  <BranchSelect
                    value={branches.includes(branch) ? branch : ''}
                    options={branches}
                    placeholder="Select a branch…"
                    onChange={(v) => {
                      setBranch(v)
                      setBranchEdited(true)
                    }}
                  />
                </div>
              ) : (
                <label className="bind-field">
                  Branch
                  <input
                    autoFocus={!!agent}
                    value={branch}
                    onChange={(e) => {
                      setBranch(e.target.value)
                      setBranchEdited(true)
                    }}
                  />
                </label>
              )}

              {branchEdited && branchInvalid && (
                <div className="bind-error">
                  Not a valid branch name — finish typing one (no spaces, "..", or a leading/trailing
                  slash).
                </div>
              )}

              {mode === 'new' && (
                <>
                  {/* Pick a branch from the dropdown, or type any ref (tag / SHA / origin/x) in its
                      free-text field. If the branch list could not be read, degrade to a plain input. */}
                  {hasBranches ? (
                    <div className="bind-field">
                      Base
                      <BranchSelect
                        value={baseRef}
                        options={branches}
                        placeholder="Select a base…"
                        allowCustom
                        customPlaceholder="or a tag, commit, origin/…"
                        onChange={(v) => {
                          setBaseRef(v)
                          setBaseEdited(true)
                        }}
                      />
                    </div>
                  ) : (
                    <label className="bind-field">
                      Base
                      <input
                        value={baseRef}
                        placeholder="e.g. origin/main, a tag, or a commit"
                        onChange={(e) => {
                          setBaseRef(e.target.value)
                          setBaseEdited(true)
                        }}
                      />
                    </label>
                  )}
                </>
              )}

              <label className="bind-field">
                Worktree path
                <input
                  value={path}
                  onChange={(e) => {
                    setPath(e.target.value)
                    setPathEdited(true)
                  }}
                />
              </label>

              {pathUnknown && (
                <div className="bind-error">
                  No default worktree location is available. Enter a full path to create one.
                </div>
              )}
              {agent && (
                <p className="bind-hint">
                  Starts from the selected Git base. Uncommitted changes stay in the current directory.
                </p>
              )}
            </>
          )}
        </fieldset>
        {error && <div className="bind-error">{error}</div>}

        <div className="confirm__actions">
          <button type="button" className="confirm__btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="confirm__btn primary"
            type="submit"
            autoFocus={currentWorkspace}
            disabled={!valid}
          >
            {busy ? 'Creating…' : createLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
