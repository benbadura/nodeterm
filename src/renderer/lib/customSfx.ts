// Custom alert sounds (issue #289), renderer half: WHICH sound an alert plays, and the guarantee
// that choosing one can never cost the user the alert — or break the agent-status path that fires
// it. Pure over injected deps (no WebAudio, no IPC) so the fallback rules are unit-tested; sfx.ts
// wires the real ones.
//
// Rules:
//   • No custom sound for the kind (or a malformed settings entry) ⇒ the built-in chime, played
//     synchronously exactly as before this feature.
//   • A custom sound is loaded by KIND from the core (never by path), decoded once per `stamp`,
//     and played at the user's volume. Anything that goes wrong — missing file, a read the bridge
//     refuses, a decode error, a playback error — answers `false`, and the caller plays the chime.
//   • Only the playable head of a decoded sound is cached (`trim`): a 5 MB compressed file can
//     decode to hundreds of MB of float32 PCM, and playback is cut at 10 s anyway.
//   • A READ failure (no file, refused/dropped read) is NOT cached: the next alert retries, so a
//     transiently dropped Server Edition socket does not pin the chime for the rest of the run.
//     A DECODE failure IS cached for that stamp: the bytes will not decode any better next time,
//     and re-reading them per alert is a multi-MB transfer (a WS payload on the Server Edition)
//     plus a full decode, every time. A new pick has a new stamp and is tried afresh.
//     A missing or closed AudioContext is NOT a decode failure — the deps throw `TransientSfxError`
//     for it, and it is retried like a read failure (else the first alert before a context exists
//     would pin the chime until the user picks the file again).
//   • Nothing here throws into the caller, synchronously or as an unhandled rejection.

import { customAlertSoundFor, type AlertSoundKind } from '@shared/alert-sound'

/** Thrown by `decode`/`trim` for a condition that says nothing about the FILE (no or a closed
 *  audio context). Retried on the next alert, never negative-cached. */
export class TransientSfxError extends Error {}

export interface CustomSfxDeps<B> {
  /** The stored sound's bytes (base64), or null when there is none. May reject. */
  read(kind: AlertSoundKind): Promise<string | null>
  /** Decode base64 audio into something `play` accepts. Rejects on a corrupt file. */
  decode(dataBase64: string): Promise<B>
  /** Start playback at `gain` (0..1, the user's volume). May throw. */
  play(buf: B, gain: number): void
  /** Reduce a decoded buffer to what is kept (the playable head). Absent = keep as decoded.
   *  A throw counts as a decode failure. */
  trim?(buf: B): B
}

export interface CustomSfxPlayer {
  /** Play the custom sound for `kind` at `stamp`. True when it started; false on ANY failure. */
  play(kind: AlertSoundKind, stamp: number, gain: number): Promise<boolean>
  /** Load + decode without playing (the Settings check after a pick). True when it decodes. */
  preload(kind: AlertSoundKind, stamp: number): Promise<boolean>
}

export function createCustomSfxPlayer<B>(deps: CustomSfxDeps<B>): CustomSfxPlayer {
  const cache = new Map<AlertSoundKind, { stamp: number; buf: Promise<B | null> }>()

  const load = (kind: AlertSoundKind, stamp: number): Promise<B | null> => {
    const hit = cache.get(kind)
    if (hit && hit.stamp === stamp) return hit.buf
    let transient = false
    const buf = (async (): Promise<B | null> => {
      let b64: string | null
      try {
        b64 = await deps.read(kind)
      } catch {
        b64 = null
      }
      if (!b64) {
        transient = true
        return null
      }
      try {
        const decoded = await deps.decode(b64)
        return deps.trim ? deps.trim(decoded) : decoded
      } catch (e) {
        if (e instanceof TransientSfxError) transient = true
        return null // otherwise a real decode failure: stays cached for this stamp
      }
    })()
    const entry = { stamp, buf }
    cache.set(kind, entry)
    // A read failure is forgotten so the next alert asks again; success and decode failure stay.
    void buf.then(() => {
      if (transient && cache.get(kind) === entry) cache.delete(kind)
    })
    return buf
  }

  return {
    async play(kind, stamp, gain) {
      const buf = await load(kind, stamp)
      if (buf === null) return false
      try {
        deps.play(buf, gain)
        return true
      } catch {
        return false
      }
    },
    async preload(kind, stamp) {
      return (await load(kind, stamp)) !== null
    }
  }
}

export interface PlayAlertDeps {
  /** The built-in synthesized chime. */
  chime(kind: AlertSoundKind, volume: number): void
  custom: CustomSfxPlayer
}

const safeChime = (deps: PlayAlertDeps, kind: AlertSoundKind, volume: number): void => {
  try {
    deps.chime(kind, volume)
  } catch {
    // Losing a chirp is never worth surfacing.
  }
}

/**
 * Play the alert for `kind`: the user's custom sound when one is set and loads, else the built-in
 * chime. `custom` is `settings.customAlertSounds` as read (validated here, not trusted). Never
 * throws and never blocks.
 */
export function playAlert(
  kind: AlertSoundKind,
  volume: number,
  custom: unknown,
  deps: PlayAlertDeps
): void {
  const vol = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0
  if (vol <= 0) return
  const ref = customAlertSoundFor(custom, kind)
  if (!ref) {
    safeChime(deps, kind, vol)
    return
  }
  let started: Promise<boolean>
  try {
    started = deps.custom.play(kind, ref.stamp, vol)
  } catch {
    started = Promise.resolve(false)
  }
  void started.then(
    (ok) => {
      if (!ok) safeChime(deps, kind, vol)
    },
    () => safeChime(deps, kind, vol)
  )
}
