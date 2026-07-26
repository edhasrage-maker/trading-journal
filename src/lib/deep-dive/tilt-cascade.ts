// Deep dive: the TILT CASCADE. After a run of consecutive losses in a session,
// does the trader's win rate collapse and/or size jump? Quantifies the
// revenge-trading leak and proposes a concrete cooldown rule with its $ value.
//
// PURE + unit-tested. The registry gathers the trades; this only analyzes.

import { type DeepDiveResult, type DiveSegment, type Investigation, fmtUsd, fmtPct } from './types'

export interface TiltTrade {
  /** Session date (yyyy-mm-dd) — streaks reset each day. */
  day: string
  /** Sort key within the day (ISO entry time). */
  entryTime: string
  pnl: number | null
  quantity: number | null
}

interface Bucket { n: number; wins: number; pnl: number; qty: number; qtyN: number }
const empty = (): Bucket => ({ n: 0, wins: 0, pnl: 0, qty: 0, qtyN: 0 })
const wr = (b: Bucket) => (b.n ? (b.wins / b.n) * 100 : 0)
const avgQty = (b: Bucket) => (b.qtyN ? b.qty / b.qtyN : 0)

/**
 * Bucket every trade by the number of CONSECUTIVE losses immediately before it
 * in the same session (0, 1, 2+). A cascade shows up as win rate falling and/or
 * size rising across the buckets, plus a net-negative "tilt zone" (streak ≥ 2).
 */
export function analyzeTiltCascade(trades: TiltTrade[]): DeepDiveResult | null {
  const scored = trades.filter(t => t.pnl != null)
  if (scored.length < 40) return null   // need enough trades for streak stats

  // Group by day, order within day, walk tracking the pre-trade loss streak.
  const byDay = new Map<string, TiltTrade[]>()
  for (const t of scored) {
    const arr = byDay.get(t.day) ?? []; arr.push(t); byDay.set(t.day, arr)
  }
  const b0 = empty(), b1 = empty(), b2 = empty()   // streak 0 / 1 / 2+
  const add = (b: Bucket, t: TiltTrade) => {
    b.n++; if ((t.pnl ?? 0) > 0) b.wins++; b.pnl += t.pnl ?? 0
    if (t.quantity != null) { b.qty += t.quantity; b.qtyN++ }
  }
  for (const [, dayTrades] of byDay) {
    dayTrades.sort((a, b) => a.entryTime.localeCompare(b.entryTime))
    let streak = 0
    for (const t of dayTrades) {
      ;(streak === 0 ? add(b0, t) : streak === 1 ? add(b1, t) : add(b2, t))
      streak = (t.pnl ?? 0) < 0 ? streak + 1 : 0   // reset on a win/scratch
    }
  }
  if (b2.n < 8) return null   // not enough post-2-loss trades to call it

  const baseWr = wr(b0), tiltWr = wr(b2)
  const wrDrop = baseWr - tiltWr
  const baseQty = avgQty(b0), tiltQty = avgQty(b2)
  const sizeJump = baseQty > 0 ? (tiltQty - baseQty) / baseQty : 0   // fractional
  const tiltZonePnl = b2.pnl   // net $ on trades taken while on a ≥2 streak

  // Only surface when there's a real cascade: WR meaningfully lower AND the tilt
  // zone bled money. (A trader who's FINE after losses shouldn't be nagged.)
  if (!(wrDrop >= 8 && tiltZonePnl < 0)) return null

  const segs: DiveSegment[] = [
    { label: 'Fresh (0 losses)', value: baseWr, n: b0.n, pnl: b0.pnl, extra: { avgSize: +baseQty.toFixed(1) } },
    { label: 'After 1 loss', value: wr(b1), n: b1.n, pnl: b1.pnl, extra: { avgSize: +avgQty(b1).toFixed(1) } },
    { label: 'After 2+ losses', value: tiltWr, n: b2.n, pnl: b2.pnl, extra: { avgSize: +tiltQty.toFixed(1) } },
  ]

  const detail = [
    `Fresh: ${fmtPct(baseWr)} win rate over ${b0.n} trades (${fmtUsd(b0.pnl)}).`,
    `After 2+ consecutive losses: ${fmtPct(tiltWr)} win rate over ${b2.n} trades (${fmtUsd(b2.pnl)}) — a ${Math.round(wrDrop)}-point drop.`,
    sizeJump >= 0.15
      ? `And you SIZE UP when tilted: ${avgQty(b0).toFixed(1)} → ${tiltQty.toFixed(1)} avg contracts (+${Math.round(sizeJump * 100)}%) — bigger bets on your worst edge.`
      : `Size stays roughly flat (${avgQty(b0).toFixed(1)} → ${tiltQty.toFixed(1)}), so it's the read that breaks down, not the sizing.`,
  ]

  const reframe = sizeJump >= 0.15
    ? `The losses aren't the problem — the REACTION is. You bet more after your read has already been wrong twice, turning a normal losing streak into the day's biggest damage.`
    : `A losing streak flips you from a ${fmtPct(baseWr)} trader to a ${fmtPct(tiltWr)} one — you're a different, worse trader for the rest of that session.`

  return {
    id: 'tilt-cascade',
    title: 'The tilt cascade',
    headline: `After 2 losses your win rate falls ${fmtPct(baseWr)}→${fmtPct(tiltWr)} and that zone bled ${fmtUsd(tiltZonePnl)}.`,
    // Severity blends the WR drop and the dollar bleed (normalized).
    severity: Math.min(1, (wrDrop / 30) * 0.5 + Math.min(1, Math.abs(tiltZonePnl) / 3000) * 0.5),
    segments: segs,
    detail,
    reframe,
    test: {
      rule: 'Stop trading after 2 consecutive losses in a session',
      impactUsd: -tiltZonePnl,   // skipping a net-negative zone recovers its loss
      basis: `net P&L of the ${b2.n} trades you took while on a ≥2-loss streak, which you'd have skipped`,
    },
  }
}

export const tiltCascadeInvestigation: Investigation<TiltTrade[]> = {
  id: 'tilt-cascade',
  title: 'The tilt cascade',
  // Cold-start: raw fills only (P&L + time + size). Works day-one on a broker
  // CSV with zero tags, any instrument.
  requires: ['fills'],
  keywords: ['tilt', 'revenge', 'after a loss', 'losing streak', 'consecutive losses', 'chasing'],
  run: analyzeTiltCascade,
}
