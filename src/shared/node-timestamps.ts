export interface NodeTimestamps {
  /** Unix milliseconds. Absent when an older node's creation time cannot be recovered. */
  createdAt?: number
  /** Last interaction, content change, terminal output or agent event, in Unix milliseconds. */
  lastActivityAt?: number
}

/** Shared project files may contain invalid values; only admit dates JavaScript can render. */
export function normalizeNodeTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000
    ? value
    : undefined
}

/** Renderer/server ids carry the creation clock, including ids with the older counter suffix. */
export function nodeCreatedAt(id: string): number | undefined {
  const match = /^(?:term|run|ssh|sticky|group|editor|diff|video|web|browser|files|dino|trigger)-([a-z0-9]+)-[a-z0-9]{1,16}$/.exec(id)
  const at = match ? normalizeNodeTimestamp(Number.parseInt(match[1], 36)) : undefined
  // Short arbitrary ids must not become plausible-looking dates in 1970.
  return at !== undefined && at >= 946_684_800_000 ? at : undefined
}

export function nodeTimestamps(node: NodeTimestamps & { id: string }): NodeTimestamps {
  const createdAt = normalizeNodeTimestamp(node.createdAt) ?? nodeCreatedAt(node.id)
  const lastActivityAt = normalizeNodeTimestamp(node.lastActivityAt)
  return {
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {})
  }
}

export function newNodeTimestamps(now = Date.now()): Required<NodeTimestamps> {
  return { createdAt: now, lastActivityAt: now }
}
