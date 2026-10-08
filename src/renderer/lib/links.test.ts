import { describe, expect, it } from 'vitest'
import {
  ANDROID_APP_PUBLISHED,
  ANDROID_PLAY_STORE_URL,
  IOS_APP_STORE_URL,
  mobileStoreLinks,
  mobileStoreNames
} from './links'

describe('mobile store links', () => {
  it('ships with the Android listing switched OFF (it does not exist yet)', () => {
    expect(ANDROID_APP_PUBLISHED).toBe(false)
  })

  it('by default offers only the App Store — no dead Play link', () => {
    const links = mobileStoreLinks()
    expect(links.map((l) => l.url)).toEqual([IOS_APP_STORE_URL])
    expect(JSON.stringify(links)).not.toContain('play.google.com')
    expect(mobileStoreNames()).toBe('the App Store')
  })

  it('adds Google Play, after the App Store, once published', () => {
    const links = mobileStoreLinks(true)
    expect(links).toEqual([
      { id: 'app-store', label: 'Get it on the App Store', prose: 'the App Store', url: IOS_APP_STORE_URL },
      { id: 'google-play', label: 'Get it on Google Play', prose: 'Google Play', url: ANDROID_PLAY_STORE_URL }
    ])
    expect(mobileStoreNames(true)).toBe('the App Store or Google Play')
  })

  it('points at the Android package id the app ships under', () => {
    expect(ANDROID_PLAY_STORE_URL).toBe(
      'https://play.google.com/store/apps/details?id=com.nodeterm.android'
    )
  })
})
