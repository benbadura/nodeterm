/**
 * Issue #346 — a `nodeterm:*` CustomEvent dispatched with nothing listening for it.
 *
 * "Add Codex account" dispatched `nodeterm:add-codex-account-login` to open the device-login node,
 * then awaited `codexAccounts.waitLogin` for the `auth.json` that node's `codex login` would write.
 * No listener was ever registered, so no node opened, nothing wrote the credential, and the add
 * flow waited out its five-minute timeout. Nothing could see it: the dispatch compiles, typechecks
 * and runs — a CustomEvent with no listener is a silent no-op by design.
 *
 * So the guard is the pairing itself, for every event rather than that one: these are the app's
 * only fire-and-forget channel between the Settings overlay and the canvas, and each new one is a
 * fresh chance to wire just one end. Names are read from source because the sender and the
 * receiver never share a symbol — that string literal IS the coupling.
 *
 * MUTATION: delete the `nodeterm:add-codex-account-login` listener in Canvas.tsx → red, naming the
 * event. (Deleting a DISPATCH is not a failure: a listener with no sender is inert, and one exists
 * for events the desktop shell fires from outside this tree.)
 */
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const RENDERER = path.join(__dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

function names(re: RegExp): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of walk(RENDERER)) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(re)) {
      const name = m[1]
      found.set(name, [...(found.get(name) ?? []), path.relative(RENDERER, file)])
    }
  }
  return found
}

describe('every nodeterm CustomEvent the renderer dispatches has a listener', () => {
  const dispatched = names(/new CustomEvent\(\s*['"](nodeterm:[a-z-]+)['"]/g)
  const listened = names(/addEventListener\(\s*['"](nodeterm:[a-z-]+)['"]/g)

  it('finds the channel at all — a regex that matches nothing would pass vacuously', () => {
    expect(dispatched.size).toBeGreaterThan(5)
    expect(listened.size).toBeGreaterThan(5)
  })

  it('has no dispatch without a listener', () => {
    const orphans = [...dispatched.entries()]
      .filter(([name]) => !listened.has(name))
      .map(([name, files]) => `${name} (dispatched in ${files.join(', ')})`)
    expect(orphans).toEqual([])
  })
})

// The LIVE chip's "Open chat" (LiveLinkPopover) asks for the Live chat drawer. Task 7 wired a stub
// listener that opened nothing; the drawer's listener REPLACES it — two listeners would open the
// drawer twice, a stub alone opens nothing.
describe('nodeterm:live-chat', () => {
  const listened = names(/addEventListener\(\s*['"](nodeterm:live-chat)['"]/g)

  it('has exactly one listener, in Canvas', () => {
    expect((listened.get('nodeterm:live-chat') ?? []).map((f) => f.split(path.sep).join('/'))).toEqual(['canvas/Canvas.tsx'])
  })

  it('that listener opens the drawer on the link it names', () => {
    const src = fs.readFileSync(path.join(RENDERER, 'canvas/Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
    const at = src.indexOf("window.addEventListener('nodeterm:live-chat'")
    const effect = src.slice(src.lastIndexOf('useEffect(', at), at)
    expect(effect).toContain("nextLiveChat(s, { kind: 'open', linkId })")
    expect(effect).toContain('writeLiveChatLink(linkId)')
  })
})
