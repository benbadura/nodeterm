import { execFileSync } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { testTmpDir } from './test-tmp'
import { assembleLaunchCommand, assembleResumeCommand } from '../shared/agents/launch'
import { deferMemoryCommand, MEMORY_PROMPT_MARKER, prepareMemoryCommand } from '../shared/memory-launch'
import { shellSingleQuote } from '../shared/shell-quote'

describe('memory at the first-launch barrier', () => {
  it('keeps an empty project launch byte-identical and does not prepare a resume', async () => {
    const original = assembleLaunchCommand({ agentId: 'codex' }, {}).command
    const contextual = assembleLaunchCommand({ agentId: 'codex', contextPrefix: MEMORY_PROMPT_MARKER }, {}).command
    const prepare = vi.fn(async () => ({ ok: true as const, value: { body: '' } }))
    expect(await prepareMemoryCommand(deferMemoryCommand('n', original, contextual), 'n', prepare)).toBe(original)
    const resume = assembleResumeCommand({ agentId: 'codex', sessionId: 'abc' }, {}).command
    expect(await prepareMemoryCommand(resume, 'n', prepare)).toBe(resume)
    expect(prepare).toHaveBeenCalledTimes(1)
  })
  it('preserves multiline prompt files as one argument and treats packet paths as literal data', async () => {
    const root = testTmpDir('memory-launch-')
    const file = path.join(root, 'brief.txt')
    const brief = 'First line\nSecond `line` with $(echo forbidden)'
    await fs.writeFile(file, brief)
    const executable = path.join(root, 'args.cjs')
    await fs.writeFile(executable, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    const input = { agentId: 'claude', launchCmdOverride: `${shellSingleQuote(process.execPath)} ${shellSingleQuote(executable)}`, promptFile: file }
    const original = assembleLaunchCommand(input, {}).command
    const contextual = assembleLaunchCommand({ ...input, contextPrefix: MEMORY_PROMPT_MARKER }, {}).command
    const packetPath = path.join(root, "a'$(touch forbidden)`quote`.md")
    const prepared = await prepareMemoryCommand(deferMemoryCommand('n', original, contextual), 'n', async () => ({ ok: true, value: { body: 'memory', filePath: packetPath } }))
    const args = JSON.parse(execFileSync('/bin/sh', ['-c', prepared], { encoding: 'utf8', cwd: root }))
    expect(args).toHaveLength(1)
    expect(args[0]).toContain(packetPath)
    expect(args[0].endsWith(brief)).toBe(true)
    await expect(fs.stat(path.join(root, 'forbidden'))).rejects.toThrow()
  })
  it('reads at delivery time, fails on corrupt memory, and rejects another node recipe', async () => {
    const recipe = deferMemoryCommand('n', 'claude', assembleLaunchCommand({ agentId: 'claude', contextPrefix: MEMORY_PROMPT_MARKER }, {}).command)
    const prepare = vi.fn(async () => ({ ok: false as const, error: 'Corrupt memory' }))
    expect(prepare).not.toHaveBeenCalled()
    await expect(prepareMemoryCommand(recipe, 'n', prepare)).rejects.toThrow('Corrupt memory')
    await expect(prepareMemoryCommand(recipe, 'other', prepare)).rejects.toThrow('Invalid')
  })
})
