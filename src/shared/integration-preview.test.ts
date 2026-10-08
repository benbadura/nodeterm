import { describe, expect, it } from 'vitest'
import { detectPreviewCommands, previewOptionsValid, unavailablePreviewApi } from './integration-preview'

describe('integration preview command detection', () => {
  it('uses the declared manager and CI script over incidental lockfiles', () => {
    const result = detectPreviewCommands({
      'package.json': JSON.stringify({ packageManager: 'pnpm@10.0.0', scripts: { 'test:ci': 'vitest run', test: 'vitest' } }),
      'pnpm-lock.yaml': '', 'package-lock.json': ''
    })
    expect(result).toEqual([expect.objectContaining({ setupCommand: 'pnpm install --frozen-lockfile', testCommand: 'pnpm run test:ci' })])
  })
  it('offers a choice for ambiguous lockfiles and requires manual tests when absent', () => {
    const result = detectPreviewCommands({ 'package.json': '{}', 'yarn.lock': '', 'bun.lock': '' })
    expect(result.map((s) => s.setupCommand)).toEqual(['yarn install --frozen-lockfile', 'bun install --frozen-lockfile'])
    expect(result.every((s) => s.testCommand === '')).toBe(true)
    expect(detectPreviewCommands({ 'package.json': 'null' })).toEqual([])
    expect(detectPreviewCommands({ 'package.json': 'invalid' })).toEqual([])
  })
  it('detects modern Yarn and ordinary installs without a lockfile', () => {
    expect(detectPreviewCommands({ 'package.json': '{}', 'yarn.lock': '__metadata:\n' })[0].setupCommand).toBe('yarn install --immutable')
    expect(detectPreviewCommands({ 'package.json': JSON.stringify({ scripts: { test: 'node tests.js' } }) })[0])
      .toMatchObject({ setupCommand: 'npm install', testCommand: 'npm run test' })
    expect(detectPreviewCommands({ 'package.json': '{}', 'package-lock.json': '' })[0].setupCommand).toBe('npm ci')
  })
  it('isolates Python dependencies and only suggests pytest when declared', () => {
    expect(detectPreviewCommands({ 'pyproject.toml': '[tool.pytest.ini_options]\n', 'uv.lock': '' })[0])
      .toMatchObject({ setupCommand: 'uv sync --locked', testCommand: 'uv run --locked python -m pytest' })
    const files = { 'requirements.txt': 'requests\n', 'requirements-dev.txt': 'pytest>=8\n' }
    expect(detectPreviewCommands(files)[0]).toMatchObject({
      setupCommand: 'python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt -r requirements-dev.txt',
      testCommand: '.venv/bin/python -m pytest'
    })
    expect(detectPreviewCommands(files, true)[0].testCommand).toBe('.venv\\Scripts\\python.exe -m pytest')
    expect(detectPreviewCommands({ 'pyproject.toml': '[project]\n' })[0].testCommand).toBe('')
  })
  it('offers Rust, Go and explicit .NET targets without choosing between ecosystems', () => {
    const result = detectPreviewCommands({ 'Cargo.toml': '', 'Cargo.lock': '', 'go.mod': '', 'App.sln': '', 'Other.slnx': '', 'Hidden.csproj': '' })
    expect(result.map((s) => s.testCommand)).toEqual(['cargo test --locked', 'go test ./...', "dotnet test 'App.sln'", "dotnet test 'Other.slnx'"])
    expect(detectPreviewCommands({ 'Cargo.toml': '' })[0].testCommand).toBe('cargo test')
    expect(detectPreviewCommands({ '%BAD%.sln': '' }, true)).toEqual([])
  })
})

it('validates the preview input and safely degrades outside Desktop', async () => {
  const options = { baseRef: 'main', branches: ['a', 'b'], setupCommand: '', testCommand: 'test', timeoutMinutes: 10 }
  expect(previewOptionsValid(options)).toBe(true)
  for (const patch of [{ branches: ['a', 'a'] }, { branches: ['main', 'b'] }, { branches: ['a'] }, { testCommand: ' ' }, { timeoutMinutes: NaN }, { timeoutMinutes: 121 }]) {
    expect(previewOptionsValid({ ...options, ...patch })).toBe(false)
  }
  const api = unavailablePreviewApi()
  expect((await api.inspect('p')).available).toBe(false)
  expect((await api.start('p', options)).ok).toBe(false)
  expect(await api.get('p')).toBeNull()
  expect(await api.cancel('p', 'r')).toBe(false)
  expect(api.onEvent('p', () => {})()).toBeUndefined()
})
