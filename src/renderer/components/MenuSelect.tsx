// A compact dropdown for a dialog row ("Anyone with the link · can watch ▾"): a button that shows the
// current choice and opens a small menu of options, each with an optional one-line hint. It renders
// INSIDE its row (absolutely positioned below the trigger), never in a portal: a dialog under Liquid
// Glass is a backdrop root, and a menu portaled out of it would sit on top of the scrim instead.
//
// Keyboard: ArrowDown / ArrowUp on the trigger open the menu; in the menu, the arrows, Home and End
// move between the options that can be picked, Enter / Space pick, Escape and Tab close it and give
// focus back to the trigger. Escape is stopped here so it closes the menu and not the dialog.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { IconCheck, IconChevronDown } from './icons'

export interface MenuSelectOption<T> {
  value: T
  label: string
  /** One muted line under the label: what the choice means, or why it is disabled. */
  hint?: string
  /** Shown, readable, never pickable. */
  disabled?: boolean
}

/** The next option that can be picked from `from` in `dir`, wrapping; `from` itself when none. */
export function nextEnabled<T>(options: readonly MenuSelectOption<T>[], from: number, dir: 1 | -1): number {
  const n = options.length
  for (let step = 1; step <= n; step++) {
    const i = (((from + dir * step) % n) + n) % n
    if (!options[i].disabled) return i
  }
  return from
}

export function MenuSelect<T extends string | number>(p: {
  /** The accessible name: what is being chosen ("Who can use the link"). */
  label: string
  value: T
  options: readonly MenuSelectOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  /** Marks the trigger as the dialog's first focus (`data-autofocus`). */
  autoFocus?: boolean
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const current = p.options.find((o) => o.value === p.value)

  const openMenu = (): void => {
    if (p.disabled) return
    const at = p.options.findIndex((o) => o.value === p.value && !o.disabled)
    setActive(at >= 0 ? at : nextEnabled(p.options, -1, 1))
    setOpen(true)
  }
  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }
  const pick = (o: MenuSelectOption<T>): void => {
    if (o.disabled) return
    if (o.value !== p.value) p.onChange(o.value)
    close(true)
  }

  // The highlighted option holds focus, so a screen reader follows the arrows.
  useEffect(() => {
    if (open) itemRefs.current[active]?.focus()
  }, [open, active])
  // A press anywhere outside the menu and its trigger closes it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open])
  // Disabled while open (the dialog went busy): nothing may be picked any more.
  useEffect(() => {
    if (p.disabled) setOpen(false)
  }, [p.disabled])

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      openMenu()
    }
  }
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const last = p.options.length - 1
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActive((i) => nextEnabled(p.options, i, 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActive((i) => nextEnabled(p.options, i, -1))
        break
      case 'Home':
        e.preventDefault()
        setActive(nextEnabled(p.options, last, 1))
        break
      case 'End':
        e.preventDefault()
        setActive(nextEnabled(p.options, 0, -1))
        break
      case 'Escape':
        // The menu's Escape, not the dialog's: the dialog listens on the window, which this never reaches.
        e.preventDefault()
        e.stopPropagation()
        close(true)
        break
      case 'Tab':
        e.preventDefault()
        close(true)
        break
    }
  }

  return (
    <div className={`menu-select${p.className ? ` ${p.className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="menu-select__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${p.label}: ${current?.label ?? ''}`}
        disabled={p.disabled}
        data-autofocus={p.autoFocus ? '' : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onTriggerKey}
      >
        <span className="menu-select__value">{current?.label ?? ''}</span>
        <IconChevronDown />
      </button>
      {open && (
        <div className="menu-select__menu" role="menu" aria-label={p.label} onKeyDown={onMenuKey}>
          {p.options.map((o, i) => {
            const selected = o.value === p.value
            return (
              <button
                key={String(o.value)}
                type="button"
                ref={(el) => {
                  itemRefs.current[i] = el
                }}
                role="menuitemradio"
                aria-checked={selected}
                aria-disabled={o.disabled || undefined}
                tabIndex={i === active ? 0 : -1}
                className={`menu-select__item${i === active ? ' active' : ''}${o.disabled ? ' disabled' : ''}`}
                onMouseEnter={() => {
                  if (!o.disabled) setActive(i)
                }}
                onClick={() => pick(o)}
              >
                <span className="menu-select__check">{selected && <IconCheck />}</span>
                <span className="menu-select__text">
                  <span className="menu-select__label">{o.label}</span>
                  {o.hint && <span className="menu-select__hint">{o.hint}</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
