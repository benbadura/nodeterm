import { useEffect, useState } from 'react'
import type { TerminalProfile } from '@shared/terminal-profile'
import { Select } from '@renderer/ui/Select'
import { useSettings } from '../../../state/settings'
import { sessionForProject } from '../../../session/session'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Input } from '@renderer/ui/Input'

const ROWS = {
  shell: { title: 'Default shell', keywords: ['shell', 'bash', 'zsh', 'fish', 'default'] },
  profile: { title: 'Terminal profile', keywords: ['powershell', 'cmd', 'wsl', 'git bash', 'profile'] }
}
const ENTRIES = Object.values(ROWS)

export function ShellSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const defaultShell = useSettings((s) => s.settings.defaultShell)
  const profileId = useSettings((s) => s.settings.defaultTerminalProfileId)
  const [profiles, setProfiles] = useState<TerminalProfile[]>([])
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      sessionForProject('').api.pty.listProfiles().then(p => { if (active) setProfiles(p) }).catch(() => {})
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [defaultShell])
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection
      id="shell"
      title="Shell"
      description="The shell new terminals launch. Empty uses the system default."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      {profiles.length > 0 && <SearchableRow {...ROWS.profile}>
        <FieldRow label="Profile for new terminals" control={
          <Select aria-label="Terminal profile" value={profileId ?? (defaultShell ? 'custom' : 'auto')}
            onChange={e => update({ defaultTerminalProfileId: e.target.value })}>
            {profiles.map(p => <option key={p.id} value={p.id} disabled={!p.available}>
              {p.label}{p.available ? '' : ` — ${p.unavailableReason}`}
            </option>)}
          </Select>
        } />
        <p className="text-xs text-muted-2">Applies to new sessions. Running terminals keep their shell.</p>
      </SearchableRow>}
      <SearchableRow {...ROWS.shell}>
        <FieldRow
          label="Default shell"
          control={
            <Input
              className="w-64"
              placeholder="system default"
              value={defaultShell}
              onChange={(e) => update({ defaultShell: e.target.value })}
            />
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
