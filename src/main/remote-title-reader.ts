import type { RemoteFileRef } from './remote-ssh/remote-file'

/** Remote session-title reader: a 128 KB tail read over ssh per poll, per remote agent node,
 *  skipped while the remote context tail reports the file has not grown (its read offset IS the
 *  file size at its last read). Unknown offset ⇒ always read. Bounded by live remote sessions:
 *  an entry goes when its session stops being remote or stops being tracked by the tail. */
export function createRemoteTitleReader(deps: {
  refFor(sessionId: string): RemoteFileRef | undefined
  offsetFor(sessionId: string): number | null
  readTail(ref: RemoteFileRef): Promise<string>
}): (sessionId: string) => Promise<{ text: string } | null> {
  const cache = new Map<string, { offset: number; path: string; text: string }>()
  return async (sessionId) => {
    const ref = deps.refFor(sessionId)
    if (!ref) {
      // Not a remote session — null is the signal for core to use the local reader.
      cache.delete(sessionId)
      return null
    }
    const offset = deps.offsetFor(sessionId)
    const hit = cache.get(sessionId)
    if (offset !== null && hit && hit.offset === offset && hit.path === ref.path) return { text: hit.text }
    const text = await deps.readTail(ref)
    if (offset !== null) cache.set(sessionId, { offset, path: ref.path, text })
    else cache.delete(sessionId)
    return { text }
  }
}
