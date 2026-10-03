import { describe, it, expect, vi } from 'vitest'
import { createCustomSfxPlayer, playAlert, TransientSfxError, type CustomSfxPlayer } from './customSfx'

type Buf = { id: string }

function player(over: Partial<Parameters<typeof createCustomSfxPlayer<Buf>>[0]> = {}) {
  const deps = {
    read: vi.fn(async (kind: string) => `b64-${kind}`),
    decode: vi.fn(async (b64: string): Promise<Buf> => ({ id: b64 })),
    play: vi.fn((_buf: Buf, _gain: number) => {}),
    ...over
  }
  return { deps, p: createCustomSfxPlayer<Buf>(deps) }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('createCustomSfxPlayer', () => {
  it('reads, decodes and plays the stored sound, and reports success', async () => {
    const { deps, p } = player()
    expect(await p.play('done', 1, 0.4)).toBe(true)
    expect(deps.read).toHaveBeenCalledWith('done')
    expect(deps.play).toHaveBeenCalledWith({ id: 'b64-done' }, 0.4)
  })

  it('decodes once per stamp and re-loads when the stamp changes (a new pick)', async () => {
    const { deps, p } = player()
    await p.play('done', 1, 0.5)
    await p.play('done', 1, 0.5)
    expect(deps.read).toHaveBeenCalledTimes(1)
    await p.play('done', 2, 0.5)
    expect(deps.read).toHaveBeenCalledTimes(2)
  })

  it('answers false — never throws — for a missing file, a decode error, or a playback error', async () => {
    const missing = player({ read: vi.fn(async () => null) })
    expect(await missing.p.play('done', 1, 0.5)).toBe(false)

    const corrupt = player({ decode: vi.fn(async () => { throw new Error('EncodingError') }) })
    expect(await corrupt.p.play('done', 1, 0.5)).toBe(false)

    const readThrows = player({ read: vi.fn(async () => { throw new Error('E_UNSUPPORTED') }) })
    expect(await readThrows.p.play('done', 1, 0.5)).toBe(false)

    const playThrows = player({ play: vi.fn(() => { throw new Error('InvalidStateError') }) })
    expect(await playThrows.p.play('done', 1, 0.5)).toBe(false)
  })

  it('does not cache a failure — the next alert retries (a dropped WS must not pin the chime)', async () => {
    let fail = true
    const { deps, p } = player({ read: vi.fn(async () => (fail ? null : 'b64')) })
    expect(await p.play('done', 1, 0.5)).toBe(false)
    fail = false
    expect(await p.play('done', 1, 0.5)).toBe(true)
    expect(deps.read).toHaveBeenCalledTimes(2)
  })

  it('caches only the trimmed copy of a decoded buffer — the full decode is not what is kept', async () => {
    const trim = vi.fn((b: Buf): Buf => ({ id: `${b.id}-first10s` }))
    const { deps, p } = player({ trim })
    await p.play('done', 1, 0.5)
    await p.play('done', 1, 0.5)
    expect(trim).toHaveBeenCalledTimes(1)
    expect(trim).toHaveBeenCalledWith({ id: 'b64-done' })
    expect(deps.play).toHaveBeenNthCalledWith(1, { id: 'b64-done-first10s' }, 0.5)
    expect(deps.play).toHaveBeenNthCalledWith(2, { id: 'b64-done-first10s' }, 0.5)
  })

  it('negative-caches a DECODE failure per stamp: later alerts neither re-read nor re-decode', async () => {
    const { deps, p } = player({ decode: vi.fn(async () => { throw new Error('EncodingError') }) })
    expect(await p.play('done', 1, 0.5)).toBe(false)
    expect(await p.play('done', 1, 0.5)).toBe(false)
    expect(await p.preload('done', 1)).toBe(false)
    expect(deps.read).toHaveBeenCalledTimes(1)
    expect(deps.decode).toHaveBeenCalledTimes(1)
    // A new pick (new stamp) is tried afresh.
    await p.play('done', 2, 0.5)
    expect(deps.read).toHaveBeenCalledTimes(2)
  })

  it('a trim that throws counts as a decode failure (negative-cached, never thrown)', async () => {
    const { deps, p } = player({ trim: vi.fn(() => { throw new Error('NotSupportedError') }) })
    expect(await p.play('done', 1, 0.5)).toBe(false)
    expect(await p.play('done', 1, 0.5)).toBe(false)
    expect(deps.read).toHaveBeenCalledTimes(1)
  })

  it('a missing/closed audio context is TRANSIENT: chime now, the next alert retries', async () => {
    let ctx = false
    const { deps, p } = player({
      decode: vi.fn(async (b64: string): Promise<Buf> => {
        if (!ctx) throw new TransientSfxError('no audio context')
        return { id: b64 }
      })
    })
    expect(await p.play('done', 1, 0.5)).toBe(false)
    ctx = true
    expect(await p.play('done', 1, 0.5)).toBe(true)
    expect(deps.read).toHaveBeenCalledTimes(2)
  })

  it('a transient error from trim is not negative-cached either', async () => {
    let fail = true
    const { deps, p } = player({
      trim: vi.fn((b: Buf) => {
        if (fail) throw new TransientSfxError('no audio context')
        return b
      })
    })
    expect(await p.play('done', 1, 0.5)).toBe(false)
    fail = false
    expect(await p.play('done', 1, 0.5)).toBe(true)
    expect(deps.read).toHaveBeenCalledTimes(2)
  })

  it('preload decodes without playing', async () => {
    const { deps, p } = player()
    expect(await p.preload('needsYou', 3)).toBe(true)
    expect(deps.play).not.toHaveBeenCalled()
    await p.play('needsYou', 3, 0.5)
    expect(deps.read).toHaveBeenCalledTimes(1)
  })
})

describe('playAlert — the fail-to-chime guarantee', () => {
  const custom = (result: Promise<boolean>): CustomSfxPlayer =>
    ({ play: vi.fn(() => result), preload: vi.fn() }) as unknown as CustomSfxPlayer

  it('plays the built-in chime synchronously when no custom sound is set', () => {
    const chime = vi.fn()
    const c = custom(Promise.resolve(true))
    playAlert('done', 0.5, {}, { chime, custom: c })
    expect(chime).toHaveBeenCalledWith('done', 0.5)
    expect(c.play).not.toHaveBeenCalled()
  })

  it('plays the custom sound instead of the chime when it loads', async () => {
    const chime = vi.fn()
    const c = custom(Promise.resolve(true))
    playAlert('needsYou', 0.8, { needsYou: { name: 'x.wav', stamp: 7 } }, { chime, custom: c })
    await flush()
    expect(c.play).toHaveBeenCalledWith('needsYou', 7, 0.8)
    expect(chime).not.toHaveBeenCalled()
  })

  it('falls back to the chime when the custom sound fails or rejects', async () => {
    const chime = vi.fn()
    playAlert('done', 0.5, { done: { name: 'x', stamp: 1 } }, { chime, custom: custom(Promise.resolve(false)) })
    playAlert('done', 0.5, { done: { name: 'x', stamp: 1 } }, { chime, custom: custom(Promise.reject(new Error('x'))) })
    await flush()
    expect(chime).toHaveBeenCalledTimes(2)
  })

  it('only the matching kind is replaced, and a malformed settings entry reads as no custom sound', () => {
    const chime = vi.fn()
    const c = custom(Promise.resolve(true))
    playAlert('done', 0.5, { needsYou: { name: 'x', stamp: 1 } }, { chime, custom: c })
    playAlert('done', 0.5, { done: { name: 'x' } } as never, { chime, custom: c })
    playAlert('done', 0.5, 'garbage' as never, { chime, custom: c })
    expect(chime).toHaveBeenCalledTimes(3)
    expect(c.play).not.toHaveBeenCalled()
  })

  it('is silent at volume 0 and clamps the volume', async () => {
    const chime = vi.fn()
    const c = custom(Promise.resolve(true))
    playAlert('done', 0, { done: { name: 'x', stamp: 1 } }, { chime, custom: c })
    playAlert('done', -3, {}, { chime, custom: c })
    expect(chime).not.toHaveBeenCalled()
    expect(c.play).not.toHaveBeenCalled()
    playAlert('done', 7, {}, { chime, custom: c })
    expect(chime).toHaveBeenCalledWith('done', 1)
  })

  it('never throws into the caller, even when the chime itself throws', async () => {
    const chime = vi.fn(() => {
      throw new Error('boom')
    })
    expect(() => playAlert('done', 0.5, {}, { chime, custom: custom(Promise.resolve(false)) })).not.toThrow()
    expect(() =>
      playAlert('done', 0.5, { done: { name: 'x', stamp: 1 } }, { chime, custom: custom(Promise.resolve(false)) })
    ).not.toThrow()
    await flush() // the async fallback's throw must not surface as an unhandled rejection
  })
})
