// A Control link's password field and its generator — shared by the create dialog, the chip's popover
// and the Live chat drawer. The plaintext only ever lives in the state of the component that shows
// it; nothing here stores, logs or announces it. Core keeps only a hash.
import { useCallback, useEffect, useRef, useState, type Ref } from 'react'
import { PASSWORD_MAX } from '@shared/watch-link/protocol'
import { generateControlPassword } from '@shared/watch-link-password'

/** Generate: 16 symbols from the platform CSPRNG (spec §2.2). */
export function newControlPassword(): string {
  return generateControlPassword((n) => crypto.getRandomValues(new Uint8Array(n)))
}

/** A password field: plain text (the owner must be able to read what they send), no autocomplete or
 *  spell check, capped at the unlock cast's limit. Read-only selects its text on focus. */
export function PasswordField(p: {
  value: string
  readOnly?: boolean
  disabled?: boolean
  onChange?: (v: string) => void
  label?: string
  /** The id of the line that explains what is wrong with it (aria-describedby); absent when nothing is. */
  describedBy?: string
  inputRef?: Ref<HTMLInputElement>
}): React.JSX.Element {
  return (
    <input
      ref={p.inputRef}
      className="confirm__input"
      type="text"
      autoComplete="off"
      spellCheck={false}
      maxLength={PASSWORD_MAX}
      aria-label={p.label ?? 'Password'}
      aria-describedby={p.describedBy}
      value={p.value}
      readOnly={p.readOnly}
      disabled={p.disabled}
      onFocus={p.readOnly ? (e) => e.currentTarget.select() : undefined}
      onChange={p.onChange ? (e) => p.onChange?.(e.target.value) : undefined}
    />
  )
}

/** How long a copy button reads "Copied!". */
export const COPIED_FLASH_MS = 1500

/**
 * A copy button's "Copied!" flash: `copy(text)` puts the text on the clipboard and flips `copied`
 * for `COPIED_FLASH_MS`; a second copy restarts the flash. The timer dies with the component.
 */
export function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback((text: string) => {
    window.nodeTerminal.clipboard.writeText(text)
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_FLASH_MS)
  }, [])
  return [copied, copy]
}
