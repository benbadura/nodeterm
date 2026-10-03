/**
 * Whether the canvas draws its dot grid (Settings → Appearance → Show grid dots). Display only:
 * snap-to-grid and align-to-grid keep using `gridSize` either way.
 *
 * settings.json is hand-editable, so anything but a literal `false` keeps the default (dots on).
 */
export function showCanvasDots(value: unknown): boolean {
  return value !== false
}
