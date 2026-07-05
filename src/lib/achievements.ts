// Achievement / gamification engine — PURE derivation, no DB. Given a day's
// trades + P&L (+ optional history and process score), returns the badges the
// trader earned that day. Callers (EOD page, dashboard) assemble the input and
// render the result; rules whose inputs are absent simply don't fire.
//
// Single-user badges only (Sniper, Grand Slam, Game Winner, Career Day, Clean
// Tape, Heat Check). Cross-user badges (top-3 PnL, TapeCenter) are gated on the
// benchmarking work and are NOT here — see the gamification plan.

import { avgCaptureRatio, mfeMaeAtr, type TradeWithExcursion } from '@/lib/analytics'
import { symbolToMultiplier } from '@/lib/futures-symbols'

export type AchievementId =
  | 'sniper'
  | 'grand_slam'
  | 'game_winner'
  | 'career_day'
  | 'clean_tape'
  | 'heat_check'

export interface Achievement {
  id: AchievementId
  label: string
  emoji: string
  /** Short "why you earned it" line — tooltip + share card. */
  blurb: string
}

/** Trade shape the rules read: excursion fields + the entry-time ATR snapshot. */
export type AchievementTrade = TradeWithExcursion & { entry_atr_1m?: number | null }

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
  /** EOD process score from eod_ai_analysis_json.process — pass count out of
   *  ruleCount. Clean Tape needs all rules to pass. Omit if not analyzed. */
  processPassCount?: number | null
  processRuleCount?: number | null
}

// Thresholds — single source of truth so the UI copy and the rules never drift.
export const ACHIEVEMENT_THRESHOLDS = {
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
  const { date, dayPnl, trades, pnlHistory, processPassCount, processRuleCount } = input
  const T = ACHIEVEMENT_THRESHOLDS
  const earned: Achievement[] = []
  const green = (dayPnl ?? 0) > 0

  // 🎯 Sniper — a WINNING trade that took under 0.25×ATR of adverse heat.
  const sniper = trades.some(t => {
    if (t.pnl == null || t.pnl <= 0) return false
    const x = mfeMaeAtr(t)
    return x != null && x.mae < T.sniperMaeAtr
  })
  if (sniper) {
    earned.push({
      id: 'sniper', emoji: '🎯', label: 'Sniper',
      blurb: `A winning trade with under ${T.sniperMaeAtr}×ATR of heat — surgical entry.`,
    })
  }

  // 🚀 Grand Slam — a trade of 8R or more (needs a logged stop).
  const bestR = trades.reduce<number | null>((m, t) => {
    const r = tradeR(t)
    return r == null ? m : m == null || r > m ? r : m
  }, null)
  if (bestR != null && bestR >= T.grandSlamR) {
    earned.push({
      id: 'grand_slam', emoji: '🚀', label: 'Grand Slam',
      blurb: `A ${bestR.toFixed(1)}R trade — swung big and connected.`,
    })
  }

  // 🏆 Game Winner — banked ≥80% of the day's available move (green days only).
  if (green) {
    const cap = avgCaptureRatio(trades).avg
    if (cap != null && cap >= T.gameWinnerCapture) {
      earned.push({
        id: 'game_winner', emoji: '🏆', label: 'Game Winner',
        blurb: `Kept ${Math.round(cap * 100)}% of the day's available move.`,
      })
    }
  }

  // 📅 Career Day — a top-10%-ever P&L day (needs ≥10 logged sessions).
  if (green && dayPnl != null && pnlHistory && pnlHistory.length >= 10) {
    const pnls = pnlHistory.map(d => d.pnl).sort((a, b) => a - b)
    const idx = Math.max(0, Math.min(pnls.length - 1, Math.ceil(T.careerDayPercentile * pnls.length) - 1))
    if (dayPnl >= pnls[idx]) {
      earned.push({
        id: 'career_day', emoji: '📅', label: 'Career Day',
        blurb: `Top 10% P&L day across your ${pnls.length} logged sessions.`,
      })
    }
  }

  // 🎞️ Clean Tape — a process-compliant day, zero breaches (all rules pass).
  if (
    trades.length > 0 &&
    processPassCount != null && processRuleCount != null &&
    processRuleCount > 0 && processPassCount >= processRuleCount
  ) {
    earned.push({
      id: 'clean_tape', emoji: '🎞️', label: 'Clean Tape',
      blurb: 'Every process rule respected — zero breaches.',
    })
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
          id: 'heat_check', emoji: '🔥', label: 'Heat Check',
          blurb: `${T.heatCheckStreak} green sessions in a row — you're heating up.`,
        })
      }
    }
  }

  return earned
}
