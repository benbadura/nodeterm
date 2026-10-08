// A tiny seam so code OUTSIDE Canvas can trigger the same debounced workspace save Canvas owns.
// Canvas registers its `markDirty`; other surfaces (a canvas node editing its kanban labels) call
// `markWorkspaceDirty()`. No-op when nothing is registered (boot before Canvas mounts, tests).

let cb: (() => void) | null = null
const flushers = new WeakMap<import('@shared/types').NodeTerminalApi, () => Promise<boolean>>()

/** Explicit host actions publish the live canvas before requesting a core read/modify/write. */
export function registerWorkspaceFlush(api: import('@shared/types').NodeTerminalApi, fn: () => Promise<boolean>): () => void {
  flushers.set(api, fn)
  return () => { if (flushers.get(api) === fn) flushers.delete(api) }
}

export async function flushWorkspaceEdits(api: import('@shared/types').NodeTerminalApi): Promise<void> {
  const flush = flushers.get(api)
  if (flush && !await flush()) throw new Error('Resolve the project’s save conflict or delivery error before starting a workflow.')
}

/** Canvas calls this on mount with its markDirty; the returned fn unregisters on unmount. */
export function registerWorkspaceDirty(fn: () => void): () => void {
  cb = fn
  return () => {
    if (cb === fn) cb = null
  }
}

/** Trigger the debounced workspace save from anywhere in the renderer. */
export function markWorkspaceDirty(): void {
  cb?.()
}
