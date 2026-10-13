/**
 * Tests for picking a session's recording out of a locked folder
 * (src/lib/recording-match.ts).
 *   npx tsx scripts/test-recording-match.ts
 *
 * The real case: the Trade tab offered "Re-open <last clip>" whatever day the
 * trade was from, so yesterday's video could be read as today's. The rule under
 * test only ever nominates a clip that started before the trade, and callers
 * confirm it runs that far before using it.
 */
import { parseObsFilenameStartMs } from '../src/lib/browser-frames.ts'
import {
  clipForInstant, clipCovers, clipsForSession, isRecordingName, MAX_CLIP_SPAN_MS,
} from '../src/lib/recording-match.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// Filenames and trade times are both built in the machine's local zone, the
// way OBS names a file and the way the filename parser reads it back.
const clip = (name: string) => ({ name, startMs: parseObsFilenameStartMs(name)! })
const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).getTime()

const MON = clip('2026-10-12 06-20-00.mp4')
const TUE = clip('2026-10-13 06-25-00.mp4')
const TUE_LATE = clip('2026-10-13 10-02-11.mp4')
const folder = [TUE_LATE, MON, TUE]

console.log('A TRADE GETS THE RECORDING THAT WAS RUNNING')
check('Tuesday 06:42 → Tuesday\'s recording', clipForInstant(folder, at(2026, 10, 13, 6, 42))?.name === TUE.name)
check('Tuesday 10:30 → the restart, not the morning clip', clipForInstant(folder, at(2026, 10, 13, 10, 30))?.name === TUE_LATE.name)
check('Monday 09:00 → Monday\'s recording', clipForInstant(folder, at(2026, 10, 12, 9, 0))?.name === MON.name)
check('the instant the recording starts counts', clipForInstant(folder, TUE.startMs)?.name === TUE.name)

console.log('\nNOTHING IS NOMINATED WHEN NOTHING WAS RUNNING')
check('a trade before the first recording of the folder', clipForInstant(folder, at(2026, 10, 12, 6, 0)) === null)
check('a trade a week later is not handed last week\'s clip', clipForInstant(folder, at(2026, 10, 20, 7, 0)) === null)
check('just past the span cap', clipForInstant([MON], MON.startMs + MAX_CLIP_SPAN_MS + 1) === null)
check('an empty folder', clipForInstant([], at(2026, 10, 13, 7, 0)) === null)

console.log('\nA NOMINATION IS NOT COVERAGE — THE DURATION DECIDES')
// Wednesday 07:00 with no Wednesday recording nominates Tuesday's restart
// (latest start before it). It ran 3h, so it had ended; the caller must say so.
const wed = at(2026, 10, 14, 7, 0)
check('the nearest earlier clip is nominated', clipForInstant(folder, wed)?.name === TUE_LATE.name)
check('…and fails the coverage check', !clipCovers(TUE_LATE.startMs, 3 * 3600, wed))
check('a trade inside the clip passes', clipCovers(TUE.startMs, 7 * 3600, at(2026, 10, 13, 12, 59)))
check('a trade after the clip ended fails', !clipCovers(TUE.startMs, 3600, at(2026, 10, 13, 8, 0)))
check('a trade before the clip started fails', !clipCovers(TUE.startMs, 3600, TUE.startMs - 1))
check('an unparseable time never passes', !clipCovers(TUE.startMs, 3600, NaN))

console.log('\nA RECORDING AND ITS REMUX')
const MKV = clip('2026-10-13 06-25-00.mkv')
check('the .mp4 wins over the .mkv it was made from', clipForInstant([MKV, TUE], at(2026, 10, 13, 7, 0))?.name === TUE.name)
check('…in either listing order', clipForInstant([TUE, MKV], at(2026, 10, 13, 7, 0))?.name === TUE.name)
check('a lone .mkv is still nominated (so the remux recipe can be shown)', clipForInstant([MKV], at(2026, 10, 13, 7, 0))?.name === MKV.name)

console.log('\nA WHOLE SESSION')
const day = [at(2026, 10, 13, 6, 42), at(2026, 10, 13, 7, 15), at(2026, 10, 13, 8, 1), at(2026, 10, 13, 10, 30)]
const ranked = clipsForSession(folder, day)
check('both of the day\'s recordings are offered', ranked.length === 2, String(ranked.length))
check('the one holding more trades comes first', ranked[0]?.clip.name === TUE.name && ranked[0]?.trades === 3)
check('the restart is second, with its one trade', ranked[1]?.clip.name === TUE_LATE.name && ranked[1]?.trades === 1)
check('yesterday\'s recording is not offered for today', !ranked.some(r => r.clip.name === MON.name))
check('a day with no recording offers nothing', clipsForSession([MON], [at(2026, 10, 20, 7, 0)]).length === 0)
check('a day with no trades offers nothing', clipsForSession(folder, []).length === 0)
const tie = clipsForSession(folder, [at(2026, 10, 13, 6, 42), at(2026, 10, 13, 10, 30)])
check('a tie goes to the earlier recording', tie[0]?.clip.name === TUE.name)

console.log('\nWHAT COUNTS AS A RECORDING')
check('mp4 / mkv / mov / webm / m4v', ['a.mp4', 'a.MKV', 'a.mov', 'a.webm', 'a.m4v'].every(isRecordingName))
check('not a log or a screenshot', !['TradeActivityLog_2026-10-13.txt', 'chart.png', 'mp4'].some(isRecordingName))

console.log(failures === 0 ? '\nAll recording-match tests pass.' : `\n${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
