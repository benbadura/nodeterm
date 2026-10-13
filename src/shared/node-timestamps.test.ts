import { describe, expect, it } from 'vitest'
import { newNodeTimestamps, nodeCreatedAt, nodeTimestamps, normalizeNodeTimestamp } from './node-timestamps'

const CREATED = Date.parse('2026-10-09T08:15:00Z')
const ACTIVE = Date.parse('2026-10-10T14:30:00Z')
const id = `term-${CREATED.toString(36)}-1`

describe('node dates', () => {
  it('recovers the creation date from every persisted node kind, including old counter ids', () => {
    for (const prefix of ['term', 'run', 'ssh', 'sticky', 'group', 'editor', 'diff', 'video', 'web', 'browser', 'files', 'dino', 'trigger']) {
      expect(nodeCreatedAt(`${prefix}-${CREATED.toString(36)}-1`)).toBe(CREATED)
      expect(nodeCreatedAt(`${prefix}-${CREATED.toString(36)}-a1b2c3d4`)).toBe(CREATED)
    }
  })

  it('does not invent dates or activity for arbitrary legacy ids', () => {
    for (const id of ['term-1', 'term-abc-1', 'term-not-a-date', 'project-' + CREATED.toString(36) + '-1', 'custom']) {
      expect(nodeTimestamps({ id })).toEqual({})
    }
    expect(nodeTimestamps({ id })).toEqual({ createdAt: CREATED })
  })

  it('keeps explicit dates on reopen and initializes both dates for a fresh node', () => {
    expect(nodeTimestamps({ id, createdAt: CREATED - 1000, lastActivityAt: ACTIVE }))
      .toEqual({ createdAt: CREATED - 1000, lastActivityAt: ACTIVE })
    expect(newNodeTimestamps(ACTIVE)).toEqual({ createdAt: ACTIVE, lastActivityAt: ACTIVE })
  })

  it('rejects malformed dates from shared files without throwing', () => {
    for (const bad of [NaN, Infinity, -1, 0, 1.5, '2026-10-10', {}, null, 8_640_000_000_000_001]) {
      expect(normalizeNodeTimestamp(bad)).toBeUndefined()
      expect(nodeTimestamps({ id, createdAt: bad, lastActivityAt: bad } as never)).toEqual({ createdAt: CREATED })
    }
  })
})
