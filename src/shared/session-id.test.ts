// ONE definition of the safe session-id alphabet. It used to be re-typed at three sites (config.ts,
// agent-launch.ts, agent-identity-seed.ts) with two different bounds; a guard keeps a fourth copy
// from appearing.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SAFE_SESSION_ID, SAFE_SESSION_ID_UNBOUNDED, SESSION_ID_MAX } from './session-id'

describe('shared session-id alphabet', () => {
  it('accepts uuid-like ids and refuses flags, metacharacters and empties', () => {
    for (const re of [SAFE_SESSION_ID, SAFE_SESSION_ID_UNBOUNDED]) {
      expect(re.test('0f3e-aa.b_c')).toBe(true)
      expect(re.test('-flag')).toBe(false)
      expect(re.test('.x')).toBe(false)
      expect(re.test('a b')).toBe(false)
      expect(re.test('$(x)')).toBe(false)
      expect(re.test('')).toBe(false)
    }
  })

  it('the bounded form stops at SESSION_ID_MAX; the unbounded one does not', () => {
    expect(SESSION_ID_MAX).toBe(256)
    expect(SAFE_SESSION_ID.test('a'.repeat(256))).toBe(true)
    expect(SAFE_SESSION_ID.test('a'.repeat(257))).toBe(false)
    expect(SAFE_SESSION_ID_UNBOUNDED.test('a'.repeat(257))).toBe(true)
  })

  it('no site re-types its own copy', () => {
    for (const f of ['shared/agents/config.ts', 'core/agent-launch.ts', 'shared/agent-identity-seed.ts']) {
      const src = readFileSync(resolve(__dirname, '..', f), 'utf8')
      expect(src, f).not.toMatch(/SAFE_SESSION_ID\s*=\s*\//)
      expect(src, f).toMatch(/from ['"][./]*(shared\/)?session-id['"]/)
    }
  })
})
