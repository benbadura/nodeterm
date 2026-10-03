import { useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useMenuFlip } from '@renderer/ui/useMenuFlip'
import { TERMINAL_THEMES, resolveTerminalTheme, type TerminalTheme } from '@renderer/terminal/themes'

/** The colours worth showing at a glance: the field, then the hues a prompt actually uses. */
function swatchColors(t: TerminalTheme): string[] {
  const c = t.theme
  return [c.foreground, c.red, c.green, c.yellow, c.blue, c.magenta, c.cyan].filter(
    (x): x is string => !!x
  )
}

/** The theme's own background with a strip of its own palette on it — a theme IS its palette, and
 *  a name alone ("Nord", "Gruvbox") tells you nothing if you haven't seen it before. */
function Swatch({ theme }: { theme: TerminalTheme }): React.JSX.Element {
  return (
    <span className="theme-swatch" style={{ background: theme.theme.background }} aria-hidden="true">
      {swatchColors(theme).map((c, i) => (
        <span key={i} className="theme-swatch__dot" style={{ background: c }} />
      ))}
    </span>
  )
}

function Group({
  label,
  themes,
  value,
  onPick
}: {
  label: string
  themes: TerminalTheme[]
  value: string
  onPick: (id: string) => void
}): React.JSX.Element | null {
  if (!themes.length) return null
  return (
    <>
      <div className="theme-select__group">{label}</div>
      {themes.map((t) => (
        <button type="button" key={t.id} onClick={() => onPick(t.id)}>
          <span className="tab-menu__check">{t.id === value ? '✓' : ''}</span>
          <Swatch theme={t} />
          <span className="theme-select__name">{t.label}</span>
        </button>
      ))}
    </>
  )
}

/**
 * Terminal colour-theme picker.
 *
 * A native `<select>` can only show names, and the thing being chosen is a set of colours — so
 * this is the app's own dropdown idiom instead (portal + full-screen `.tab-backdrop` click-catcher
 * + `.tab-menu`, exactly as BranchSelect and the tab caret menu do), with every row carrying its
 * own palette.
 */
export function ThemeSelect({
  value,
  onChange
}: {
  value: string
  onChange: (id: string) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ top: number; left: number; width: number; base: number } | null>(
    null
  )
  const current = resolveTerminalTheme(value)

  const open = (e: MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    // `base` is the trigger's TOP edge: when the list would overflow the viewport it flips to open
    // ABOVE the trigger rather than above the 4px gap (see useMenuFlip).
    setMenu({ top: r.bottom + 4, left: r.left, width: r.width, base: r.top })
  }

  return (
    <>
      <button type="button" className="bind-select theme-select__trigger" onClick={open}>
        <Swatch theme={current} />
        <span className="bind-select__val">{current.label}</span>
        <span className="bind-select__chev">⌄</span>
      </button>
      {menu && (
        <ThemeMenu
          anchor={menu}
          value={current.id}
          onPick={(id) => {
            onChange(id)
            setMenu(null)
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}

function ThemeMenu({
  anchor,
  value,
  onPick,
  onClose
}: {
  anchor: { top: number; left: number; width: number; base: number }
  value: string
  onPick: (id: string) => void
  onClose: () => void
}): React.ReactPortal {
  // Hook lives in its own component so it isn't called conditionally in ThemeSelect.
  const flip = useMenuFlip(anchor.top, anchor.left, anchor.base)
  return createPortal(
    <>
      <div className="tab-backdrop" style={{ zIndex: 78 }} onClick={onClose} />
      <div
        ref={flip.ref}
        className="tab-menu theme-select__menu"
        style={{ top: flip.top, left: flip.left, minWidth: anchor.width, zIndex: 80 }}
      >
        {/* `display: contents` in the default look; under Liquid Glass the scroller, so its end can
            fade (the menu itself is the glass, and a mask there would fade the blur too). */}
        <div className="theme-select__list">
          <Group
            label="Dark"
            themes={TERMINAL_THEMES.filter((t) => t.dark)}
            value={value}
            onPick={onPick}
          />
          <Group
            label="Light"
            themes={TERMINAL_THEMES.filter((t) => !t.dark)}
            value={value}
            onPick={onPick}
          />
        </div>
      </div>
    </>,
    document.body
  )
}
