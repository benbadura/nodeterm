// When an automatic launch may skip the pane probe. Shared because the renderer's mounted launch
// writer (terminal/launch-command.ts) and core's headless launcher (#925) must apply ONE rule.

/**
 * May an AUTOMATIC launch skip the pane probe and trust that a shell owns the pane? Only for a
 * fresh session whose probe is either unneeded or unreliable:
 * - a plain shell (`persistent:false`) — the pty IS the shell we just spawned;
 * - a session-host session — its probe is a process-tree walk that reads a prompt helper (a `git`
 *   or `starship` child) as "not a shell", which stalled every fresh Windows launch (#916).
 * A fresh TMUX pane is still probed: tmux answers exactly, and the probe covers the
 * `new-session -A` race where another client created (and may already be running in) the session.
 * `persistent` absent = an older core, treated as tmux, like everywhere else.
 */
export function trustsFreshShell(opts: {
  manual: boolean
  fresh: boolean
  persistent?: boolean
  sessionHost?: boolean
}): boolean {
  if (opts.manual || !opts.fresh) return false
  return opts.persistent === false || opts.sessionHost === true
}
