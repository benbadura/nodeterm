/** What the app chrome follows. `auto` takes it from the terminal colour theme. */
export type AppThemePref = 'auto' | 'dark' | 'light' | 'liquid-glass'

/** Is the Liquid Glass appearance on? It is a theme choice whose light/dark base follows the
 *  terminal theme, exactly like `auto`. */
export function isLiquidGlass(pref: unknown): boolean {
  return pref === 'liquid-glass'
}

/** What actually gets rendered. */
export type ResolvedAppTheme = 'dark' | 'light'

/**
 * Resolve the app's appearance.
 *
 * `auto` follows the TERMINAL theme, which is the behaviour the light themes were asked for:
 * picking Solarized Light and being left with a black window around it reads as a half-finished
 * setting, because on a canvas the terminal IS most of the window. The explicit values exist
 * because the coupling isn't a law — a light terminal inside dark chrome is a legitimate taste,
 * and so is dark-on-light — so `auto` is a default, not the only option.
 *
 * Defaults to dark on anything unrecognised: `settings.json` is hand-editable, and dark is what
 * every existing install renders today.
 */
export function resolveAppTheme(pref: AppThemePref, terminalThemeIsDark: boolean): ResolvedAppTheme {
  if (pref === 'light') return 'light'
  if (pref === 'dark') return 'dark'
  if (pref !== 'auto' && pref !== 'liquid-glass') return 'dark'
  return terminalThemeIsDark ? 'dark' : 'light'
}

/**
 * Monaco's built-in theme for an app appearance.
 *
 * Monaco's theme is GLOBAL, not per-editor: the `theme` option on create sets it for every
 * instance. So editor and diff nodes both pass this at create AND re-assert it on change — from
 * whichever of them is mounted — rather than trying to own it individually.
 */
export function monacoTheme(theme: ResolvedAppTheme): 'vs' | 'vs-dark' {
  return theme === 'light' ? 'vs' : 'vs-dark'
}
