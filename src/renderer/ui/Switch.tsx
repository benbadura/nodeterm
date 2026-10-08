import { cn } from './cn'

export function Switch({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
  pending = false
}: {
  checked: boolean
  onChange: (v: boolean) => void
  ariaLabel?: string
  /** Renders inert (native `disabled` + aria): for a switch whose subject does not currently
   *  exist, e.g. a per-project capability while no project is open. */
  disabled?: boolean
  /** A change is in flight: announced as disabled and busy, clicks ignored — but NOT natively
   *  disabled, so a switch that has the keyboard focus keeps it (a disabled button drops it). */
  pending?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      aria-disabled={disabled || pending || undefined}
      aria-busy={pending || undefined}
      onClick={() => {
        if (!pending) onChange(!checked)
      }}
      className={cn(
        'relative box-border block h-[24px] w-[42px] shrink-0 rounded-full border-0 p-0 outline-none transition-colors duration-200',
        disabled ? 'cursor-not-allowed opacity-50' : pending ? 'cursor-progress opacity-70' : 'cursor-pointer',
        checked ? 'bg-accent' : 'bg-fill'
      )}
    >
      <span
        className={cn(
          'absolute left-[3px] top-[3px] size-[18px] rounded-full bg-white shadow-sm transition-transform duration-200',
          checked ? 'translate-x-[18px]' : 'translate-x-0'
        )}
      />
    </button>
  )
}
