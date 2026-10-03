// The desktop shell must INJECT grok's remote chat leg — and no type can make it.
//
// `TranscriptIpcDeps.readRemoteGrok` is optional (the Server Edition has no SSH projects and passes
// none), so a `transcriptIpcDeps` literal that forgets it is perfectly well-typed. The failure would
// be silent in the one way that matters: every remote grok node's ⌘M panel AND the phone's Chat
// screen (host-chat reads through the same deps object) would answer `unreadable` forever, with a
// green suite behind it. Same class of hole `hook-verified-parity.test.ts` and
// `codex-identity-record-wiring.test.ts` pin at source level; same remedy.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')

/** The `transcriptIpcDeps` object literal, from its declaration to the registration after it. */
function depsLiteral(): string {
  const start = source.indexOf('const transcriptIpcDeps: TranscriptIpcDeps = {')
  expect(start, 'transcriptIpcDeps is not declared — this guard is looking at the wrong file').toBeGreaterThan(-1)
  const end = source.indexOf('registerTranscriptIpc(transcriptIpcDeps)', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('the desktop shell wires the remote grok chat read', () => {
  it('injects readRemoteGrok into the deps both ⌘M and the phone read through', () => {
    const deps = depsLiteral()
    expect(deps).toMatch(/\n\s+readRemoteGrok:\s*createReadRemoteGrokChat\(/)
  })

  it('resolves remoteness from the shell\'s records and the project master, not a live pty alone', () => {
    const deps = depsLiteral()
    const at = deps.search(/\n\s+readRemoteGrok:/)
    expect(at).toBeGreaterThan(-1)
    const leg = deps.slice(at)
    // An idle tab, or any node after a restart, has no attached pty: resolving through the pty
    // alone would read such a node as "not remote" and send it to THIS machine's disk.
    expect(leg).toMatch(/isRemote:\s*isRemoteTranscriptNode/)
    expect(leg).toMatch(/target:\s*sshTargetForNode/)
  })

  it('the phone\'s chat.page reads through the SAME deps object', () => {
    expect(source).toMatch(/readTranscript:\s*\(q, rawPage\) => readChatTranscript\(q, rawPage, transcriptIpcDeps\)/)
  })
})
