/** Human-facing invocation, based on the actual installed launcher, never the viewer OS. */
export function helperCommand(file: string): string {
  return file.endsWith('.ps1')
    ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File '${file.replaceAll("'", "''")}'`
    : `sh "${file}"`
}
