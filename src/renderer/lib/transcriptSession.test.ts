import { describe, expect, it } from 'vitest'
import { transcriptSessionFor } from './transcriptSession'

const LIVE = '11111111-1111-4111-8111-111111111111'
const MINTED = '22222222-2222-4222-8222-222222222222'

describe('transcriptSessionFor', () => {
  it('prefers the hook-confirmed id and keeps the cwd', () => {
    expect(transcriptSessionFor({ live: LIVE, persisted: MINTED, cwd: '/w' })).toEqual({
      sessionId: LIVE,
      fallback: false,
      cwd: '/w'
    })
  })

  it('falls back to the persisted launch id when no hook ever named one', () => {
    expect(transcriptSessionFor({ live: undefined, persisted: MINTED, cwd: '/w' })).toEqual({
      sessionId: MINTED,
      fallback: true,
      // strictly by id: claude's cwd-newest fallback must not answer for a stale launch id
      cwd: undefined
    })
    expect(transcriptSessionFor({ live: null, persisted: ` ${MINTED} `, cwd: '/w' }).sessionId).toBe(MINTED)
    expect(transcriptSessionFor({ live: '', persisted: MINTED, cwd: '/w' }).fallback).toBe(true)
  })

  it('refuses a persisted id that is not a safe session id (hand-edited project.json)', () => {
    for (const bad of ['-rf', '../x', 'a b', '$(id)', '', '   ', 42, {}, null, 'x'.repeat(300)]) {
      expect(transcriptSessionFor({ live: undefined, persisted: bad, cwd: '/w' })).toEqual({
        sessionId: undefined,
        fallback: false,
        cwd: '/w'
      })
    }
  })

  it('has nothing to offer when neither id is known', () => {
    expect(transcriptSessionFor({ live: undefined, persisted: undefined, cwd: undefined })).toEqual({
      sessionId: undefined,
      fallback: false,
      cwd: undefined
    })
  })
})
