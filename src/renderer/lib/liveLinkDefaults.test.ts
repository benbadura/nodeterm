import { describe, expect, it } from 'vitest'
import {
  FIRST_LIVE_LINK_DEFAULTS,
  LIVE_LINK_DEFAULTS_KEY,
  loadLiveLinkDefaults,
  parseLiveLinkDefaults,
  saveLiveLinkDefaults
} from './liveLinkDefaults'

describe('liveLinkDefaults', () => {
  it('a first dialog opens on "can watch" for an hour', () => {
    expect(FIRST_LIVE_LINK_DEFAULTS).toEqual({ role: 'viewer', ttl: 3600 })
    expect(parseLiveLinkDefaults(null)).toEqual(FIRST_LIVE_LINK_DEFAULTS)
  })

  it('round-trips what was saved, under its own key, and nothing else', () => {
    const store = new Map<string, string>()
    saveLiveLinkDefaults({ role: 'controller', ttl: 0 }, (k, v) => store.set(k, v))
    expect([...store.keys()]).toEqual([LIVE_LINK_DEFAULTS_KEY])
    expect(JSON.parse(store.get(LIVE_LINK_DEFAULTS_KEY)!)).toEqual({ role: 'controller', ttl: 0 })
    expect(loadLiveLinkDefaults((k) => store.get(k) ?? null)).toEqual({ role: 'controller', ttl: 0 })
  })

  it('reads each field on its own: an unknown value falls back without costing the other', () => {
    expect(parseLiveLinkDefaults('{"role":"admin","ttl":28800}')).toEqual({ role: 'viewer', ttl: 28800 })
    expect(parseLiveLinkDefaults('{"role":"commenter","ttl":7200}')).toEqual({ role: 'commenter', ttl: 3600 })
    expect(parseLiveLinkDefaults('{"role":"controller","ttl":"0"}')).toEqual({ role: 'controller', ttl: 3600 })
    for (const raw of ['not json', '[]', 'null', '42', '"controller"']) expect(parseLiveLinkDefaults(raw)).toEqual(FIRST_LIVE_LINK_DEFAULTS)
  })

  it('storage that throws (private mode, blocked site data) never breaks the dialog', () => {
    expect(
      loadLiveLinkDefaults(() => {
        throw new Error('SecurityError')
      })
    ).toEqual(FIRST_LIVE_LINK_DEFAULTS)
    expect(() =>
      saveLiveLinkDefaults({ role: 'viewer', ttl: 3600 }, () => {
        throw new Error('QuotaExceededError')
      })
    ).not.toThrow()
  })
})
