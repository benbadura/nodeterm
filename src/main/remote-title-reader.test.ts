import { describe, it, expect, vi } from 'vitest'
import { createRemoteTitleReader } from './remote-title-reader'

const ref = { path: '/h/.claude/projects/x/s1.jsonl', controlPath: '/cp', conn: {} } as never

describe('createRemoteTitleReader', () => {
  it('returns null for a session that is not remote', async () => {
    const r = createRemoteTitleReader({ refFor: () => undefined, offsetFor: () => null, readTail: vi.fn() })
    expect(await r('s1')).toBeNull()
  })

  it('reuses the last tail while the tail-tracked offset has not moved', async () => {
    let offset: number | null = 100
    const readTail = vi.fn().mockResolvedValue('tail-A')
    const r = createRemoteTitleReader({ refFor: () => ref, offsetFor: () => offset, readTail })
    expect(await r('s1')).toEqual({ text: 'tail-A' })
    expect(await r('s1')).toEqual({ text: 'tail-A' })
    expect(readTail).toHaveBeenCalledTimes(1)
    offset = 200
    readTail.mockResolvedValue('tail-B')
    expect(await r('s1')).toEqual({ text: 'tail-B' })
    expect(readTail).toHaveBeenCalledTimes(2)
  })

  it('always reads when the offset is unknown (tail not tracking it)', async () => {
    const readTail = vi.fn().mockResolvedValue('t')
    const r = createRemoteTitleReader({ refFor: () => ref, offsetFor: () => null, readTail })
    await r('s1'); await r('s1')
    expect(readTail).toHaveBeenCalledTimes(2)
  })
})
