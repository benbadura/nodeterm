import { useLayoutEffect, useRef, useState } from 'react'
import {
  GLASS_READABLE_TICK,
  snapGlassSlider,
  stepGlassSlider
} from '@renderer/lib/glassContrast'

/** Keep the Readable caption at least this far from the Clear / Tinted captions. */
const CAPTION_GAP = 8

function valueText(v: number): string {
  if (v === GLASS_READABLE_TICK) return 'Readable'
  const pct = `${Math.round(v * 100)}%`
  return v < GLASS_READABLE_TICK ? `Clearer than readable, ${pct}` : `More tinted than readable, ${pct}`
}

/**
 * The Liquid Glass slider, drawn like a macOS slider with a tick mark: a thin rounded track filled
 * with the accent up to the thumb, a notch at the Readable point with its caption under it, and
 * a magnetic detent there for both drag and arrow keys (lib/glassContrast `snapGlassSlider` /
 * `stepGlassSlider`). Styles: `.glass-slider` in styles.css.
 */
export function GlassSlider({
  value,
  disabled,
  onChange
}: {
  value: number
  disabled: boolean
  onChange: (v: number | null) => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const clear = useRef<HTMLSpanElement>(null)
  const tinted = useRef<HTMLSpanElement>(null)
  const readable = useRef<HTMLButtonElement>(null)
  const [captionLeft, setCaptionLeft] = useState<number | null>(null)

  // Centre the Readable caption under the notch, clamped clear of the two end captions.
  useLayoutEffect(() => {
    const measure = (): void => {
      const w = wrap.current?.clientWidth ?? 0
      const half = (readable.current?.offsetWidth ?? 0) / 2
      const min = (clear.current?.offsetWidth ?? 0) + CAPTION_GAP + half
      const max = w - (tinted.current?.offsetWidth ?? 0) - CAPTION_GAP - half
      const notch = 10 + (w - 20) * GLASS_READABLE_TICK
      setCaptionLeft(Math.min(Math.max(notch, min), Math.max(min, max)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (wrap.current) ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={wrap}
      className="glass-slider"
      aria-disabled={disabled || undefined}
      style={{ ['--glass-fill' as string]: value, ['--glass-tick' as string]: GLASS_READABLE_TICK }}
    >
      <div className="glass-slider__rail">
        <span className="glass-slider__notch" aria-hidden />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={value}
          disabled={disabled}
          aria-label="Glass, from Clear to Tinted"
          aria-valuetext={valueText(value)}
          onChange={(e) => onChange(snapGlassSlider(Number(e.target.value)))}
          onKeyDown={(e) => {
            const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
            if (!dir) return
            e.preventDefault()
            onChange(stepGlassSlider(value, dir))
          }}
        />
      </div>
      <div className="glass-slider__captions">
        <span ref={clear}>Clear</span>
        <button
          ref={readable}
          type="button"
          className="glass-slider__readable"
          disabled={disabled}
          style={{ left: captionLeft ?? undefined, visibility: captionLeft === null ? 'hidden' : undefined }}
          onClick={() => onChange(null)}
          title="Back to the readable point"
        >
          Readable
        </button>
        <span ref={tinted} className="glass-slider__tinted">
          Tinted
        </span>
      </div>
    </div>
  )
}
