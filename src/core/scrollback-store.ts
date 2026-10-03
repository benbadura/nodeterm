import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { renameAtomic, tempNameFor } from './fs-atomic'
import { platform } from './platform'

// On a machine reboot the tmux server dies, so the live scrollback is lost. We persist a
// byte-capped snapshot of each terminal's recent output to disk while it's running and replay
// it into xterm on a cold restart, so the user sees where they left off (a cold
// restore). Warm reattach (app restart, tmux alive) ignores the snapshot — tmux redraws.

const DIR_NAME = 'terminal-scrollback'
// Trailing bytes we keep / replay. Enough for a few screens of context without bloating disk
// or stalling the renderer on replay.
const MAX_BYTES = 256 * 1024

function dir(): string {
  return path.join(platform().userDataDir, DIR_NAME)
}

// persistKey is a node id (uuid-ish) but may contain arbitrary characters; hash it to a safe,
// fixed-length filename.
function snapshotPath(persistKey: string): string {
  const hash = createHash('sha256').update(persistKey).digest('hex').slice(0, 32)
  return path.join(dir(), `${hash}.bin`)
}

/** Keep only the trailing `MAX_BYTES`, not splitting a UTF-8 sequence at the cut point. */
function trailing(data: string): Buffer {
  const bytes = Buffer.from(data, 'utf-8')
  if (bytes.length <= MAX_BYTES) return bytes
  let start = bytes.length - MAX_BYTES
  // advance past any continuation bytes (0b10xxxxxx) so we start on a code-point boundary
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return bytes.subarray(start)
}

// All async (fs.promises): snapshots fire per session on a 15s timer and in bursts when many
// nodes detach at once (project switch / quit) — sync writes here blocked the main event loop,
// which stalls PTY streaming and all IPC.
/** Never throws. Resolves true only when the snapshot actually landed on disk — a caller that
 *  remembers what it wrote (pty-manager's digest skip) must not remember a failed write. */
export async function writeScrollback(persistKey: string, data: string): Promise<boolean> {
  if (!data) return false
  const file = snapshotPath(persistKey)
  // Unique tmp per call: overlapping writes for the same key (timer tick + detach snapshot)
  // must not interleave into one tmp file and rename a torn write into place.
  const tmp = tempNameFor(file)
  try {
    await fs.promises.mkdir(dir(), { recursive: true })
    await fs.promises.writeFile(tmp, trailing(data))
    await renameAtomic(tmp, file)
    return true
  } catch {
    // best-effort: a failed snapshot just means no cold-restore replay for this node
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
    return false
  }
}

export async function readScrollback(persistKey: string): Promise<string> {
  try {
    return await fs.promises.readFile(snapshotPath(persistKey), 'utf-8')
  } catch {
    return ''
  }
}

export async function deleteScrollback(persistKey: string): Promise<void> {
  try {
    await fs.promises.rm(snapshotPath(persistKey), { force: true })
  } catch {
    // ignore
  }
}
