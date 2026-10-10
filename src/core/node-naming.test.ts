import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../shared/types'
import type { NodeNamingContext } from '../shared/node-naming'

const fake = vi.hoisted(() => ({ output: '"Release Checklist."\nExtra explanation', code: 0,
  prompts: [] as string[], env: undefined as NodeJS.ProcessEnv | undefined, calls: 0 }))

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, spawn: (_bin: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    fake.calls++
    fake.env = options.env
    return {
      stdout: { on: (_event: string, cb: (data: Buffer) => void) => cb(Buffer.from(fake.output)) },
      stderr: { on: () => {} },
      stdin: { write: (prompt: string) => fake.prompts.push(prompt), end: () => {}, on: () => {} },
      kill: () => {},
      on: (event: string, cb: (code: number) => void) => {
        if (event === 'close') queueMicrotask(() => cb(fake.code))
      }
    }
  } }
})

import { generateNodeName } from './commit-message'

const settings = { commitAgent: 'custom', commitAgentCommand: 'sh' } as Settings
const context: NodeNamingContext = { kind: 'sticky', title: 'Notes', details: 'Plan the next release' }

beforeEach(() => {
  fake.output = '"Release Checklist."\nExtra explanation'
  fake.code = 0
  fake.prompts = []
  fake.calls = 0
})
afterEach(() => vi.restoreAllMocks())

describe('generateNodeName', () => {
  it('uses the configured CLI and node account, and returns only the cleaned title', async () => {
    const env = { CLAUDE_CONFIG_DIR: '/managed/account' }
    expect(await generateNodeName(context, '/tmp', settings, env)).toEqual({ ok: true, message: 'Release Checklist' })
    expect(fake.prompts[0]).toContain('Plan the next release')
    expect(fake.env).toBe(env)
    expect(fake.calls).toBe(1)
  })

  it('rejects malformed IPC input before starting a CLI', async () => {
    expect(await generateNodeName({ kind: 'loop' } as unknown as NodeNamingContext, '', settings)).toMatchObject({ ok: false })
    expect(fake.calls).toBe(0)
  })

  it('returns CLI authentication errors instead of applying them as names', async () => {
    fake.output = 'Failed to authenticate: sign in again'
    expect(await generateNodeName(context, '/tmp', settings)).toMatchObject({ ok: false })
    fake.output = 'Network unavailable'
    fake.code = 1
    expect(await generateNodeName(context, '/tmp', settings)).toMatchObject({ ok: false })
  })

  it('fails when the CLI produces no usable name', async () => {
    fake.output = '...'
    expect(await generateNodeName(context, '/tmp', settings)).toEqual({ ok: false, message: 'No name produced.' })
  })
})
