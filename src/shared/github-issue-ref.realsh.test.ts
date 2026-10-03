import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assembleLaunchCommand } from './agents/launch'
import { issueLaunchPrompt } from './github-issue-ref'

// The launch line for an issue-bound session is TYPED into a pane and read by its shell. A
// structural test of the string proves nothing about what a shell does with it, so this runs the
// line the assembler actually builds under a real /bin/sh, with the agent program swapped for
// `printf` so the CLI's argv is observable, in a scratch directory where any injected command would
// leave a file behind.
describe.skipIf(process.platform === 'win32')('issue launch line under a real /bin/sh', () => {
  const run = (prompt: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-issue-sh-'))
    try {
      const { command } = assembleLaunchCommand(
        { agentId: 'claude', initialPrompt: prompt, launchCmdOverride: "printf '[%s]\\n'" },
        {}
      )
      const out = execFileSync('/bin/sh', ['-c', command], { cwd: dir, encoding: 'utf8' })
      return { out, files: fs.readdirSync(dir) }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('hands the CLI the reference prompt as exactly one argument', () => {
    const prompt = issueLaunchPrompt({ owner: 'eneskirca', repo: 'nodeterm', number: 42 })!
    const { out, files } = run(prompt)
    expect(out).toBe(`[${prompt}]\n`)
    expect(files).toEqual([])
  })

  it("keeps even a hostile caller brief inert (it rides after the reference, inside the prompt's quotes)", () => {
    const prompt = issueLaunchPrompt(
      { owner: 'o', repo: 'r', number: 1 },
      "it's $(touch PWNED) `touch PWNED2`; touch PWNED3 && rm -rf ./x"
    )!
    const { out, files } = run(prompt)
    expect(out.split('\n').filter(Boolean)).toHaveLength(1)
    expect(files).toEqual([])
  })
})
