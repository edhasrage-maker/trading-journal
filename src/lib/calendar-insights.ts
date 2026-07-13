import { type TapeScoreBand } from '@/lib/tapescore'

/**
 * Calendar day + insight model (Pt 11 "Discipline Calendar" revamp). The
 * calendar is re-centered on the DECISION grade (TapeScore) rather than P&L, so
 * each day carries its derived TapeScore + breach flag, and the insight cards
 * surface what only a calendar can reveal — weekday rhythm, discipline streaks,
 * and profitable-but-poorly-graded days. Pure module (no imports beyond the
 * TapeScore band type) so it's safe on the client.
 */

export interface CalendarDay {
  date: string             // YYYY-MM-DD
  pnl: number
  trade_count: number
  wins: number
  losses: number
  day_type: string | null
  day_types: string[]
  /** 0–100 TapeScore, null when the day has no EOD analysis. */
  tapescore: number | null
  band: TapeScoreBand | null
  /** Rules verdict = Breach (kept < 4 of 5 safety rails). */
  breach: boolean
}

export interface WeekdayStat { weekday: string; avg: number; n: number }

export interface CalendarInsights {
  strongestWeekday: WeekdayStat | null
  weakestWeekday: WeekdayStat | null
  /** Consecutive rule-compliant (non-breach) scored days: trailing + best run. */
  cleanStreak: { current: number; best: number }
  /** Profitable days graded < 50 — "lucky, not good". */
  greenButSloppy: { count: number; lastDate: string | null }
  totalPnl: number
  tradedDays: number
  dayWinRate: number | null   // % over traded days, null when none
  avgTapeScore: number | null
  scoredDays: number
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Local weekday index (0=Sun) for a YYYY-MM-DD string, anchored at noon so a
 *  DST/UTC shift can't roll it to the wrong day. */
function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00`).getDay()
}

export function computeCalendarInsights(days: CalendarDay[]): CalendarInsights {
  const traded = days.filter(d => d.trade_count > 0)
  const scored = days.filter(d => d.tapescore != null)

  // Weekday TapeScore averages over scored days.
  const byWd = new Map<number, number[]>()
  for (const d of scored) {
    const wd = weekdayOf(d.date)
    const arr = byWd.get(wd) ?? []
    arr.push(d.tapescore as number)
    byWd.set(wd, arr)
  }
  let strongest: WeekdayStat | null = null
  let weakest: WeekdayStat | null = null
  for (const [wd, arr] of byWd) {
    const avg = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
    const entry: WeekdayStat = { weekday: WEEKDAYS[wd], avg, n: arr.length }
    if (!strongest || avg > strongest.avg) strongest = entry
    if (!weakest || avg < weakest.avg) weakest = entry
  }
  // Need at least two distinct weekdays for a strongest/weakest contrast.
  if (byWd.size < 2) { strongest = null; weakest = null }

  // Discipline streaks over scored days in chronological order.
  const chrono = [...scored].sort((a, b) => (a.date < b.date ? -1 : 1))
  let best = 0, run = 0
  for (const d of chrono) {
    if (!d.breach) { run += 1; best = Math.max(best, run) } else { run = 0 }
  }
  let current = 0
  for (let i = chrono.length - 1; i >= 0; i--) {
    if (!chrono[i].breach) current += 1
    else break
  }

  // Green but sloppy — profitable days graded poorly.
  const sloppy = traded
    .filter(d => d.pnl > 0 && d.tapescore != null && (d.tapescore as number) < 50)
    .sort((a, b) => (a.date < b.date ? -1 : 1))

  const winDays = traded.filter(d => d.pnl > 0).length
  const lossDays = traded.filter(d => d.pnl < 0).length

  return {
    strongestWeekday: strongest,
    weakestWeekday: weakest,
    cleanStreak: { current, best },
    greenButSloppy: { count: sloppy.length, lastDate: sloppy.length ? sloppy[sloppy.length - 1].date : null },
    totalPnl: traded.reduce((s, d) => s + d.pnl, 0),
    tradedDays: traded.length,
    dayWinRate: (winDays + lossDays) > 0 ? (winDays / (winDays + lossDays)) * 100 : null,
    avgTapeScore: scored.length ? Math.round(scored.reduce((s, d) => s + (d.tapescore as number), 0) / scored.length) : null,
    scoredDays: scored.length,
  }
}
