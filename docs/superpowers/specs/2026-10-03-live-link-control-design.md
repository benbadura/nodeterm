# Live links: Control role, unlimited lifetime, and a live chat drawer

Status: approved in conversation 2026-10-03, written for review.
Builds on `docs/superpowers/specs/2026-09-28-live-share-link-design.md` (the live link spec, called
"the base spec" below) and `docs/live-links.md`. Everything the base spec says still holds unless a
section below changes it by name.

## 1. What the owner asked for

enes, in his words: a view-only link "makes no sense when you cannot do work through it". He wants to
hand a terminal to someone ("here, do it from here"), protected by a password if needed, and to be able
to leave while they work. Two additions in the same round: a link that does not expire, and a
right-side drawer in the desktop app to follow and answer the live chat.

Decisions taken with him:

| # | Decision | Answer |
|---|---|---|
| C1 | How typing is unlocked | **A password.** Link + password = may type. No per-person approval: the owner may not be at the machine. |
| C2 | How many may type at once | **Everyone who unlocked**, at the same time. Each one names themselves; the owner and every viewer see who is typing. Names are self-chosen claims, shown as such. |
| C3 | Lifetime | A new **Unlimited** choice beside 15 min / 1 h / 8 h / 24 h: the link lives until the owner stops it. |
| C4 | Following the chat | A **Live chat drawer** on the right of the desktop app (the Explorer / Source Control drawer shape, pinnable), opened from the LIVE chip. |

This revises base-spec **D1** ("No request control: control means joining a team with an invite
code, a SAS and the Editor role"). Team Access stays the way to give a teammate the app; the Control
role is the way to hand over ONE terminal through a browser.

## 2. The Control role

### 2.1 Roles

`WatchLinkRole` becomes `'viewer' | 'commenter' | 'controller'` (UI: Viewer / Commenter / Control).
A Control link is a Commenter link plus typing for those who unlock it. Until a person unlocks, they
are a commenter: they watch and may chat.

### 2.2 The password

- **Required** for a Control link. The create dialog offers a field and a **Generate** button (a random
  password of 16 characters from a 32-letter alphabet with no lookalikes, about 80 bits). A typed
  password must be 8 to 128 characters.
- **Shown once**, in the "done" step, with a copy button, beside the link. It is **never part of the
  URL** (the link and the password should travel separately, and the dialog says so).
- **Stored as a hash only** in the link record on the owner's machine: scrypt (N = 2^15, r = 8, p = 1,
  16-byte random salt, 32-byte key). The plaintext is not kept anywhere, so there is no "show again";
  **Change password** sets a new one.
- **Never leaves the E2E tunnel**: the viewer sends it inside the encrypted relay session, so the relay
  and the backend never see it. The backend learns nothing new (§4).

### 2.3 Unlocking

- New cast `watch:unlock` `{ name, password }`. The host answers that viewer only (never a broadcast)
  with the event `watch:control` `{ state, reason? }`:
  - `state` is `controlling`, `available` (a Control link this viewer may unlock), `off` or `locked`;
  - `reason` (after a refused unlock) is `wrong`, `locked`, `off`, `too-soon` or `unsupported`.

  The viewer client has casts and events, no request/response, so this keeps it so. The same event
  tells a viewer when control is turned off or locked under it, and its initial state rides `watch:meta`
  (`control`). A cast `watch:release` drops the sender back to watching.
- `name` passes `sanitizeChatName` (the chat name rule). `password` is a string ≤ 128 characters,
  compared in constant time against the stored hash. It is never logged, never echoed and never kept
  after the comparison.
- **Throttling, all host-side:**
  - one attempt per 2 s per viewer;
  - 3 wrong attempts end that viewer's session (it may reconnect through the link);
  - **10 wrong attempts across the link lock control** for the link (persisted). The link keeps working
    as a Commenter link, and the owner is notified. Only the owner clears the lock (**Allow control
    again**), which also resets the count.
- A successful unlock marks that viewer **controlling** until it disconnects, is kicked, or the owner
  turns control off. Reconnecting means unlocking again.
- The owner gets a desktop notification "*name* took control of *node title*" (the existing
  notification consent and focus rules), on every successful unlock.

### 2.4 Typing

- New cast `watch:input` `{ data }`, `data` a string of ≤ 16 KB.
- **Refused unless the sending viewer is controlling and control is on.** A refusal is a policy
  breach, like any other unexpected cast.
- **Emulator answers are dropped**: the viewer's xterm answers terminal queries (DA, CPR, OSC colour)
  by itself, and those answers are not typing. `isTerminalReport` (`core/terminal-reports.ts`) is the
  filter. Without it every connected controller would answer every query again into the pane.
- **Rate:** a token bucket per viewer, 64 KB/s, 256 KB burst. Over budget is dropped and the viewer is
  told, at most once per 10 s, with `watch:control {controlling, dropped}`. The same notice covers a
  delivery to the pane that failed (an SSH host without tmux, a session that ended), so the page's
  copy names no cause: "Some of your input didn't reach the terminal."
- **Delivered to the PANE, never through a tmux client's key table.** This is the security boundary of
  the role.
  - **Why.** Typed into a tmux client (the owner's, or a watcher client), the tmux prefix reaches
    tmux. `C-b s` is the session chooser over EVERY session on the socket, `C-b (` switches to the
    next one, `C-b :` opens tmux's command prompt (`run-shell`, `kill-server`). A controller would
    reach every terminal on the machine, not one.
  - **Requirement.** Arbitrary bytes (UTF-8, escape sequences, bracketed-paste frames) reach the
    node's pane exactly. No key binding and no client is involved. The owner's own client keeps
    working.
  - **Built** (the first task measured it on tmux 3.4 and 3.7b; `docs/live-links.md` has the table).
    Keys and pastes travel apart. Keys go as `tmux source-file -` with the command text on stdin: a
    mode cancel (`copy-mode -q` when the pane is in a mode), then `send-keys -t =nt-<id>: -H <hex>`
    lines, so every byte reaches the pane as itself. A paste goes as `load-buffer -b <unique> -` from
    stdin, the same mode cancel, then `paste-buffer -d -p -r -b <unique> -t =nt-<id>:`: **with `-p`**,
    so tmux frames it only when the pane's application asked for bracketed paste. The spec's first
    candidate, `paste-buffer` for everything, fails on tmux 3.7, which vis(3)-encodes control bytes
    in a paste buffer (an arrow key arrives as the text `^[[A`, Ctrl-C as `^C`). The viewer frames
    every paste itself and the host splits keys from pastes on those frames (§5). Input is batched
    over ~20 ms. Local through the app's tmux; SSH over the project's ControlMaster, stdin piped
    (never argv).
  - **The plan's first task measures it on real tmux** before anything is built on it: bytes arrive
    exactly, `C-b s` typed by a controller does NOT open the chooser, copy mode, latency (local, and
    over a 50 ms RTT ssh), and a burst. If the candidate fails, the plan picks another that meets the
    requirement and records why.
- **Backends.**
  - **tmux, local and SSH:** supported, by pane delivery.
  - **Windows session host, a direct Windows pane and the plain-shell fallback:** supported. There is
    no multiplexer key table there. Keys go through PtyManager's ordinary write. A paste goes through
    the session host's (or the pane's) no-Enter text path, which frames it only when the
    application asked; a plain shell gets it unframed.
  - **Zellij:** control is **refused**. Its keybindings are session-wide (unlock on Ctrl-Alt-g), and
    there is no pane delivery that bypasses them. A Control link on a Zellij node behaves as a
    Commenter link, and both the dialog and the viewer say why.
- **Never sent:** resize, mouse events, flow control. The terminal keeps the owner's size. The viewer
  page keeps swallowing mouse-tracking modes, so selection and wheel scrolling stay local to the
  viewer.

### 2.5 Who is typing

- The host tracks each controlling viewer's last input time.
- **Event to every joined viewer:** `watch:typing` `{ names: string[] }`, the names that typed in the
  last 4 s, sent when the set changes (at most once a second).
- **The owner** gets the same set in the link's runtime view (chip, popover, drawer).

### 2.6 The owner's controls

- Per link:
  - **Turn control off / on** (persisted; off = every controller drops back to watching and unlock
    answers `off`).
  - **Change password.**
  - **Allow control again** (only while locked).
- Per viewer: **Kick** (exists).
- **Stop** ends everything (exists).
- The chip reads `LIVE · 3 · 1 typing` when someone is typing, and its tooltip names who.

### 2.7 The dialog

- Role radio: Viewer / Commenter / **Control**.
- For Control, the password field and Generate appear, and the warning reads:

  > Anyone with this link **and** the password can type in this terminal as you. In a shell that means
  > running any command on this machine; in an agent session, giving the agent any instruction. Send
  > the password separately from the link.

- On a Zellij node the Control option is disabled, with its reason.

### 2.8 What the role does not change

Base-spec invariants that stay:

- `watchLink:*` is host-only.
- A watcher never goes through `decideAccess`.
- Watchers are quiet and self-paced.
- The stream filter and keyframes are unchanged.
- A viewer sizes nothing.
- Node-gone is tri-state.
- No canvas-control verb touches links.

The watcher policy gains exactly three inbound entries, all casts and all for a Control link only:
`watch:unlock`, `watch:input` and `watch:release`. Whether a given viewer is *controlling* is the link host's
per-connection state; the policy only knows the role.

## 3. Unlimited lifetime

- The TTL choice gains **Unlimited** (wire value `ttlSeconds: 0`). The link has no expiry
  (`expiresAt: null`) and lives until Stop, Stop all, a backend 410, or node-gone.
- **Backend (nodeterm-server):**
  - A migration makes `watch_links.expires_at` nullable.
  - `linkState` treats null as live.
  - The active-links count counts null as live.
  - The purge never deletes a null row (`expires_at < x` is already false for NULL; a test pins it).
  - `ttlSeconds: 0` is granted only when no `WATCH_LINK_MAX_TTL_SECONDS` cap is configured. With a cap
    it is clamped to the largest allowed length, like any over-cap request. The response carries
    `expiresAt: null`.
- **Pro lapse.** An unlimited link must not outlive the owner's Pro by more than a day. The host mints a
  fresh host token through the backend for every listener, and the mint requires a valid entitlement
  token. That alone is not enough: an entitlement token lives 7 days, so a lapsed owner could keep an
  unlimited link reachable for up to a week. So the host-token mint for an **unlimited** link also asks
  the license's liveness (the create route's `licenseLiveness`) at most once per 24 h per license,
  cached in memory:
  - `dead` answers 402 `not_entitled`, and the host stops listening.
  - `unknown` (keygen unreachable) allows the mint: an outage must not take a paying user's link down.
    The cost is that a lapse during an outage is noticed at the next check.
  - Finite links keep the rule that a host-token mint never calls keygen.
- **Desktop:**
  - `WatchLinkRecord.expiresAt: number | null`; the store sanitizer accepts null.
  - No expiry timer for null.
  - The UI says "No end time" where it says "ends in …".
  - The 5-links-per-machine cap is unchanged.
- **Viewer page:** `meta.expiresAt: null` shows no "ends in" (`remaining()` already answers '' for a
  non-number). The protocol type becomes `number | null`, so the web repo re-vendors.
- **Dialog:** when Unlimited is picked: "This link works until you stop it."

## 4. Live chat drawer (desktop owner)

- **Shape.** A right-side drawer, **Live chat**, using the existing `.drawer` shape and the same pin
  behaviour as Explorer: pinned, it is docked and does not block the canvas.
- **Opened from:**
  - the LIVE chip popover (**Open chat**),
  - the card modal's LIVE popover,
  - the palette ("Live chat").
- **Contents:**
  - **Link picker** at the top when more than one link is live: node title and role. It remembers the
    last one.
  - **Messages** in the viewer page's live-chat style (time, name, text, a Sharer badge on the owner's
    own lines). The list stays at the newest message unless scrolled up, with the same "N new messages"
    pill.
  - **Composer:** posts as the sharer (`postSharerChat`, exists).
  - **People:**
    - each connected viewer, with name if known, watching or controlling, a typing dot, and Kick;
    - for a Control link, the control switch, Change password and Allow control again.
  - A Viewer link has no chat, so the drawer shows only People for it.
- **Unread.** While the drawer is closed, a new viewer message raises an unread count on that link's
  LIVE chip. Opening the drawer on that link clears it.
- **No OS notification per chat message;** control taken is the one that notifies (§2.3).
- **Kanban:** the card modal's chip opens the same drawer; it sits above the board like the pinned
  Explorer.

## 5. Viewer page (nodeterm-web)

- **Control link:**
  - A **Take control** button in the header (or chat column). It opens a small form: name, prefilled
    from the chat name, and password.
  - On `ok` the terminal accepts the keyboard: stdin is enabled, the keyboard opens on phones, and
    `onData` → `watch:input`, batched per animation frame.
  - The header shows "You can type" and a **Release** button that stops sending input.
  - Errors say what happened: wrong password, too many attempts (locked), control is off, try again in
    a moment.
- **Paste:** while typing, the page handles every paste itself. It keeps bracketed paste on in its
  own xterm whatever the stream says (the tmux client's `?2004h` is constant, so the page's mode says
  nothing about the application in the pane), removes the paste markers and every ESC from the text,
  and frames it. The host splits keys from pastes on those frames and delivers the paste with
  `paste-buffer -p`, so the pane gets brackets only when its application asked for them (§2.4).
  An emulator's answer to a query travels as a cast of its own, which the host drops whole.
- **Mouse tracking stays swallowed:** no mouse input is sent, and selection stays local.
- **Typing indicator:** "Mert is typing…" under the terminal header, from `watch:typing`.
- **No change for Viewer and Commenter links.**
- The vendored protocol (`src/lib/watch-link/`) is re-vendored from the desktop.

## 6. Threat model, stated

- **What a leak costs.** A Control link plus its password is a remote shell as the owner, for one
  terminal, for as long as the link lives, which with Unlimited is until Stop. The dialog says so. The
  password is the second factor: the link alone grants watching and chat.
- **Brute force** needs the link first, then runs host-side throttles: 1 attempt per 2 s per viewer,
  3 per connection, 10 per link before the lock.
- **Named controllers are not authenticated.** A name is a claim, like a chat name. Everyone who
  unlocked holds the same password. Accountability is "who was connected and typing, by their own
  word", not identity.
- **What stays out of reach** (host-enforced):
  - the canvas, other terminals, other sessions (pane delivery, §2.4), files and git;
  - resizing, the owner's IPC (`watchLink:*`), and every other relay verb.
- **What the role does NOT protect against:**
  - anything a shell can do: `cd` anywhere, `tmux attach -t <other>` typed as a command (a shell
    command, not a key binding: the shell is the owner's user, so this is exactly the access the
    warning names);
  - an agent's tools.

## 7. Surfaces

- **Desktop:** full.
- **Server Edition:** links stay `unsupported` there (no license layer). Unchanged.
- **Mobile:** opening a link in Safari works, including Take control (keyboard on a phone). Creating
  links from the phone is still the iOS follow-up.
- **Kanban:** chip and drawer as above.
- **Relay tabs:** refused, as today.

## 8. Repos and order

1. **nodeterm-server:** the nullable `expires_at` migration and `ttlSeconds: 0`. Deploy first. An old
   desktop never sends 0, and an old backend refuses 0 with `bad_ttl`, which the new desktop shows as
   "Unlimited links need a newer server".
2. **nodeterm (desktop + core):**
   - the role, unlock, input, typing;
   - the password hash in the record, the lock;
   - the unlimited record, the drawer, the dialog;
   - the docs (`docs/live-links.md`, CLAUDE.md "Live links").
3. **nodeterm-web:** re-vendor, Take control, typing indicator, null expiry.

## 9. How it is checked

- **Unit tests:**
  - the policy (unlock / input admitted only for Control, refused for every other role);
  - throttles and the lock (including persistence);
  - the scrypt hash and constant-time check;
  - `isTerminalReport` dropping;
  - the rate bucket;
  - the typing set;
  - the unlimited record and the store sanitizer;
  - the backend migration and grant rules.
- **Real tmux test** (the pane-delivery spike kept as a permanent test): bytes arrive exactly, and the
  prefix plus `s` does not open the chooser.
- **Integration:** a real browser client against the real relay host. It unlocks, types, and is
  refused before unlocking and after control is turned off.
- **Mutation checks:** each security refusal above broken on purpose, and a test goes red.
- **Device checklist additions** in `docs/live-links.md`:
  - Mac and Windows: take control from a second machine and type in a shell and in a Claude session;
  - paste, arrows, Ctrl-C;
  - `C-b s` does nothing;
  - lock after 10 wrong passwords;
  - an unlimited link survives an app restart and stops when Pro lapses;
  - the drawer on the canvas and over the board;
  - a phone taking control.
