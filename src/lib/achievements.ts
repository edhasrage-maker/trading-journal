// Achievement / gamification engine — PURE derivation, no DB. Given a day's
// trades + P&L (+ optional history and process score), returns the badges the
// trader earned that day. Callers (EOD page, dashboard) assemble the input and
// render the result; rules whose inputs are absent simply don't fire.
//
// Single-user badges only (Sniper, Grand Slam, Game Winner, Career Day, Heat
// Check). Cross-user badges (top-3 PnL, TapeCenter) are gated on the
// benchmarking work and are NOT here — see the gamification plan.

import { avgMfeMaeAtr, type TradeWithExcursion } from '@/lib/analytics'
import { symbolToMultiplier } from '@/lib/futures-symbols'

export type AchievementId =
  | 'sniper'
  | 'grand_slam'
  | 'game_winner'
  | 'career_day'
  | 'heat_check'

export interface Achievement {
  id: AchievementId
  label: string
  emoji: string
  /** Short "why you earned it" line — tooltip + share card. */
  blurb: string
}

/** Static catalog — the single source of truth for each badge's display label,
 *  fallback emoji, and a GENERIC "what it means" blurb. `dayAchievements` pulls
 *  its label/emoji from here (then overrides the blurb with the day's live
 *  numbers); surfaces that render from PERSISTED ids (dashboard markers, the
 *  collection strip, lifetime counts) use these generic entries directly since
 *  they don't recompute the day. */
export const ACHIEVEMENT_CATALOG: Record<AchievementId, { label: string; emoji: string; blurb: string }> = {
  sniper:      { label: 'Sniper',      emoji: '🎯', blurb: 'The day averaged under 0.25×ATR of heat across every trade — surgical all session.' },
  grand_slam:  { label: 'Grand Slam',  emoji: '⚾', blurb: 'A trade of 8R or more — swung big and connected.' },
  game_winner: { label: 'Game Winner', emoji: '🏀', blurb: "Your best trade captured 80%+ of the day's range." },
  career_day:  { label: 'Career Day',  emoji: '📅', blurb: 'A top-10% P&L day across your logged sessions.' },
  heat_check:  { label: 'Heat Check',  emoji: '🔥', blurb: '5 green sessions in a row — you’re heating up.' },
}

/** Canonical display order (used by the collection strip + counts UI). */
export const ACHIEVEMENT_ORDER: AchievementId[] = [
  'sniper', 'grand_slam', 'game_winner', 'career_day', 'heat_check',
]

/** Trade shape the rules read: excursion fields + the entry-time ATR snapshot +
 *  the average exit price (for Game Winner's realized point capture). */
export type AchievementTrade = TradeWithExcursion & {
  entry_atr_1m?: number | null
  exit_price?: number | null
}

export interface AchievementInput {
  /** This day's date, YYYY-MM-DD — used to locate it within pnlHistory. */
  date: string
  /** The day's realized P&L (trading_days.eod_pnl), or null. */
  dayPnl: number | null
  /** The day's trades. */
  trades: AchievementTrade[]
  /** All the user's realized SESSION P&Ls ({date, pnl}), for Career Day
   *  (percentile) and Heat Check (green streak). Pass only days that actually
   *  traded, so consecutive entries mean consecutive sessions. Omit to skip
   *  those two badges. */
  pnlHistory?: { date: string; pnl: number }[]
  /** The session's high-low range in POINTS (market_context.day_range) — for
   *  Game Winner (best trade captured ≥80% of it). Omit to skip that badge. */
  dayRangePts?: number | null
}

// Thresholds — single source of truth so the UI copy and the rules never drift.
export const ACHIEVEMENT_THRESHOLDS = {
  // Sniper is a DAY-LEVEL average: mean adverse heat across ALL of the day's
  // trades (incl. stop-outs) must stay under this ×ATR — "surgical entries all
  // session", not just one lucky tight entry.
  sniperMaeAtr: 0.25,
  grandSlamR: 8,
  gameWinnerCapture: 0.8,
  careerDayPercentile: 0.9,
  heatCheckStreak: 5,
} as const

/** Realized R for a trade: pnl ÷ planned $ risk (|entry−stop| × qty × mult).
 *  Null when there's no stop or no known multiplier. */
function tradeR(t: AchievementTrade): number | null {
  if (t.pnl == null || t.entry_price == null || t.stop_price == null || t.quantity == null) return null
  const mult = symbolToMultiplier(t.symbol ?? '')
  if (mult === 0) return null
  const riskPts = Math.abs(t.entry_price - t.stop_price)
  if (riskPts === 0) return null
  const risk = riskPts * t.quantity * mult
  if (risk <= 0) return null
  return t.pnl / risk
}

/** The badges earned on a single day. Order = display order. */
export function dayAchievements(input: AchievementInput): Achievement[] {
  const { date, dayPnl, trades, pnlHistory, dayRangePts } = input
  const T = ACHIEVEMENT_THRESHOLDS
  const earned: Achievement[] = []
  const green = (dayPnl ?? 0) > 0

  // 🎯 Sniper — the day's AVERAGE adverse heat across ALL trades (winners and
  // stop-outs alike) stayed under 0.25×ATR: every entry was surgical, not just
  // one. avgMfeMaeAtr uses each trade's stored entry_atr_1m (same basis the
  // persisted result + backfill compute on, so the coin never drifts between the
  // EOD recap and the dashboard) and only averages trades with a computable
  // excursion+ATR. Needs at least one such trade.
  const heat = avgMfeMaeAtr(trades)
  if (heat.mae != null && heat.count > 0 && heat.mae < T.sniperMaeAtr) {
    earned.push({
      id: 'sniper', ...ACHIEVEMENT_CATALOG.sniper,
      blurb: `Averaged ${heat.mae.toFixed(2)}×ATR of heat across ${heat.count} ${heat.count === 1 ? 'trade' : 'trades'} — surgical all day.`,
    })
  }

  // 🚀 Grand Slam — a trade of 8R or more (needs a logged stop).
  const bestR = trades.reduce<number | null>((m, t) => {
    const r = tradeR(t)
    return r == null ? m : m == null || r > m ? r : m
  }, null)
  if (bestR != null && bestR >= T.grandSlamR) {
    earned.push({
      id: 'grand_slam', ...ACHIEVEMENT_CATALOG.grand_slam,
      blurb: `A ${bestR.toFixed(1)}R trade — swung big and connected.`,
    })
  }

  // 🏀 Game Winner — your single best trade captured ≥80% of the day's high-low
  // range (points). Size-independent: "one shot that caught the whole move."
  // Realized capture = direction-signed (exit − entry) for each trade; we take
  // the biggest, so a red day with one monster winner can still qualify.
  if (dayRangePts != null && dayRangePts > 0) {
    const bestCapturePts = trades.reduce((m, t) => {
      if (t.entry_price == null || t.exit_price == null) return m
      const pts = t.direction === 'short' ? t.entry_price - t.exit_price : t.exit_price - t.entry_price
      return pts > m ? pts : m
    }, 0)
    const ratio = bestCapturePts / dayRangePts
    // A single trade CANNOT capture more than the full session range. A ratio
    // materially over 100% means dayRangePts and the trade are in different
    // instruments/units (a day can carry a per-symbol market_context — e.g. an
    // ES-scale 19.5-pt range measured against an NQ trade's ~130-pt range) or
    // span different sessions, so the comparison is invalid — do NOT award.
    // The small epsilon tolerates a genuine full-range capture nicked by
    // rounding; the displayed % clamps to 100 so the copy is never impossible.
    const GW_MAX_RATIO = 1.02
    if (ratio >= T.gameWinnerCapture && ratio <= GW_MAX_RATIO) {
      const pct = Math.min(Math.round(ratio * 100), 100)
      earned.push({
        id: 'game_winner', ...ACHIEVEMENT_CATALOG.game_winner,
        blurb: `Your best trade caught ${pct}% of the day's ${Math.round(dayRangePts)}-pt range.`,
      })
    }
  }

  // 📅 Career Day — a top-10%-ever P&L day (needs ≥10 logged sessions).
  if (green && dayPnl != null && pnlHistory && pnlHistory.length >= 10) {
    const pnls = pnlHistory.map(d => d.pnl).sort((a, b) => a - b)
    const idx = Math.max(0, Math.min(pnls.length - 1, Math.ceil(T.careerDayPercentile * pnls.length) - 1))
    if (dayPnl >= pnls[idx]) {
      earned.push({
        id: 'career_day', ...ACHIEVEMENT_CATALOG.career_day,
        blurb: `Top 10% P&L day across your ${pnls.length} logged sessions.`,
      })
    }
  }

  // 🔥 Heat Check — 5 green sessions in a row, ending on this day.
  if (green && pnlHistory && pnlHistory.length >= T.heatCheckStreak) {
    const ordered = [...pnlHistory].sort((a, b) => a.date.localeCompare(b.date))
    const iToday = ordered.findIndex(d => d.date === date)
    if (iToday >= T.heatCheckStreak - 1) {
      let streak = true
      for (let k = 0; k < T.heatCheckStreak; k++) {
        if ((ordered[iToday - k]?.pnl ?? 0) <= 0) { streak = false; break }
      }
      if (streak) {
        earned.push({
          id: 'heat_check', ...ACHIEVEMENT_CATALOG.heat_check,
          blurb: `${T.heatCheckStreak} green sessions in a row — you're heating up.`,
        })
      }
    }
  }

  return earned
}

/** Just the earned ids for a day — what we persist to trading_days.achievements_json. */
export function dayAchievementIds(input: AchievementInput): AchievementId[] {
  return dayAchievements(input).map(a => a.id)
}

/** Tally lifetime earns across many days' persisted id arrays. Unknown ids
 *  (e.g. a retired badge left in old rows) are ignored, so the catalog can
 *  evolve without corrupting counts. */
export function achievementCounts(
  days: (readonly string[] | null | undefined)[],
): Record<AchievementId, number> {
  const counts: Record<AchievementId, number> = {
    sniper: 0, grand_slam: 0, game_winner: 0, career_day: 0, heat_check: 0,
  }
  for (const arr of days) {
    if (!arr) continue
    for (const id of arr) {
      if (id in counts) counts[id as AchievementId]++
    }
  }
  return counts
}
