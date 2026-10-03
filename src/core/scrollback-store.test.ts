import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { writeScrollback, readScrollback } from './scrollback-store'

// The boolean result is load-bearing: pty-manager remembers the digest of a snapshot only when
// this reports that it LANDED (Task 8 fix round 1). The store must still never throw.
describe('writeScrollback result', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-sb-'))
  })
  afterEach(() => {
    resetPlatformForTests()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('resolves true when the snapshot landed', async () => {
    initPlatform(fakePlatform({ userDataDir: root }))
    expect(await writeScrollback('node-1', 'hello')).toBe(true)
    expect(await readScrollback('node-1')).toBe('hello')
  })

  it('resolves false (never throws) when the write fails', async () => {
    // userData is a regular FILE, so creating the snapshot directory under it fails.
    const file = path.join(root, 'not-a-dir')
    fs.writeFileSync(file, '')
    initPlatform(fakePlatform({ userDataDir: file }))
    expect(await writeScrollback('node-1', 'hello')).toBe(false)
  })

  it('resolves false for empty data (nothing written)', async () => {
    initPlatform(fakePlatform({ userDataDir: root }))
    expect(await writeScrollback('node-1', '')).toBe(false)
  })
})
