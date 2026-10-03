// Source pins for the custom-alert-sound wiring (issue #289). The agent-status listener lives in a
// Canvas.tsx `useEffect` no harness can dispatch at (see fanout-chime.test.ts), and the fallback
// logic itself is behaviourally tested in customSfx.test.ts — what only the source can show is that
// every caller hands the user's custom sounds to playSfx. A caller that forgets compiles fine
// (the argument is optional) and silently plays the chime forever.

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')

describe('custom alert sound wiring', () => {
  it('the agent-status alert passes settings.customAlertSounds to playSfx', () => {
    const src = read('../canvas/Canvas.tsx')
    const start = src.indexOf('const alert = (')
    const end = src.indexOf('const an = useAgentNodes.getState()', start)
    const body = src.slice(start, end)
    expect(body).toContain('playSfx(sound, snd.soundVolume, snd.customAlertSounds)')
  })

  it('every playSfx call in Settings → Notifications passes the custom sounds too', () => {
    const src = read('../components/settings/sections/NotificationsSection.tsx')
    // To end of line, not to the first `)`: an argument may itself be a call.
    const calls = [...src.matchAll(/playSfx\(([^\n]*)/g)].map((m) => m[1])
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) expect(args).toMatch(/customAlertSounds/)
  })

  it('the settings default carries an empty custom-sound map (an update changes nothing)', () => {
    const src = read('../../shared/types.ts')
    expect(src).toMatch(/customAlertSounds: \{\},/)
  })

  it('the Settings picker stores bytes through files.saveAlertSound, never a path', () => {
    const src = read('../components/settings/sections/NotificationsSection.tsx')
    expect(src).toContain('files.saveAlertSound(')
    expect(src).toContain('files.clearAlertSound(')
    expect(src).not.toMatch(/readBinary|selectFile|\.path\b/)
  })
})
