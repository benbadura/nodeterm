export type PreviewPhase = 'resolving' | 'merging' | 'preparing' | 'testing' | 'cleaning' | 'finished'
export type PreviewOutcome = 'passed' | 'conflict' | 'git-error' | 'setup-failed' | 'tests-failed' | 'cancelled' | 'timed-out' | 'interrupted'

export interface PreviewOptions {
  baseRef: string
  branches: string[]
  setupCommand: string
  testCommand: string
  timeoutMinutes: number
}
export interface PreviewRef { name: string; sha: string }
export interface PreviewReport {
  runId: string
  projectId: string
  seq: number
  phase: PreviewPhase
  options: PreviewOptions
  base?: PreviewRef
  branches: PreviewRef[]
  mergedBranches: string[]
  currentBranch?: string
  conflicts: string[]
  startedAt: string
  finishedAt?: string
  outcome?: PreviewOutcome
  message?: string
  setupExitCode?: number
  testExitCode?: number
  logs: { git: string; setup: string; tests: string }
  cleanup: 'pending' | 'done' | 'failed'
  cleanupMessage?: string
}
export interface PreviewSuggestion {
  label: string
  source: string
  setupCommand: string
  testCommand: string
}
export interface PreviewInspection {
  available: boolean
  reason?: string
  branches: string[]
  defaultBaseRef: string
  suggestions: PreviewSuggestion[]
  defaults?: PreviewOptions
}
export interface IntegrationPreviewApi {
  inspect(projectId: string, baseRef?: string): Promise<PreviewInspection>
  start(projectId: string, options: PreviewOptions): Promise<{ ok: boolean; runId?: string; message?: string }>
  get(projectId: string): Promise<PreviewReport | null>
  listReports(projectId: string): Promise<PreviewReport[]>
  cancel(projectId: string, runId: string): Promise<boolean>
  retryCleanup(projectId: string, runId: string): Promise<boolean>
  onEvent(projectId: string, cb: (report: PreviewReport) => void): () => void
}

export const PREVIEW_DEFAULT_TIMEOUT_MINUTES = 10
export const PREVIEW_HISTORY_LIMIT = 10
export const PREVIEW_UNAVAILABLE = 'Integration preview is available for local Desktop projects only.'

export function previewOptionsValid(value: unknown): value is PreviewOptions {
  if (!value || typeof value !== 'object') return false
  const v = value as PreviewOptions
  return typeof v.baseRef === 'string' && v.baseRef.length > 0 && v.baseRef.length <= 1024 &&
    Array.isArray(v.branches) && v.branches.length >= 2 && v.branches.length <= 32 &&
    v.branches.every((b) => typeof b === 'string' && b.length > 0 && b.length <= 1024) &&
    new Set(v.branches).size === v.branches.length && !v.branches.includes(v.baseRef) &&
    typeof v.setupCommand === 'string' && v.setupCommand.length <= 64000 &&
    typeof v.testCommand === 'string' && !!v.testCommand.trim() && v.testCommand.length <= 64000 &&
    Number.isFinite(v.timeoutMinutes) && v.timeoutMinutes >= 1 && v.timeoutMinutes <= 120
}

/** Reads committed root files supplied by core; never executes detection commands. */
export function detectPreviewCommands(files: Record<string, string>, windows = false): PreviewSuggestion[] {
  const suggestions: PreviewSuggestion[] = []
  const has = (name: string) => Object.hasOwn(files, name)
  const add = (label: string, source: string, setupCommand: string, testCommand: string) =>
    suggestions.push({ label, source, setupCommand, testCommand })
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(files['package.json'])
      const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.match(/^(npm|pnpm|yarn|bun)@(\d+)/) : null
      const locks = [
        ['npm', has('package-lock.json') || has('npm-shrinkwrap.json')],
        ['pnpm', has('pnpm-lock.yaml')], ['yarn', has('yarn.lock')],
        ['bun', has('bun.lock') || has('bun.lockb')]
      ].filter(([, present]) => present).map(([manager]) => manager as string)
      // Multiple lockfiles without a declared manager need a human choice.
      const managers = declared ? [declared[1]] : locks.length ? locks : ['npm']
      const script = typeof pkg.scripts?.['test:ci'] === 'string' ? 'test:ci' :
        typeof pkg.scripts?.test === 'string' ? 'test' : ''
      for (const manager of managers) {
        const locked = locks.includes(manager)
        const modernYarn = declared?.[1] === 'yarn' ? Number(declared[2]) >= 2 :
          has('.yarnrc.yml') || files['yarn.lock']?.includes('__metadata:')
        const setup = manager === 'npm' ? (locked ? 'npm ci' : 'npm install') :
          manager === 'yarn' ? `yarn install${locked ? modernYarn ? ' --immutable' : ' --frozen-lockfile' : ''}` :
          `${manager} install${locked ? ' --frozen-lockfile' : ''}`
        add(`Node.js · ${manager}`, declared ? 'package.json: packageManager' : locked ? `${manager} lockfile` : 'package.json',
          setup, script ? `${manager} run ${script}` : '')
      }
    } catch { /* A malformed manifest must not prevent manual configuration. */ }
  }
  const python = has('pyproject.toml') || has('requirements.txt') || has('requirements-dev.txt') || has('pytest.ini')
  if (python) {
    const pytest = has('pytest.ini') || /\[tool\.pytest(?:\.|\])/.test(files['pyproject.toml'] ?? '') ||
      /(?:^|[\s"',])pytest(?:[\s"'\[<=>!~;]|$)/m.test([
        files['pyproject.toml'], files['requirements.txt'], files['requirements-dev.txt']
      ].filter(Boolean).join('\n'))
    if (has('uv.lock')) {
      add('Python · uv', 'uv.lock', 'uv sync --locked', pytest ? 'uv run --locked python -m pytest' : '')
    } else {
      const py = windows ? '.venv\\Scripts\\python.exe' : '.venv/bin/python'
      const requirements = ['requirements.txt', 'requirements-dev.txt'].filter(has)
      const setup = `${windows ? 'python' : 'python3'} -m venv .venv` +
        (requirements.length ? ` && ${py} -m pip install ${requirements.map((f) => `-r ${f}`).join(' ')}` : '')
      add('Python · venv', requirements.join(', ') || 'pyproject.toml / pytest.ini', setup, pytest ? `${py} -m pytest` : '')
    }
  }
  if (has('Cargo.toml')) add('Rust', 'Cargo.toml', '', `cargo test${has('Cargo.lock') ? ' --locked' : ''}`)
  if (has('go.mod')) add('Go', 'go.mod', '', 'go test ./...')
  const solutions = Object.keys(files).filter((f) => /\.(sln|slnx)$/.test(f))
  const dotnetTargets = solutions.length ? solutions : Object.keys(files).filter((f) => /\.(csproj|fsproj|vbproj)$/.test(f))
  for (const target of dotnetTargets) {
    if (windows && /[%!"&|<>^\r\n]/.test(target)) continue
    // A path becomes shell input only in a displayed, editable suggestion; quote it literally.
    const quoted = windows ? `"${target.replace(/"/g, '""')}"` : `'${target.replace(/'/g, "'\\''")}'`
    add(`.NET · ${target}`, target, '', `dotnet test ${quoted}`)
  }
  return suggestions
}

export function unavailablePreviewApi(): IntegrationPreviewApi {
  return {
    inspect: async () => ({ available: false, reason: PREVIEW_UNAVAILABLE, branches: [], defaultBaseRef: '', suggestions: [] }),
    start: async () => ({ ok: false, message: PREVIEW_UNAVAILABLE }),
    get: async () => null,
    listReports: async () => [],
    cancel: async () => false,
    retryCleanup: async () => false,
    onEvent: () => () => {}
  }
}
