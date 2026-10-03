/**
 * The Apple system colours (HIG color.md) for the few JS consumers that need a LITERAL — xterm
 * search decorations, canvas-drawn sprites, the notch HUD window (which does not load styles.css).
 * Everything that styles the DOM uses the `--sys-*` / `--state-*` tokens in styles.css instead;
 * `styles.palette.test.ts` pins those declarations to this table so the two cannot drift.
 */
export type SystemColor =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'mint'
  | 'teal'
  | 'cyan'
  | 'blue'
  | 'indigo'
  | 'purple'
  | 'pink'
  | 'brown'
  | 'gray'

export const SYSTEM_COLORS: Record<
  'dark' | 'light' | 'darkContrast' | 'lightContrast',
  Record<SystemColor, string>
> = {
  dark: {
    red: '#ff453a',
    orange: '#ff9f0a',
    yellow: '#ffd60a',
    green: '#30d158',
    mint: '#63e6e2',
    teal: '#40cbe0',
    cyan: '#64d2ff',
    blue: '#0a84ff',
    indigo: '#5e5ce6',
    purple: '#bf5af2',
    pink: '#ff375f',
    brown: '#ac8e68',
    gray: '#98989d'
  },
  light: {
    red: '#ff3b30',
    orange: '#ff9500',
    yellow: '#ffcc00',
    green: '#34c759',
    mint: '#00c7be',
    teal: '#30b0c7',
    cyan: '#32ade6',
    blue: '#007aff',
    indigo: '#5856d6',
    purple: '#af52de',
    pink: '#ff2d55',
    brown: '#a2845e',
    gray: '#8e8e93'
  },
  // HIG color.md's "Increased contrast" columns — what Liquid Glass switches to under the system
  // Increase Contrast setting (styles.css, the accessibility block at the end).
  darkContrast: {
    red: '#ff6961',
    orange: '#ffb340',
    yellow: '#ffd426',
    green: '#30db5b',
    mint: '#66d4cf',
    teal: '#5de6ff',
    cyan: '#70d7ff',
    blue: '#409cff',
    indigo: '#7d7aff',
    purple: '#da8fff',
    pink: '#ff6482',
    brown: '#b59469',
    gray: '#aeaeb2'
  },
  lightContrast: {
    red: '#d70015',
    orange: '#c93400',
    yellow: '#b25000',
    green: '#248a3d',
    mint: '#0c817b',
    teal: '#008299',
    cyan: '#0071a4',
    blue: '#0040dd',
    indigo: '#3634a3',
    purple: '#8944ab',
    pink: '#d30f45',
    brown: '#7f6545',
    gray: '#6c6c70'
  }
}

/** Terminal find highlight (Apple's find highlight is yellow; the current match is brighter). */
export const FIND_DECORATIONS = {
  matchBackground: `${SYSTEM_COLORS.dark.yellow}55`,
  activeMatchBackground: SYSTEM_COLORS.dark.orange,
  matchOverviewRuler: SYSTEM_COLORS.dark.yellow,
  activeMatchColorOverviewRuler: SYSTEM_COLORS.dark.orange
}
