// Custom sounds for the agent alerts (issue #289). The built-in chimes are synthesized in
// `renderer/lib/sfx.ts`; a user may replace either one with their own audio file.
//
// The FILE lives in the data dir of the machine that owns the core (`<userData>/sounds/<kind>.sound`,
// one format-independent name — see core/alert-sounds.ts), never at the user's original path: in the Server Edition that path
// names a disk on another machine. What rides in settings is only the display name and a stamp,
// so every window/client can tell a new pick from the one it already decoded.

/** The alert kinds a user can hear — and therefore replace. Mirrors `SfxKind`. */
export const ALERT_SOUND_KINDS = ['done', 'needsYou'] as const
export type AlertSoundKind = (typeof ALERT_SOUND_KINDS)[number]

/** A notification sound, not an album: anything bigger is refused before it is written. Also keeps
 *  the base64 round-trip (~4/3 of the bytes) under the Server Edition's 8 MiB WS frame cap. */
export const ALERT_SOUND_MAX_BYTES = 5 * 1024 * 1024

/** Extension allow-list. Each is a format Chromium's `decodeAudioData` handles. */
export const ALERT_SOUND_EXTENSIONS = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'webm'] as const
export type AlertSoundExtension = (typeof ALERT_SOUND_EXTENSIONS)[number]

/** `accept` for the file input — the same list, dotted. */
export const ALERT_SOUND_ACCEPT = ALERT_SOUND_EXTENSIONS.map((e) => `.${e}`).join(',')

/** What settings remember about a custom sound: never a path. */
export interface CustomAlertSound {
  /** The picked file's base name, for display only. */
  name: string
  /** Changes on every pick — the renderer's decode-cache key. */
  stamp: number
}

export type CustomAlertSounds = Partial<Record<AlertSoundKind, CustomAlertSound>>

export type AlertSoundSaveResult = { ok: true; name: string } | { ok: false; error: string }

export function isAlertSoundKind(v: unknown): v is AlertSoundKind {
  return typeof v === 'string' && (ALERT_SOUND_KINDS as readonly string[]).includes(v)
}

/** The lower-cased, allow-listed extension of `name`, or null. */
export function alertSoundExtension(name: unknown): AlertSoundExtension | null {
  if (typeof name !== 'string') return null
  const m = /\.([A-Za-z0-9]+)$/.exec(name.trim())
  if (!m) return null
  const ext = m[1].toLowerCase()
  return (ALERT_SOUND_EXTENSIONS as readonly string[]).includes(ext) ? (ext as AlertSoundExtension) : null
}

/**
 * The custom sound settings hold for `kind`, or undefined. settings.json is hand-editable, so the
 * shape is checked rather than trusted — a malformed entry reads as "no custom sound" (the chime).
 */
export function customAlertSoundFor(v: unknown, kind: AlertSoundKind): CustomAlertSound | undefined {
  if (!v || typeof v !== 'object') return undefined
  const e = (v as Record<string, unknown>)[kind]
  if (!e || typeof e !== 'object') return undefined
  const { name, stamp } = e as Record<string, unknown>
  if (typeof name !== 'string' || typeof stamp !== 'number' || !Number.isFinite(stamp)) return undefined
  return { name, stamp }
}
