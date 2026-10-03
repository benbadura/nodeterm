/**
 * GEMINI CLI NO LONGER SERVES PERSONAL GOOGLE ACCOUNTS — say so on the node.
 *
 * Google moved the terminal experience from Gemini CLI to Antigravity CLI (`agy`) on 2026-06-18
 * (google-gemini/gemini-cli discussion #27274). Since then Gemini CLI refuses requests from the
 * free tier and from Google AI Pro / AI Ultra accounts; Gemini Code Assist Standard/Enterprise
 * licences, Vertex AI and paid API keys are unaffected. What a refused user sees in the pane is a
 * browser page saying "Authentication succeeded", then the CLI's own sign-in screen again with:
 *
 *     Failed to sign in. Message: This client is no longer supported for Gemini Code Assist for
 *     individuals. To continue using Gemini, please migrate to the Antigravity suite of products:
 *     https://antigravity.google
 *
 * (captured from a user's screen, 2026-09-28). The loop reads like a nodeterm auth bug, and
 * reinstalling the CLI or deleting `~/.gemini` does not help. There is no hook to learn it from:
 * the refusal happens BEFORE a session exists, so no SessionStart ever fires — which is why this
 * reads the pane, the same way `resume-fallback.ts` does for a CLI's "no such conversation" line.
 *
 * It only ever RAISES A BANNER. Nothing is typed into the pane and nothing is relaunched, so the
 * cost of a false positive (someone printing this sentence in a gemini pane) is one dismissible
 * strip of text — which is why a plain phrase match is enough here, where the resume fallback
 * needs its three refusals.
 */

/** The part of the refusal that names the cause. Stable across the CLI versions that print it. */
export const GEMINI_RETIRED_PHRASE = 'no longer supported for Gemini Code Assist for individuals'

/** Google's own migration guide, opened by the banner's second button. */
export const GEMINI_MIGRATION_URL = 'https://antigravity.google/docs/cli/gcli-migration'

/**
 * How much recent pane text the watcher keeps. The refusal is ~200 characters; this is enough for
 * it plus the box border and padding the TUI draws around every wrapped line of it, and bounded so
 * a chatty pane cannot grow the buffer without limit.
 */
export const GEMINI_RETIRED_TAIL_CHARS = 4096

/**
 * Letters and digits only, lowercased. Gemini's TUI wraps the message inside a bordered box, so
 * between two words of the phrase the stream can hold padding, a `│` border, a line break and the
 * next row's border — none of which an escape-stripped `includes` survives. Comparing the squashed
 * forms makes the match independent of where the pane width happened to wrap it.
 */
function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

const NEEDLE = squash(GEMINI_RETIRED_PHRASE)

/**
 * Should this node watch for the refusal? Takes the CAPABILITY agent id (`capabilityAgentId`), so a
 * custom agent built on the gemini harness is watched too, and nothing else is.
 */
export function watchesGeminiRetirement(capabilityAgent: string | undefined): boolean {
  return capabilityAgent === 'gemini'
}

/** Does this pane text (escape sequences already removed) contain Gemini's retirement refusal? */
export function geminiRetiredIn(text: string): boolean {
  return squash(text).includes(NEEDLE)
}
