import { symbolToMultiplier } from '@/lib/futures-symbols'
import { mfeMaePoints, type TradeWithExcursion } from '@/lib/analytics'
import type { TradeTags } from '@/lib/supabase/types'

/**
 * The trader's own historical baselines, as a prompt block.
 *
 * The EOD analysis used to have no idea how a tag has PERFORMED over the
 * trader's book, so the only thing it could say about "Revenge Trading" was
 * that the trader had tagged it — which the trader already knew, and which is
 * why the output read as a restatement of its own input.
 *
 * With these numbers it can say the thing the trader can't know offhand:
 * revenge is 44 trades at −0.24R and −$1,827 lifetime. That's the difference
 * between a session recap and a coach.
 *
 * Everything here is computed from the same fields the rest of the app uses,
 * so a number quoted in the analysis matches what the trade table shows.
 */

/** Buckets below this many trades are dropped — a two-trade "pattern" isn't one. */
const MIN_TAG_N = 8

/** Heat bands, as a share of the distance from entry to stop. */
const HEAT_BANDS: Array<{ label: string; lo: number; hi: number }> = [
  { label: 'under 10% of the stop', lo: 0, hi: 0.10 },
  { label: '10-50% of the stop', lo: 0.10, hi: 0.50 },
  { label: '50-99% of the stop', lo: 0.50, hi: 0.99 },
]

export interface BaselineRow {
  label: string
  n: number
  avgR: number
  winPct: number
  netUsd: number
}

export interface TraderBaselines {
  overall: BaselineRow | null
  mistakes: BaselineRow[]
  emotions: BaselineRow[]
  heat: BaselineRow[]
  /** Trades finishing with no mistake tag at all — the natural control group. */
  clean: BaselineRow | null
  /** Targets: how often a trade got most of the way to TP1 and still missed. */
  nearMiss: { reached: number; missed: number; total: number } | null
}

type BaselineTrade = TradeWithExcursion & {
  stop_price?: number | null
  tp1_price?: number | null
  exit_price?: number | null
}

interface Scored {
  r: number
  won: boolean
  pnl: number
  heat: number | null
  mistakes: string[]
  emotions: string[]
}

function labelsOf(tags: unknown, key: keyof TradeTags): string[] {
  const t = tags as TradeTags | null
  const arr = t ? t[key] : undefined
  return Array.isArray(arr) ? arr.map(String).map(s => s.trim()).filter(Boolean) : []
}

function summarize(label: string, rows: Scored[]): BaselineRow | null {
  if (rows.length === 0) return null
  const avgR = rows.reduce((a, x) => a + x.r, 0) / rows.length
  return {
    label,
    n: rows.length,
    avgR: Math.round(avgR * 100) / 100,
    winPct: Math.round((rows.filter(x => x.won).length / rows.length) * 100),
    netUsd: Math.round(rows.reduce((a, x) => a + x.pnl, 0)),
  }
}

export function computeTraderBaselines(trades: BaselineTrade[]): TraderBaselines {
  const scored: Scored[] = []
  let reached = 0, missed = 0, withTarget = 0

  for (const t of trades) {
    if (t.entry_price == null || t.stop_price == null || t.pnl == null || !t.quantity || t.direction == null) continue
    const riskPts = Math.abs(t.entry_price - t.stop_price)
    if (riskPts === 0) continue
    const riskUsd = riskPts * t.quantity * symbolToMultiplier(t.symbol ?? '')
    if (riskUsd === 0) continue

    const xc = mfeMaePoints(t)
    scored.push({
      r: t.pnl / riskUsd,
      won: t.pnl > 0,
      pnl: t.pnl,
      heat: xc ? xc.mae / riskPts : null,
      mistakes: labelsOf(t.tags_json, 'mistakes'),
      emotions: labelsOf(t.tags_json, 'emotions'),
    })

    // Near-miss on the planned target: how far the favorable excursion got
    // toward TP1 versus whether it actually filled.
    if (t.tp1_price != null && xc) {
      const tpDist = Math.abs(t.tp1_price - t.entry_price)
      if (tpDist > 0) {
        withTarget++
        const share = xc.mfe / tpDist
        if (share >= 1) reached++
        else if (share >= 0.85) missed++
      }
    }
  }

  const byLabel = (key: 'mistakes' | 'emotions'): BaselineRow[] => {
    const groups = new Map<string, Scored[]>()
    for (const s of scored) {
      for (const label of s[key]) {
        const arr = groups.get(label) ?? []
        arr.push(s)
        groups.set(label, arr)
      }
    }
    return Array.from(groups.entries())
      .map(([label, rows]) => summarize(label, rows))
      .filter((r): r is BaselineRow => r != null && r.n >= MIN_TAG_N)
      // Most extreme first — the analysis should reach for the biggest effect.
      .sort((a, b) => Math.abs(b.avgR) - Math.abs(a.avgR))
  }

  return {
    overall: summarize('all trades with a stop set', scored),
    mistakes: byLabel('mistakes'),
    emotions: byLabel('emotions'),
    heat: HEAT_BANDS
      .map(b => summarize(b.label, scored.filter(s => s.heat != null && s.heat >= b.lo && s.heat < b.hi)))
      .filter((r): r is BaselineRow => r != null && r.n >= MIN_TAG_N),
    clean: summarize('no mistake tag at all', scored.filter(s => s.mistakes.length === 0)),
    nearMiss: withTarget > 0 ? { reached, missed, total: withTarget } : null,
  }
}

const fmtRow = (r: BaselineRow) =>
  `  ${r.label}: n=${r.n}, avg ${r.avgR >= 0 ? '+' : ''}${r.avgR.toFixed(2)}R, win ${r.winPct}%, net ${r.netUsd >= 0 ? '+' : '-'}$${Math.abs(r.netUsd).toLocaleString()}`

/**
 * Render the baselines for the prompt. Returns '' when there isn't enough
 * history to say anything — the analysis then simply has no baselines to cite,
 * which is correct rather than inventing them.
 */
export function baselinesPromptBlock(b: TraderBaselines): string {
  if (!b.overall || b.overall.n < 20) return ''
  const lines: string[] = [
    '══ THIS TRADER\'S OWN BASELINES (computed from their book — USE THESE) ══',
    'These are facts the trader does NOT know offhand. A line that cites one of these',
    'is worth writing; a line that repeats a tag they set is not. Never invent a number',
    'that is not here or in the trade data above.',
    '',
    'Overall:',
    fmtRow(b.overall),
  ]
  if (b.clean && b.clean.n >= MIN_TAG_N) {
    lines.push('', 'Control group:', fmtRow(b.clean))
  }
  if (b.heat.length > 0) {
    lines.push('', 'By how close the trade came to the stop (max adverse excursion / planned risk):', ...b.heat.map(fmtRow))
  }
  if (b.mistakes.length > 0) {
    lines.push('', 'By mistake tag (lifetime, most extreme first):', ...b.mistakes.slice(0, 8).map(fmtRow))
  }
  if (b.emotions.length > 0) {
    lines.push('', 'By emotion tag (lifetime, most extreme first):', ...b.emotions.slice(0, 6).map(fmtRow))
  }
  if (b.nearMiss && b.nearMiss.total >= 20) {
    lines.push(
      '',
      'Planned targets:',
      `  ${b.nearMiss.total} trades had a TP1 set — ${b.nearMiss.reached} reached it, ${b.nearMiss.missed} got 85-99% of the way and missed.`,
    )
  }
  return lines.join('\n')
}
