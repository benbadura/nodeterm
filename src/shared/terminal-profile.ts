/** Public catalog: executable paths and arguments never cross the bridge. */
export interface TerminalProfile {
  id: string
  label: string
  kind: 'native' | 'posix' | 'wsl' | 'custom'
  available: boolean
  unavailableReason?: string
}
