import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * The mobile companion is no longer iOS-only, and the Android store listing does not exist yet.
 *
 * 1. No renderer file but `lib/links.ts` may name a store URL or constant — every surface goes
 *    through `mobileStoreLinks()` / `mobileStoreNames()`, so the ONE `ANDROID_APP_PUBLISHED` flag
 *    decides whether a Play link exists anywhere. A component importing the URL directly is how a
 *    dead link would ship.
 * 2. iOS-only phrasings must not come back on the pairing / phone / launch / notification surfaces.
 *    (Genuinely iPhone-specific copy — the iPhone Camera QR fallback in PhoneSection — is not in the
 *    banned list.) Comments are not scanned for (2); they carry history.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..')
const RENDERER = join(REPO_ROOT, 'src', 'renderer')
const LINKS_FILE = 'src/renderer/lib/links.ts'

function norm(p: string): string {
  return p.replace(/\\/g, '/')
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out)
      continue
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
    out.push(full)
  }
  return out
}

const STORE_TOKENS = [
  'IOS_APP_STORE_URL',
  'ANDROID_PLAY_STORE_URL',
  'apps.apple.com',
  'play.google.com'
]

/** file (repo-relative) → phrases that must not appear outside comments. */
const BANNED_COPY: Record<string, string[]> = {
  'src/renderer/components/PhonePairPopover.tsx': ['nodeterm iOS app'],
  'src/renderer/components/settings/sections/PhoneSection.tsx': [
    'nodeterm iOS app',
    'nodeterm for iOS'
  ],
  'src/renderer/components/MobileLaunchCard.tsx': ['Get the iOS app', 'on the App Store'],
  'src/renderer/components/onboarding/OnboardingFlow.tsx': [
    'Get the iOS app',
    'Grab it from the App Store'
  ],
  'src/renderer/components/settings/sections/NotificationsSection.tsx': [
    'label="Live Activities"',
    'ariaLabel="Live Activities',
    'Live Activities are never held',
    'Lock Screen / Dynamic Island'
  ]
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('mobile store guard', () => {
  it('only lib/links.ts names a store URL or store constant', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(RENDERER)) {
      const rel = norm(relative(REPO_ROOT, file))
      if (rel === LINKS_FILE) continue
      const src = readFileSync(file, 'utf8')
      for (const token of STORE_TOKENS) if (src.includes(token)) offenders.push(`${rel}: ${token}`)
    }
    expect(offenders).toEqual([])
  })

  it('pairing / phone / launch / notification copy is platform-neutral', () => {
    const offenders: string[] = []
    for (const [rel, phrases] of Object.entries(BANNED_COPY)) {
      const src = stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'))
      for (const phrase of phrases) if (src.includes(phrase)) offenders.push(`${rel}: ${phrase}`)
    }
    expect(offenders).toEqual([])
  })

  it('renames the label but keeps the persisted mobileLiveActivities key', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'src/renderer/components/settings/sections/NotificationsSection.tsx'),
      'utf8'
    )
    expect(src).toContain('label="Live updates on phone"')
    expect(src).toContain('update({ mobileLiveActivities: on })')
  })
})
