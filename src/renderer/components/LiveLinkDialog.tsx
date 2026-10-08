// Create a live link to one terminal. Opened only through `openLiveLink` (lib/liveLinkEntry): the
// availability rule and the Pro gate have already run by the time this mounts.
//
// Figma's share-dialog shape: one row per choice, each reading as a sentence ("Anyone with the link
// can watch", "Expires in 1 hour"), the choices in small menus instead of radio lists.
//
// The warning is always visible (not a checkbox): the owner must read what a link exposes every
// time, because "the screen" includes whatever is printed next.
//
// The URL carries the link's secret. It is shown HERE, once created, and in the chip's popover —
// never in a notice, a log line or the Settings list (which only copies it).
//
// A Control link's PASSWORD is plaintext only in this component's state: typed or generated in the
// form, shown once in the done step, and dropped on every close (`dismiss`) and with the component.
// It is never written to localStorage, settings, a log or a notice; core keeps only its hash.
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'
import { IconClock, IconClose, IconLock, IconReload, IconUser, IconWeb } from './icons'
import { MenuSelect } from './MenuSelect'
import { newControlPassword, PasswordField, useCopied } from './LiveLinkPassword'
import {
  capUnits,
  CONTROL_UNSUPPORTED_REASON,
  controlWarning,
  controlWarningMachine,
  createErrorMessage,
  formatUntil,
  LIVE_LINK_EXPOSURE,
  PASSWORD_SEPARATE_NOTE,
  PASSWORD_SHOWN_ONCE,
  passwordProblemText,
  ROLE_CHOICE,
  ROLE_ORDER,
  SAVE_FIRST_MESSAGE,
  TTL_OPTIONS,
  watchableOnlyWhileOpen,
  watchWhileOpenNote,
  type LiveLinkSurface
} from '../lib/liveLink'
import { loadLiveLinkDefaults, saveLiveLinkDefaults } from '../lib/liveLinkDefaults'
import { stopLiveLinks } from '../lib/liveLinkEntry'
import { loadIdentity } from '../state/presence'
import {
  LABEL_MAX,
  stripBidiControls,
  type CreateWatchLinkRequest,
  type WatchLinkRole,
  type WatchLinkTtl
} from '@shared/watch-link-types'

/** Spec §2.7's typing warning, its "and" stressed. Text only: the machine is our own wording. */
function ControlWarning({ machine }: { machine: string }): React.JSX.Element {
  const [before, and, after] = controlWarning(machine)
  return (
    <p className="live-dialog__warning">
      {before}
      <strong>{and}</strong>
      {after}
    </p>
  )
}

/** The dialog's head: the node's title and a close button (which every dismissal rule still owns). */
function DialogHead(p: { title: string; onClose: () => void; disabled?: boolean }): React.JSX.Element {
  return (
    <div className="live-dialog__head">
      <p className="live-dialog__title" title={p.title}>
        Share “{p.title}”
      </p>
      <button type="button" className="live-dialog__close" aria-label="Close" disabled={p.disabled} onClick={p.onClose}>
        <IconClose />
      </button>
    </div>
  )
}

export type DialogState =
  | {
      phase: 'form'
      role: WatchLinkRole
      ttl: WatchLinkTtl
      label: string
      /** A Control link's password, as typed or generated. Kept while the owner switches roles (they
       *  may switch back); sent only for Control. */
      password: string
      /** A prepare or a create is in flight: the dialog cannot be dismissed (H24) — a link created
       *  behind a closed dialog would be broadcasting with a URL its owner never saw. */
      busy: boolean
      error: string | null
      /** The error is `not-entitled`: offer Upgrade (when the caller can — never on the Server
       *  Edition, which passes no `onUpgrade`). */
      offerUpgrade?: boolean
    }
  | {
      phase: 'done'
      /** The link's role: the done step reads Control off THIS, never off whether a password is set. */
      role: WatchLinkRole
      url: string
      linkId: string
      /** null: an Unlimited link. */
      expiresAt: number | null
      /** A Control link's password, shown this once (core keeps only its hash). Absent otherwise. */
      password?: string
      stopping?: boolean
      error?: string | null
    }

export function LiveLinkDialogBody(p: {
  title: string
  state: DialogState
  onChange: (s: DialogState) => void
  onSubmit: () => void
  onClose: () => void
  onStop: (linkId: string) => void
  onCopy?: (url: string) => void
  onCopyPassword?: (password: string) => void
  /** The "Copied!" flashes of the link's and the password's Copy buttons. */
  copied?: boolean
  passwordCopied?: boolean
  onUpgrade?: () => void
  /** `watchLink.controlSupport` said this node's terminal cannot take typed input (a Zellij session):
   *  Control is shown disabled, with its reason. Absent / false: offered (unknown is offered too). */
  controlUnsupported?: boolean
  /** Where a controller's commands would run, for the typing warning (`controlWarningMachine`).
   *  Absent: this machine. */
  controlMachine?: string
  /** R63: on a machine with no watcher client for this node, the link works only while the terminal
   *  is open in this app — said before the owner creates it. Absent: nothing to say (or not known). */
  whileOpenNote?: string | null
  /** "now" for the end's day (tomorrow, a weekday): the caller's clock. */
  now?: number
}): React.JSX.Element {
  const s = p.state
  // The id for aria-describedby: the password's validation line.
  const invalidId = useId()
  // The title is the node's own (git-shared, hand-editable): shown as TEXT, bidi controls stripped.
  const title = stripBidiControls(p.title)
  if (s.phase === 'done') {
    const control = s.role === 'controller'
    const until = formatUntil(s.expiresAt, p.now ?? Date.now())
    return (
      <div className="confirm live-dialog" onClick={(e) => e.stopPropagation()}>
        <DialogHead title={title} onClose={p.onClose} disabled={!!s.stopping} />
        <p className="live-dialog__status">
          <span className="live-dialog__dot" aria-hidden="true" />
          {control
            ? `Anyone with this link and the password can type until ${until}.`
            : `Anyone with this link can watch until ${until}.`}
        </p>
        <div className="live-dialog__url">
          <input
            className="confirm__input"
            readOnly
            aria-label="Live link"
            value={s.url}
            onFocus={(e) => e.currentTarget.select()}
          />
          {/* Keyboard focus lands here once the link exists (D2/M3): Enter copies it. */}
          <button className="confirm__btn primary live-dialog__copy" data-autofocus="" onClick={() => p.onCopy?.(s.url)}>
            {p.copied ? 'Copied!' : 'Copy link'}
          </button>
        </div>
        {control && (
          <>
            <div className="live-dialog__url live-dialog__password">
              <PasswordField value={s.password ?? ''} readOnly />
              <button className="confirm__btn live-dialog__copy" onClick={() => p.onCopyPassword?.(s.password ?? '')}>
                {p.passwordCopied ? 'Copied!' : 'Copy password'}
              </button>
            </div>
            <p className="live-dialog__note">
              {PASSWORD_SHOWN_ONCE} {PASSWORD_SEPARATE_NOTE}
            </p>
          </>
        )}
        {s.error && (
          <p className="live-dialog__error" role="alert">
            {s.error}
          </p>
        )}
        <div className="confirm__actions live-dialog__actions">
          <button className="confirm__btn live-dialog__stop" disabled={!!s.stopping} onClick={() => p.onStop(s.linkId)}>
            Stop sharing
          </button>
          <button className="confirm__btn" onClick={p.onClose}>
            Done
          </button>
        </div>
      </div>
    )
  }
  const control = s.role === 'controller'
  const problem = control ? passwordProblemText(s.password) : null
  // Nothing nags an empty field: Create is disabled, which says enough until something is typed.
  const showProblem = s.password !== '' && problem !== null
  const roleOptions = ROLE_ORDER.map((r) => {
    const off = r === 'controller' && !!p.controlUnsupported
    return { value: r, label: ROLE_CHOICE[r].label, hint: off ? CONTROL_UNSUPPORTED_REASON : ROLE_CHOICE[r].hint, disabled: off }
  })
  // Picking Control fills a generated password when there is none yet, so the fast path is two
  // clicks; a password already there (typed, or kept from switching away and back) is left alone.
  const setRole = (role: WatchLinkRole): void =>
    p.onChange({ ...s, role, password: role === 'controller' && s.password === '' ? newControlPassword() : s.password })
  return (
    <div className="confirm live-dialog" onClick={(e) => e.stopPropagation()}>
      <DialogHead title={title} onClose={p.onClose} disabled={s.busy} />
      <div className="live-dialog__rows">
        <div className="live-dialog__row">
          <span className="live-dialog__icon" aria-hidden="true">
            <IconWeb />
          </span>
          <span className="live-dialog__row-label">Anyone with the link</span>
          {/* Keyboard focus lands here when the dialog opens (D2/M3): keys stay inside the dialog
              instead of reaching the canvas behind it. */}
          <MenuSelect
            label="Anyone with the link"
            value={s.role}
            options={roleOptions}
            onChange={setRole}
            disabled={s.busy}
            autoFocus
          />
        </div>
        {control && (
          <div className="live-dialog__row live-dialog__password">
            <span className="live-dialog__icon" aria-hidden="true">
              <IconLock />
            </span>
            <span className="live-dialog__row-label">Password</span>
            <PasswordField
              value={s.password}
              disabled={s.busy}
              describedBy={showProblem ? invalidId : undefined}
              onChange={(v) => p.onChange({ ...s, password: v })}
            />
            <button
              type="button"
              className="live-dialog__icon-btn"
              aria-label="New password"
              title="Generate a new password"
              disabled={s.busy}
              onClick={() => p.onChange({ ...s, password: newControlPassword() })}
            >
              <IconReload />
            </button>
          </div>
        )}
        {showProblem && (
          <p className="live-dialog__invalid" id={invalidId}>
            {problem}
          </p>
        )}
        <div className="live-dialog__row">
          <span className="live-dialog__icon" aria-hidden="true">
            <IconClock />
          </span>
          <span className="live-dialog__row-label">Expires</span>
          <MenuSelect
            label="Expires"
            value={s.ttl}
            options={TTL_OPTIONS}
            onChange={(ttl: WatchLinkTtl) => p.onChange({ ...s, ttl })}
            disabled={s.busy}
          />
        </div>
        <label className="live-dialog__row live-dialog__label">
          <span className="live-dialog__icon" aria-hidden="true">
            <IconUser />
          </span>
          <span className="live-dialog__row-label">Viewers see you as</span>
          <input
            className="confirm__input"
            maxLength={LABEL_MAX}
            value={s.label}
            disabled={s.busy}
            onChange={(e) => p.onChange({ ...s, label: e.target.value })}
          />
        </label>
      </div>
      {/* Typing first (the stronger claim), then what WATCHING exposes, which holds for every role:
          a Control link is watched by anyone with the link alone. */}
      {control && <ControlWarning machine={p.controlMachine ?? controlWarningMachine(null)} />}
      <p className="live-dialog__exposure">{LIVE_LINK_EXPOSURE}</p>
      {p.whileOpenNote && <p className="live-dialog__note">{p.whileOpenNote}</p>}
      {s.error && (
        <p className="live-dialog__error" role="alert">
          {s.error}
        </p>
      )}
      <div className="confirm__actions">
        {s.error && s.offerUpgrade && p.onUpgrade && (
          <button className="confirm__btn" onClick={p.onUpgrade}>
            Upgrade to Pro
          </button>
        )}
        <button className="confirm__btn" disabled={s.busy} onClick={p.onClose}>
          Cancel
        </button>
        <button
          className="confirm__btn primary"
          disabled={s.busy || !s.label.trim() || (control && (problem !== null || !!p.controlUnsupported))}
          onClick={p.onSubmit}
        >
          {s.busy ? 'Creating…' : 'Create live link'}
        </button>
      </div>
    </div>
  )
}

export function LiveLinkDialog({
  nodeId,
  title,
  surface,
  remoteNode = false,
  sshTarget,
  readPersistence,
  prepare,
  onUpgrade,
  onClose
}: {
  nodeId: string
  title: string
  /** Where it was opened — decides how `unsupported` reads (H1). */
  surface: LiveLinkSurface
  /** The node runs on an SSH project's host, whose own tmux gives a viewer a client of its own (R63). */
  remoteNode?: boolean
  /** That SSH project's server, so the Control warning names the machine a controller's commands
   *  run on (`user@host`). Absent: a local node — this machine. */
  sshTarget?: { user: string; host: string } | null
  /** R63: the LOCAL core's session-protection status (`localSession.api.pty.tmuxStatus` — the core that
   *  creates the link, never a relay peer's). Absent, rejected or unreadable: no note (unknown claims
   *  nothing). */
  readPersistence?: () => Promise<{ persistence?: { enabled: boolean; backend: string | null } | null } | null>
  /** R47: publish pending canvas edits before core looks the node up. A sentence = do NOT create. */
  prepare: () => Promise<string | null>
  /** Absent on the Server Edition (R43): no Upgrade button there. */
  onUpgrade?: () => void
  onClose: () => void
}): React.JSX.Element {
  // Opens on the role and expiry of the last link this person created (lib/liveLinkDefaults). A
  // remembered Control opens with a fresh generated password, as picking it does.
  const [state, setState] = useState<DialogState>(() => {
    const d = loadLiveLinkDefaults()
    return {
      phase: 'form',
      role: d.role,
      ttl: d.ttl,
      label: capUnits(loadIdentity()?.name ?? '', LABEL_MAX),
      password: d.role === 'controller' ? newControlPassword() : '',
      busy: false,
      error: null
    }
  })
  // The latest state for the async steps (a closure would see the render that started them).
  const stateRef = useRef(state)
  stateRef.current = state
  const isTop = useDialogStack()
  const [copied, copy] = useCopied()
  const [passwordCopied, copyPassword] = useCopied()
  // R63: does THIS machine have a watcher client for this node? Read once from the local core (the
  // core that creates the link). Unknown — not read yet, or unreadable — says nothing.
  const [whileOpenOnly, setWhileOpenOnly] = useState(false)
  useEffect(() => {
    if (!readPersistence) return
    let live = true
    Promise.resolve()
      .then(() => readPersistence())
      .then(
        (st) => {
          if (live) setWhileOpenOnly(watchableOnlyWhileOpen({ persistence: st?.persistence, remoteNode }))
        },
        () => {}
      )
    return () => {
      live = false
    }
  }, [remoteNode, readPersistence])
  // Can this node's terminal take a Control link's input? Asked ONCE, on open. Only a definite
  // 'unsupported' (a Zellij session) disables Control; 'unknown', a rejection or an api without the
  // call keep it offered — the create decides, and says why if it refuses.
  const [controlUnsupported, setControlUnsupported] = useState(false)
  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => window.nodeTerminal.watchLink.controlSupport(nodeId))
      .then(
        (answer) => {
          if (!live || answer !== 'unsupported') return
          setControlUnsupported(true)
          // Picked before the answer landed: move off it (and drop the password with it).
          setState((s) => (s.phase === 'form' && !s.busy && s.role === 'controller' ? { ...s, role: 'viewer', password: '' } : s))
        },
        () => {}
      )
    return () => {
      live = false
    }
  }, [nodeId])
  // D2/M3: focus lands in the dialog — the role menu on open, Copy link once created — so keys stay inside
  // it (a bare-key canvas command could otherwise fire behind the overlay).
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
  }, [state.phase])

  const busy = state.phase === 'form' && state.busy
  // Every dismissal goes through here: a create in flight cannot be walked away from (H24). The
  // password goes with it, before the owner hands the dialog back — never left in state behind it.
  const dismiss = useCallback(() => {
    const s = stateRef.current
    if (s.phase === 'form' && s.busy) return
    const dropped: DialogState = s.phase === 'form' ? { ...s, password: '' } : { ...s, password: undefined }
    stateRef.current = dropped
    setState(dropped)
    onClose()
  }, [onClose])

  // A Control link's done step holds the ONLY copy of its password (core keeps a hash): a stray click
  // beside the dialog must not throw it away. The scrim does nothing there until Copy password was
  // pressed; Escape and Done still close — those are deliberate.
  const passwordCopiedRef = useRef(false)
  const scrimClick = useCallback(() => {
    const s = stateRef.current
    if (s.phase === 'done' && s.role === 'controller' && !passwordCopiedRef.current) return
    dismiss()
  }, [dismiss])
  const onCopyPassword = useCallback(
    (pw: string) => {
      passwordCopiedRef.current = true
      copyPassword(pw)
    },
    [copyPassword]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isTop()) dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop, dismiss])

  const submit = async (): Promise<void> => {
    const s = stateRef.current
    if (s.phase !== 'form' || s.busy) return
    const form = { ...s, busy: true, error: null, offerUpgrade: false }
    setState(form)
    const fail = (error: string, offerUpgrade = false): void =>
      setState({ ...form, busy: false, error, offerUpgrade })
    let refused: string | null
    try {
      refused = await prepare()
    } catch {
      // `liveLinkPrepare` answers instead of throwing; a throw is still "the save did not land".
      refused = SAVE_FIRST_MESSAGE
    }
    if (refused) return fail(refused)
    const control = form.role === 'controller'
    const req: CreateWatchLinkRequest = {
      nodeId,
      role: form.role,
      ttlSeconds: form.ttl,
      label: form.label.trim(),
      title,
      // Only a Control link carries a password: a viewer or commenter request never holds one.
      ...(control ? { password: form.password } : {})
    }
    try {
      const r = await window.nodeTerminal.watchLink.create(req)
      if (r.ok) {
        saveLiveLinkDefaults({ role: form.role, ttl: form.ttl })
        setState({
          phase: 'done',
          role: form.role,
          url: r.link.url,
          linkId: r.link.linkId,
          expiresAt: r.link.expiresAt,
          ...(control ? { password: form.password } : {})
        })
      } else fail(createErrorMessage(r.error, surface), r.error === 'not-entitled')
    } catch {
      // Desktop IPC and the ws-bridge both answer instead of rejecting; this is the belt.
      fail(createErrorMessage('network', surface))
    }
  }

  const stop = async (linkId: string): Promise<void> => {
    const s = stateRef.current
    if (s.phase !== 'done' || s.stopping) return
    setState({ ...s, stopping: true, error: null })
    const ok = await stopLiveLinks(
      () => window.nodeTerminal.watchLink.revoke(linkId),
      (error) => setState({ ...s, stopping: false, error })
    )
    if (ok) onClose()
  }

  return createPortal(
    <div className="confirm-overlay" ref={panelRef} onClick={scrimClick}>
      <LiveLinkDialogBody
        title={title}
        whileOpenNote={whileOpenOnly ? watchWhileOpenNote() : null}
        state={state}
        onChange={(next) => {
          if (!busy) setState(next)
        }}
        onSubmit={() => void submit()}
        onClose={dismiss}
        onStop={(id) => void stop(id)}
        onCopy={copy}
        onCopyPassword={onCopyPassword}
        copied={copied}
        passwordCopied={passwordCopied}
        onUpgrade={onUpgrade}
        controlUnsupported={controlUnsupported}
        controlMachine={controlWarningMachine(sshTarget)}
      />
    </div>,
    document.body
  )
}
