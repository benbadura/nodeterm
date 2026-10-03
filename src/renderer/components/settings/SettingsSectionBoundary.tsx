import { Component, type ReactNode } from 'react'

interface State {
  error: Error | null
}

/**
 * Error boundary for ONE settings section. Every section is mounted whenever Settings is open (an
 * inactive one renders null, but its hooks and render body still run), so a throw in any of them —
 * even one the user never navigated to — used to unmount the whole page and leave a blank window
 * (#1090: a TDZ ReferenceError in GitHubIssuesSection). The boundary contains it to that section:
 * the fallback shows only while the section is the one being viewed, so the rest of Settings stays
 * usable and the broken section says so instead of rendering nothing.
 */
export class SettingsSectionBoundary extends Component<
  { title: string; visible: boolean; children: ReactNode },
  State
> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error(`[settings] section "${this.props.title}" failed to render`, error)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    if (!this.props.visible) return null
    return (
      <section className="space-y-3" role="alert">
        <h2 className="text-[28px] font-bold leading-tight tracking-tight text-text">{this.props.title}</h2>
        <p className="text-sm text-warn">
          This section could not be displayed. The rest of Settings still works; reopening Settings
          tries again.
        </p>
        <p className="text-[13px] text-muted">{this.state.error.message}</p>
      </section>
    )
  }
}
