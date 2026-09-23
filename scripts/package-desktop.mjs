import { spawnSync } from 'node:child_process'

const scripts = { darwin: 'dist:mac', linux: 'dist:linux', win32: 'dist:win' }
const script = scripts[process.platform]
if (!script || !process.env.npm_execpath) throw new Error('Build on a supported desktop host using npm run dist.')
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', script], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
