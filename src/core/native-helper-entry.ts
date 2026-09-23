import { runNativeHelper } from './native-helper'
// Export the same launcher generator for artifact smoke tests: they must exercise the real
// installed path (inside app.asar), not a hand-written approximation of the PowerShell shim.
export { nativeHelperScript, nativeHookCommand } from './native-helper-install'

if (require.main === module) {
  const args: string[] = process.env.NODETERM_HELPER_ARGS
    ? JSON.parse(process.env.NODETERM_HELPER_ARGS) : process.argv.slice(2)
  delete process.env.NODETERM_HELPER_ARGS
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new Error('Invalid helper arguments.')
  runNativeHelper(args).then(code => { process.exitCode = code }).catch(error => {
    if (args[0] === 'hook') { process.exitCode = 0; return }
    console.error(error instanceof Error ? error.message : 'Helper failed.')
    process.exitCode = 1
  })
}
