/**
 * Which recording in a folder belongs to a moment — the rule behind the locked
 * recordings folder (`recording-folder.ts`).
 *
 * A recording's filename says when it STARTED (OBS: `YYYY-MM-DD HH-MM-SS`,
 * read by `parseObsFilenameStartMs`), never how long it ran. So a name can only
 * NOMINATE a clip: the latest one that began at or before the moment. Whether
 * it actually runs that far is known once the file is open — callers confirm
 * with `clipCovers` and, when it doesn't, say so. They never reach for some
 * other file instead: the wrong day's video analysed as today's is the failure
 * this whole rule exists to prevent.
 *
 * Pure (names and numbers in, a choice out), so it is testable without a
 * browser: `npx tsx scripts/test-recording-match.ts`.
 */

export interface TimedClip {
  name: string
  /** Recording start (ms epoch), from the filename. */
  startMs: number
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv)$/i
export const isRecordingName = (name: string): boolean => VIDEO_EXT.test(name)

/** No single recording is assumed to run longer than this, so last week's clip
 *  is never nominated for today's trade. A full Globex-through-RTH capture
 *  (15:00 PT to 13:00 PT) is 22 hours. */
export const MAX_CLIP_SPAN_MS = 24 * 3600_000

/** `.mkv` is OBS's default container and browsers can't decode it; the remuxed
 *  `.mp4` sits beside it under the same timestamp. */
const undecodable = (name: string): boolean => /\.mkv$/i.test(name)

/** The clip that could hold `ms`: the latest start at or before it. Two files
 *  with the same start are a recording and its remux — take the one a browser
 *  can open. Null when nothing started in the day before that moment. */
export function clipForInstant<T extends TimedClip>(clips: readonly T[], ms: number): T | null {
  let best: T | null = null
  for (const c of clips) {
    if (c.startMs > ms || ms - c.startMs > MAX_CLIP_SPAN_MS) continue
    if (
      !best || c.startMs > best.startMs ||
      (c.startMs === best.startMs && undecodable(best.name) && !undecodable(c.name))
    ) best = c
  }
  return best
}

/** Does a loaded clip (start + real duration) actually run through `ms`? */
export function clipCovers(startMs: number, durationSec: number, ms: number): boolean {
  return Number.isFinite(ms) && ms >= startMs && ms <= startMs + durationSec * 1000
}

export interface SessionCandidate<T> {
  clip: T
  /** How many of the session's trades this clip was nominated for. */
  trades: number
}

/** The recordings a session's trades point at, most trades first (earlier clip
 *  on a tie). One entry on a normal day; more when the recorder was restarted
 *  mid-session. Empty when no clip could hold any of the trades. */
export function clipsForSession<T extends TimedClip>(
  clips: readonly T[], entryMs: readonly number[],
): SessionCandidate<T>[] {
  const tally = new Map<T, number>()
  for (const ms of entryMs) {
    const c = clipForInstant(clips, ms)
    if (c) tally.set(c, (tally.get(c) ?? 0) + 1)
  }
  return [...tally]
    .map(([clip, trades]) => ({ clip, trades }))
    .sort((a, b) => b.trades - a.trades || a.clip.startMs - b.clip.startMs)
}
