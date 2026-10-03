// The codex ⌘M reader's two shell legs are OPTIONAL deps of `registerTranscriptIpc`
// (`codexPathFor`, `readRemoteCodexPage`), so dropping either compiles and passes every unit test
// while the feature degrades in silence: without the remote leg every SSH codex node answers
// "Couldn't read the transcript."; without the hint a relocated `CODEX_HOME` finds nothing. The
// closures live in the shells, so this pins them at source level — the remedy this repo uses for
// that class of hole (host-chat-wiring.test.ts, hook-verified-parity.test.ts).
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

describe('codex chat reader is wired in both shells', () => {
  it('the desktop passes codex\'s own hint and remote leg, through the SAME resolvers as its remote meter', () => {
    const src = read('main/index.ts')
    expect(src).toMatch(/codexPathFor: \(sessionId\) => codexContextTail\.pathFor\(sessionId\)/)
    expect(src).toMatch(/readRemoteCodexPage: createReadRemoteCodexPage\(\{\n\s*targetFor: remoteCodexTargetFor,\n\s*knownAccount: knownRemoteCodexAccount,\n\s*run: runRemoteCodex,/)
    // …and the context meter reads through those very functions, so the two cannot disagree.
    expect(src).toMatch(/createRemoteCodexContext\(\{\n\s*targetFor: remoteCodexTargetFor,\n\s*knownAccount: knownRemoteCodexAccount,\n\s*run: runRemoteCodex,/)
    // One deps object serves ⌘M AND the phone's chat.page.
    expect(src).toMatch(/registerTranscriptIpc\(transcriptIpcDeps\)/)
  })
  it('the Server Edition passes codex\'s hint (it runs on the host, so it needs no remote leg)', () => {
    expect(read('server/index.ts')).toMatch(/codexPathFor: \(sessionId\) => codexContextTail\.pathFor\(sessionId\)/)
  })
})
